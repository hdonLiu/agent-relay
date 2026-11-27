// macOS, one installed Codex, a running loopback relay, and a simulated peer.
// Run: node scripts/e2e-local.js [both|send|receive] [http://127.0.0.1:8787]
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { zstdDecompressSync, gunzipSync } from 'node:zlib';
import { getAdapterType } from '../client/adapters/index.js';
import { AppServerProxy } from '../client/adapters/codex/proxy.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { registerPeer } from './e2e-peer.js';

const [mode = 'both', origin = 'http://127.0.0.1:8787'] = process.argv.slice(2);
if (!['both', 'send', 'receive'].includes(mode) || process.platform !== 'darwin')
  throw new Error('Usage on macOS: node scripts/e2e-local.js [both|send|receive] [loopback HTTP origin]');
const endpoint = new URL(origin);
if (
  endpoint.protocol !== 'http:' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
  endpoint.origin !== origin
)
  throw new Error('Use a loopback HTTP origin.');
const health = await fetch(origin + '/health', { signal: AbortSignal.timeout(3000) });
assert.equal(health.status, 200);
const { instance_id: instanceId, status } = await health.json();
assert.equal(status, 'ok');
assert.ok(instanceId);
const run = promisify(execFile);
const binary = getAdapterType('codex').resolveBinary();
const root = await realpath(await mkdtemp('/tmp/relay-e2e-'));
const state = join(root, 'device');
const targetDir = join(root, 'isho-service');
const originDir = join(root, 'sender-project');
const hostSocket = join(root, 'codex.sock');
const clientCli = fileURLToPath(new URL('../client/index.js', import.meta.url));
const env = {
  HOME: join(root, 'home'),
  CODEX_HOME: join(root, 'config'),
  TMPDIR: join(root, 'tmp'),
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'en_US.UTF-8',
  SHELL: '/bin/sh',
  RELAY_FIXTURE_KEY: 'test-only',
  RELAY_TEST_CODEX: binary,
  RELAY_TEST_SOCKET: hostSocket,
};
const suffix = randomBytes(5).toString('hex');
const username = 'codex-' + suffix;
const mockName = 'peer-' + suffix;
const askText = 'Return the sender test number.';
const trigger = 'Ask @' + mockName + ' for the sender test number.';
const answer = 'receiver-number-' + suffix;
const children = [];
let peer;
let modelFailure;
let testFailure;
const rpc = new AppServerProxy({
  start: () =>
    spawn(binary, ['app-server', 'proxy', '--sock', hostSocket], { env, stdio: ['pipe', 'pipe', 'ignore'] }),
});

function spawnScoped(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-5000);
  });
  child.diagnostics = () => stderr;
  children.push(child);
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await exit.finally(() => clearTimeout(timer));
}

async function until(check, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (modelFailure) throw modelFailure;
    const dead = children.find((c) => c.exitCode !== null || c.signalCode);
    if (dead) throw new Error('Fixture child exited: ' + dead.diagnostics());
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timeout waiting for ' + label);
}

function tool(namespace, name, args) {
  const id = randomUUID();
  return {
    type: 'function_call',
    namespace,
    name,
    id: 'fc_' + id,
    call_id: 'call_' + id,
    arguments: JSON.stringify(args),
  };
}

