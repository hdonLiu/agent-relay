import test from 'node:test';
import assert from 'node:assert/strict';
import { setDefaultCACertificates, getCACertificates } from 'node:tls';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRelayServer } from '../server/http.js';
import { RelayStore } from '../server/collaboration/store.js';
import { startDaemon } from '../client/connector/daemon.js';
import { readSettings, loadSecrets } from '../client/settings.js';

const run = promisify(execFile);
async function until(check) {
  for (let i = 0; i < 250; i++) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  assert.fail('Timed out waiting for relay state');
}
class ExampleHost {
  constructor() {
    this.events = [];
    this.created = [];
  }
  async createSession(target) {
    const id = 'fixture-thread-' + (this.created.length + 1);
    this.created.push({ id, target });
    return id;
  }
  async deliver(id, frame) {
    this.events.push({ id, frame });
    return { submission_ref: frame.message_id };
  }
}

test(
  'two online devices discover each other and continue their original sessions; offline requests never replay',
  { timeout: 40_000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-net-'));
    const cert = join(dir, 'tls.pem'),
      key = join(dir, 'tls-key.pem');
    // Use an ephemeral trust root, never disable TLS verification.
    writeFileSync(
      join(dir, 'openssl.cnf'),
      '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n'
    );
    execFileSync(
      'openssl',
      [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-x509',
        '-days',
        '1',
        '-config',
        join(dir, 'openssl.cnf'),
        '-out',
        cert,
        '-keyout',
        key,
      ],
      { stdio: 'ignore' }
    );
    const trust = getCACertificates('default');
    setDefaultCACertificates([...trust, readFileSync(cert, 'utf8')]);
    const store = new RelayStore();
    const relay = createRelayServer({
      store,
      tls: { cert: readFileSync(cert), key: readFileSync(key) },
    });
    const { port } = await relay.listen(0);
    const url = 'https://127.0.0.1:' + port;
    const daemons = new Map(),
      clients = [];
    t.after(async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
      await Promise.allSettled([...daemons.values()].map((d) => d.close()));
      await relay.close();
      store.close();
      setDefaultCACertificates(trust);
      rmSync(dir, { recursive: true, force: true });
    });
    const hosts = { alice: new ExampleHost(), bob: new ExampleHost() };
    const devices = {};
    const program = resolve('client/index.js');
    const mcp = {};
    // Bob publishes his project before Alice joins the relay.
    for (const name of ['bob', 'alice']) {
      const state = join(dir, name);
      const client = new Client({ name: 'fixture-' + name, version: '1' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [program, 'mcp', '--server', url, '--state-dir', state, '--credential-store', 'file'],
          env: { NODE_EXTRA_CA_CERTS: cert },
          stderr: 'pipe',
        })
      );
      clients.push(client);
      mcp[name] = (thread, tool, args, callId = randomUUID()) =>
        client.callTool({
          name: tool,
          arguments: args,
          _meta: { threadId: thread, callId },
        });
      assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'search_peers'));
      assert.equal(
        (await mcp[name]('owner', 'register_agent', { username: name })).structuredContent.user_id,
        name
      );
      const project = join(dir, name + '-project');
      mkdirSync(project);
      await run(
        process.execPath,
        [
          program,
          'setup',
          '--manual',
          '--server',
          url,
          '--state-dir',
          state,
          '--project',
          project,
          '--target',
          name + '/app',
          '--agent-bin',
          process.execPath,
        ],
        { env: { ...process.env, AGENT_RELAY_USER_TOKEN: '', NODE_EXTRA_CA_CERTS: cert } }
      );
      const conf = readSettings(state);
      devices[name] = {
        stateDir: state,
        config: { ...conf, ...loadSecrets(state, 'file') },
        adapters: { codex: hosts[name] },
      };
    }
    const bobTokens = devices.bob.config;
    const mismatch = { 'x-agent-relay-device-id': devices.alice.config.device_id };
    const wrongDevice = await fetch(url + '/mcp', {
      method: 'POST',
      headers: { ...mismatch, authorization: 'Bearer ' + bobTokens.mcp_token },
    });
    assert.equal(wrongDevice.status, 401);
    await assert.rejects(
      new Promise((ok, no) => {
        const ws = new WebSocket(url.replace('https:', 'wss:') + '/v1/device-stream', {
          headers: { ...mismatch, authorization: 'Bearer ' + bobTokens.device_token },
        });
        ws.once('error', no);
        ws.once('open', () => {
          ws.terminate();
          ok();
        });
      }),
      /401/
    );
    async function online(n) {
      daemons.set(n, await startDaemon(devices[n]));
    }
    async function offline(n) {
      await daemons.get(n).close();
      daemons.delete(n);
    }
    async function ok(reply) {
      const r = await reply;
      assert.notEqual(r.isError, true, JSON.stringify(r.structuredContent));
      return r.structuredContent;
    }
    const a = (tool, args, id) => mcp.alice('original-A', tool, args, id);
    const b = (tool, args, id) => mcp.bob('fixture-thread-1', tool, args, id);
    const sees = async (call, username) => {
      const r = await call('search_peers', { query: username });
      return r.isError ? undefined : r.structuredContent.peers.some((p) => p.username === username);
    };
    await online('alice');
    await until(async () => (await sees(a, 'bob')) === false);
    const question = { username: '@bob', question: 'What is the oldest compatible app version?' };
    const rejected = await a('ask_peer', question);
    assert.equal(rejected.isError, true);
    assert.equal(hosts.bob.events.length, 0);

    await online('bob');
    await until(() => sees(a, 'bob'));
    assert.equal(hosts.bob.events.length, 0);
    const first = await ok(a('ask_peer', question, 'a1'));
    assert.deepEqual(await ok(a('ask_peer', question, 'a1')), first);
    assert.equal(hosts.bob.created.length, 1);
    assert.equal(hosts.bob.created[0].target.cwd, realpathSync(join(dir, 'bob-project')));

    const clarification = await ok(
      b('reply_to_peer', { in_reply_to: first.message_id, outcome: 'needs_info', text: 'Which branch?' })
    );
    const follow = await ok(
      a('ask_peer', { conversation_id: first.conversation_id, question: 'Please include Android.' })
    );
    assert.equal(follow.conversation_id, first.conversation_id);
    assert.deepEqual(
      hosts.bob.events.map((e) => e.id),
      ['fixture-thread-1', 'fixture-thread-1']
    );
    await offline('alice');
    await until(async () => (await sees(b, 'alice')) === false);
    const answerBody = {
      in_reply_to: follow.message_id,
      outcome: 'answered',
      text: 'Android supports 3.8.',
    };
    assert.equal((await b('reply_to_peer', answerBody)).isError, true);
    await online('alice');
    await until(() => sees(b, 'alice'));
    const answer = await ok(b('reply_to_peer', answerBody));
    assert.deepEqual(
      hosts.alice.events.map((e) => e.id),
      ['original-A', 'original-A']
    );
    assert.deepEqual(
      hosts.alice.events.map((e) => e.frame.message_id),
      [clarification.message_id, answer.message_id]
    );

    const fresh = await ok(a('ask_peer', { target: 'bob/app', question: 'Unrelated issue' }));
    assert.notEqual(fresh.conversation_id, first.conversation_id);
    assert.equal(hosts.bob.created.length, 2);
    assert.equal(hosts.alice.created.length, 0);
  }
);
