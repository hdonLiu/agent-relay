// macOS opt-in: node scripts/smoke-codex.js [absolute-path-to-codex]
// Exercises the installed Codex and relay MCP with a loopback Responses fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { getAdapterType } from '../client/adapters/index.js';
import { CodexAdapter } from '../client/adapters/codex/index.js';
import { AppServerProxy } from '../client/adapters/codex/proxy.js';

if (process.platform !== 'darwin')
  throw new Error('This offline smoke test requires the macOS sandbox-exec utility.');
const binary = getAdapterType('codex').resolveBinary(process.argv[2]);
const root = await mkdtemp('/tmp/agent-relay-smoke-');
const project = join(root, 'project');
const socket = join(root, 'codex.sock');
const env = {
  HOME: join(root, 'home'),
  CODEX_HOME: join(root, 'config'),
  TMPDIR: join(root, 'tmp'),
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'en_US.UTF-8',
  RELAY_FIXTURE_KEY: 'local-placeholder',
};
const profile = `(version 1)(allow default)(deny file-read* file-write* (subpath ${JSON.stringify(homedir())}))(allow file-read* (literal ${JSON.stringify(binary)}))(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))`;
const launch = (args, stdio) =>
  spawn('/usr/bin/sandbox-exec', ['-p', profile, binary, ...args], { cwd: project, env, stdio });
const received = [];
const ipc = http.createServer(async (req, res) => {
  let payload = '';
  for await (const chunk of req) payload += chunk;
  received.push(JSON.parse(payload));
  res.end(JSON.stringify({ content: [{ type: 'text', text: 'Reply accepted.' }] }));
});
let requests = 0;
const model = http.createServer((req, res) => {
  req.resume();
  if (req.url !== '/v1/responses') {
    res.writeHead(404).end();
    return;
  }
  requests++;
  const item =
    requests === 1
      ? {
          type: 'function_call',
          id: 'fc_fixture',
          call_id: 'call_fixture',
          namespace: 'mcp__peer',
          name: 'reply_to_peer',
          arguments: JSON.stringify({ in_reply_to: 'M1', outcome: 'answered', text: 'Fixture answer.' }),
        }
      : {
          type: 'message',
          id: 'msg_' + requests,
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Complete.' }],
        };
  const response = { id: 'resp_' + requests, status: 'completed', output: [item] };
  const events = [
    { type: 'response.created', response: { id: response.id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  res
    .writeHead(200, { 'content-type': 'text/event-stream' })
    .end(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
});
async function waitFor(check, description) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Timed out waiting for ' + description);
}
let host;
const rpc = new AppServerProxy({
  timeout: 8_000,
  start: () => launch(['app-server', 'proxy', '--sock', socket], ['pipe', 'pipe', 'ignore']),
});
const adapter = new CodexAdapter({ rpc });
try {
  await Promise.all([env.HOME, env.CODEX_HOME, env.TMPDIR, project].map((path) => mkdir(path)));
  // Stage the Node runtime and MCP outside the denied home directory.
  await copyFile(process.execPath, join(root, 'node'));
  const entry = fileURLToPath(new URL('../client/mcp/index.js', import.meta.url));
  await build({
    entryPoints: [entry],
    outfile: join(root, 'mcp.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  await writeFile(join(root, 'run.cjs'), `require('./mcp.cjs').runMcp({stateDir: __dirname});`);
  await Promise.all([
    new Promise((resolve) => ipc.listen(join(root, 'relay.sock'), resolve)),
    new Promise((resolve) => model.listen(0, '127.0.0.1', resolve)),
  ]);
  // Disable AGENTS.md discovery for this fixture because macOS prohibits nested seatbelt sandboxes.
  const launchMcp = `command = "${root}/node"\nargs = ["${root}/run.cjs"]`;
  await writeFile(
    join(env.CODEX_HOME, 'config.toml'),
    `model = "gpt-5.2"
model_provider = "fixture"
cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
[model_providers.fixture]
name = "Offline fixture"
base_url = "http://127.0.0.1:${model.address().port}/v1"
env_key = "RELAY_FIXTURE_KEY"
wire_api = "responses"
supports_websockets = false
[mcp_servers.peer]
${launchMcp}
[mcp_servers.peer.tools.reply_to_peer]
approval_mode = "approve"
[mcp_servers.unrelated]
${launchMcp}
[projects."${project}"]
trust_level = "trusted"\n`
  );
  host = launch(
    ['--no-daemon', 'app-server', '--listen', 'unix://' + socket],
    ['ignore', 'ignore', 'inherit']
  );
  await waitFor(async () => {
    if (host.exitCode !== null) throw new Error('Isolated app-server exited ' + host.exitCode);
    return stat(socket).catch(() => false);
  }, 'the isolated daemon');
  const id = await adapter.createSession({ cwd: project });
  const { data } = await rpc.call('mcpServerStatus/list', { threadId: id });
  assert.equal(data.find((s) => s.name === 'peer')?.runtimeStatus, 'connected');
  assert.equal(data.find((s) => s.name === 'unrelated')?.runtimeStatus, 'disabled');
  for (const [message_id, kind, text] of [
    ['M1', 'question', 'Ask for the fixture answer.'],
    ['M2', 'reply', 'Continue your local task.'],
  ]) {
    const frame = {
      v: 1,
      type: 'deliver',
      conversation_id: 'C1',
      message_id,
      kind,
      text,
      from_user: 'fixture',
    };
    if (kind === 'reply') Object.assign(frame, { in_reply_to: 'M1', outcome: 'answered' });
    await adapter.deliver(id, frame, { cwd: project });
    await waitFor(async () => {
      const turns = await rpc
        .call('thread/turns/list', { threadId: id, itemsView: 'full' })
        .catch(() => ({ data: [] }));
      return turns.data.some(
        (t) =>
          t.status === 'completed' &&
          t.items.some((i) => i.type === 'userMessage' && i.clientId === message_id)
      );
    }, 'completion of ' + message_id);
    assert.equal(await adapter.lookupDelivery(id, message_id), 'accepted');
  }
  assert.deepEqual(received, [
    {
      adapter: 'codex',
      native_session_id: id,
      native_call_id: 'call_fixture',
      tool: 'reply_to_peer',
      arguments: { in_reply_to: 'M1', outcome: 'answered', text: 'Fixture answer.' },
    },
  ]);
  console.log(
    'Passed: real Codex proxy, project profile, tool isolation, MCP call identity, and same-thread continuation.'
  );
} finally {
  adapter.close();
  if (host && host.exitCode === null && host.signalCode === null) {
    const exited = once(host, 'exit');
    host.kill('SIGKILL');
    await exited;
  }
  for (const listener of [model, ipc])
    if (listener.listening) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
  await rm(root, { recursive: true, force: true });
}