function complete(text) {
  return {
    type: 'message',
    id: 'msg_' + randomUUID(),
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

// Fixed choices exercise real Codex tools. Only a shell tool response may supply
// the file value used in the reply, never the harness's expected copy.
function chooseResponse(request) {
  const input = request.input;
  const lastUser = input.findLastIndex((x) => x.role === 'user');
  const text = (input[lastUser]?.content ?? []).map((v) => v.text ?? '').join('\n');
  const outputs = input.slice(lastUser + 1).filter((x) => x.type === 'function_call_output');
  if (text.includes(trigger) && !outputs.length)
    return tool('mcp__peer', 'ask_peer', { username: '@' + mockName, question: askText });
  if (text.includes('[Agent Relay]')) {
    // Parse only the relay context line produced by the actual adapter.
    const context = JSON.parse(text.split('\n').find((line) => line.startsWith('{"kind":')));
    if (context.kind === 'reply') {
      const quoted = text.split('Quoted peer text (JSON string):\n').at(-1);
      return complete('Received ' + JSON.parse(quoted));
    }
    if (context.kind === 'question') {
      if (!outputs.length)
        return tool('functions', 'exec_command', { cmd: '/bin/cat relay-sample.txt', login: false });
      if (outputs.length === 1) {
        const value = JSON.stringify(outputs[0].output).match(/project-value-[0-9a-f]{20}/)?.[0];
        if (!value)
          throw new Error(
            'The Codex file-reading tool did not return the project value: ' +
              JSON.stringify(outputs[0].output).slice(-400)
          );
        return tool('mcp__peer', 'reply_to_peer', {
          in_reply_to: context.message_id,
          outcome: 'answered',
          text: value,
        });
      }
    }
  }
  return complete('Relay fixture turn completed.');
}

const model = http.createServer(async (req, res) => {
  try {
    if (req.url !== '/v1/responses') return res.writeHead(404).end();
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    let body = Buffer.concat(parts);
    if (req.headers['content-encoding'] === 'zstd') body = zstdDecompressSync(body);
    if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
    const item = chooseResponse(JSON.parse(body.toString()));
    const response = { id: 'resp_' + randomUUID(), status: 'completed', output: [item] };
    const events = [
      { type: 'response.created', response: { id: response.id, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ];
    res
      .writeHead(200, { 'content-type': 'text/event-stream' })
      .end(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
  } catch (error) {
    modelFailure = error;
    res.writeHead(500).end();
  }
});

async function completedTurn(thread, messageId, text) {
  return until(
    async () => {
      const { data } = await rpc.call('thread/turns/list', { threadId: thread, itemsView: 'full' });
      return data.find(
        (t) =>
          t.status === 'completed' &&
          t.items.some(
            (i) =>
              i.type === 'userMessage' && i.clientId === messageId && JSON.stringify(i.content).includes(text)
          )
      );
    },
    'message ' + messageId + ' in native thread ' + thread
  );
}

async function send() {
  const { thread } = await rpc.call('thread/start', { cwd: originDir, ephemeral: false });
  await rpc.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: trigger }] });
  const q = await peer.waitFor((f) => f.kind === 'question' && f.text === askText);
  assert.equal(q.from_user, username);
  const reply = await peer.call(
    'reply_to_peer',
    { in_reply_to: q.message_id, outcome: 'answered', text: answer },
    peer.sessionFor(q)
  );
  assert.equal(reply.conversation_id, q.conversation_id);
  const turn = await completedTurn(thread.id, reply.message_id, answer);
  assert.ok(
    turn.items.some((i) => i.type === 'agentMessage' && i.text.includes(answer)),
    'The original Codex turn must consume the returned value'
  );

  return {
    origin_thread: thread.id,
    conversation: q.conversation_id,
    question: q.message_id,
    reply: reply.message_id,
    reply_text: answer,
  };
}

async function receive(value) {
  async function exchange(address, question) {
    const q = await peer.call('ask_peer', { ...address, question });
    const reply = await peer.waitFor((f) => f.kind === 'reply' && f.in_reply_to === q.message_id);
    assert.equal(reply.from_user, username);
    assert.equal(reply.text, value);
    assert.equal(reply.conversation_id, q.conversation_id);
    const mappings = JSON.parse(await readFile(join(state, 'session-refs.json'), 'utf8'));
    const [, binding] = mappings.bindings.find(([id]) => id === q.conversation_id);
    const thread = mappings.sessions.find((s) => s.ref === binding.ref).native_id;
    const { thread: metadata } = await rpc.call('thread/read', { threadId: thread, includeTurns: false });
    assert.equal(await realpath(metadata.cwd), targetDir);
    const turn = await completedTurn(thread, q.message_id, question);
    const command = turn.items.find(
      (i) =>
        i.type === 'commandExecution' &&
        i.exitCode === 0 &&
        i.command.includes('cat relay-sample.txt') &&
        i.aggregatedOutput?.includes(value)
    );
    assert.ok(command, 'Native turn must contain the successful file read and its output');
    return {
      thread,
      conversation: q.conversation_id,
      question: q.message_id,
      reply: reply.message_id,
      command_exit: command.exitCode,
    };
  }
  const first = await exchange({ username }, 'Read the project sample value.');
  const follow = await exchange({ conversation_id: first.conversation }, 'Recheck the same project sample.');
  assert.equal(follow.thread, first.thread);
  assert.equal(follow.conversation, first.conversation);
  const independent = await exchange({ username }, 'Start a new check of the project sample.');
  assert.notEqual(independent.conversation, first.conversation);
  assert.notEqual(independent.thread, first.thread);
  return { project: 'isho-service', observed_file_value: value, first, follow, independent };
}

try {
  await Promise.all(
    [state, env.HOME, env.CODEX_HOME, env.TMPDIR, targetDir, originDir].map((p) => mkdir(p, { mode: 0o700 }))
  );
  const value = 'project-value-' + randomBytes(10).toString('hex');
  await writeFile(join(targetDir, 'relay-sample.txt'), value + '\n');
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  // A private host socket keeps these threads separate from any desktop instance.
  const wrapper = join(root, 'codex-proxy');
  await writeFile(wrapper, '#!/bin/sh\nexec "$RELAY_TEST_CODEX" "$@" --sock "$RELAY_TEST_SOCKET"\n', {
    mode: 0o700,
  });
  const mcpArgs = [clientCli, 'mcp', '--state-dir', state, '--server', origin, '--credential-store', 'file'];
  const config = [
    'model = "gpt-5.2"',
    'model_provider = "fixture"',
    'cli_auth_credentials_store = "file"',
    'project_doc_max_bytes = 0',
    'web_search = "disabled"',
    '[model_providers.fixture]',
    'name = "Loopback fixture"',
    'base_url = ' + JSON.stringify('http://127.0.0.1:' + model.address().port + '/v1'),
    'env_key = "RELAY_FIXTURE_KEY"',
    'wire_api = "responses"',
    'supports_websockets = false',
    '[mcp_servers.peer]',
    'command = ' + JSON.stringify(process.execPath),
    'args = ' + JSON.stringify(mcpArgs),
    '[mcp_servers.peer.tools.ask_peer]',
    'approval_mode = "approve"',
    '[mcp_servers.peer.tools.reply_to_peer]',
    'approval_mode = "approve"',
    ...[originDir, targetDir].flatMap((p) => [
      '[projects.' + JSON.stringify(p) + ']',
      'trust_level = "trusted"',
    ]),
  ];
  await writeFile(join(env.CODEX_HOME, 'config.toml'), config.join('\n') + '\n');
  const registration = new Client({ name: 'local-e2e', version: '1' });
  try {
    await registration.connect(
      new StdioClientTransport({ command: process.execPath, args: mcpArgs, stderr: 'pipe' })
    );
    const result = await registration.callTool({ name: 'register_agent', arguments: { username } });
    assert.equal(result.structuredContent?.user_id, username);
  } finally {
    await registration.close();
  }
  await run(
    process.execPath,
    [
      clientCli,
      'setup',
      '--manual',
      '--state-dir',
      state,
      '--project',
      targetDir,
      '--target',
      username + '/isho-service',
      '--agent-bin',
      wrapper,
    ],
    { env }
  );
  spawnScoped(binary, ['--no-daemon', 'app-server', '--listen', 'unix://' + hostSocket]);
  await until(() => stat(hostSocket).catch(() => false), 'Codex socket');
  spawnScoped(process.execPath, [clientCli, 'daemon', '--state-dir', state]);
  peer = await registerPeer(origin, mockName);
  await peer.publish();
  await peer.connect();
  await until(
    async () =>
      (await peer.call('search_peers', { query: username })).peers.some((p) => p.username === username),
    'online device'
  );
  const report = {
    relay: origin,
    instance_id: instanceId,
    mode,
    codex: (await run(binary, ['--version'], { env })).stdout.trim(),
    username,
    simulated_peer: mockName,
  };
  if (mode !== 'receive') report.send = await send();
  if (mode !== 'send') report.receive = await receive(value);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  testFailure = modelFailure ?? error;
  throw testFailure;
} finally {
  const cleanup = [
    () => rpc.close(),
    () => peer?.close(),
    ...children.map((child) => () => stopChild(child)),
    () => {
      if (!model.listening) return;
      const closed = new Promise((ok, no) => model.close((error) => (error ? no(error) : ok())));
      model.closeAllConnections();
      return closed;
    },
  ];
  const results = await Promise.allSettled(cleanup.map((close) => Promise.resolve().then(close)));
  await rm(root, { recursive: true, force: true });
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
  if (errors.length && !testFailure)
    throw new AggregateError(errors, 'Failed to close the local E2E fixture.');
}
