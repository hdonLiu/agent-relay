import test from 'node:test';
import assert from 'node:assert/strict';
import { setDefaultCACertificates, getCACertificates } from 'node:tls';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
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
    const result = check();
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
    const entry = { id, frame };
    this.events.push(entry);
    if (this.onDelivery) await this.onDelivery(entry);
    return { submission_ref: frame.message_id };
  }
  async lookupDelivery(id, messageId) {
    return this.events.some((e) => e.id === id && e.frame.message_id === messageId)
      ? 'accepted'
      : 'unknown';
  }
}

test(
  'two installed clients: stdio MCP → HTTPS → WSS → original sessions, even across offline delivery',
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
    const store = new RelayStore(join(dir, 'cloud.db'));
    const relay = createRelayServer({
      store,
      retryMs: 500,
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
    for (const [name, other] of [
      ['alice', 'bob'],
      ['bob', 'alice'],
    ]) {
      const state = join(dir, name),
        project = join(dir, name + '-project');
      mkdirSync(project);
      const token = store.issueUser(name);
      await run(
        process.execPath,
        [
          program,
          'setup',
          '--manual',
          '--credential-store',
          'file',
          '--server',
          url,
          '--state-dir',
          state,
          '--project',
          project,
          '--target',
          name + '/app',
          '--allow',
          other,
          '--agent-bin',
          process.execPath,
        ],
        { env: { ...process.env, AGENT_RELAY_USER_TOKEN: token, NODE_EXTRA_CA_CERTS: cert } }
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
    async function mcp(n) {
      const client = new Client({ name: 'fixture-' + n, version: '1' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [program, 'mcp', '--state-dir', devices[n].stateDir],
          stderr: 'pipe',
        })
      );
      clients.push(client);
      assert.deepEqual(
        (await client.listTools()).tools.map((v) => v.name),
        ['ask_peer', 'reply_to_peer']
      );
      return async (thread, callId, name, args) => {
        const result = await client.callTool({
          name,
          arguments: args,
          _meta: { threadId: thread, callId },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        return result.structuredContent;
      };
    }
    await online('alice');
    const a = await mcp('alice'),
      b = await mcp('bob');
    const question = { target: 'bob/app', question: 'What is the oldest compatible app version?' };
    const first = await a('original-A', 'a1', 'ask_peer', question);
    assert.deepEqual(await a('original-A', 'a1', 'ask_peer', question), first);
    const follow = await a('original-A', 'a2', 'ask_peer', {
      conversation_id: first.conversation_id,
      question: 'Please include Android.',
    });
    assert.equal(hosts.bob.events.length, 0);
    await offline('alice');
    let early;
    hosts.bob.onDelivery = async ({ id, frame }) => {
      if (frame.message_id === first.message_id) {
        early = await b(id, 'b1', 'reply_to_peer', {
          in_reply_to: frame.message_id,
          outcome: 'needs_info',
          text: 'Which branch?',
        });
        assert.equal(
          store
            .getConversation('bob', first.conversation_id)
            .messages.some((x) => x.message_id === early.message_id && x.state === 'enqueued'),
          false
        );
      }
    };
    await online('bob');
    await until(() => hosts.bob.events.length === 2);
    assert.equal(hosts.bob.created.length, 1);
    assert.deepEqual(
      hosts.bob.events.map((e) => e.id),
      ['fixture-thread-1', 'fixture-thread-1']
    );
    const answer = await b('fixture-thread-1', 'b2', 'reply_to_peer', {
      in_reply_to: follow.message_id,
      outcome: 'answered',
      text: 'Android supports 3.8.',
    });
    await online('alice');
    await until(() => hosts.alice.events.length === 2);
    assert.deepEqual(
      hosts.alice.events.map((e) => e.id),
      ['original-A', 'original-A']
    );
    assert.deepEqual(
      hosts.alice.events.map((e) => e.frame.message_id),
      [early.message_id, answer.message_id]
    );
    await until(() =>
      store.getConversation('alice', first.conversation_id).messages.every((m) => m.state === 'enqueued')
    );
    const third = await a('original-A', 'a3', 'ask_peer', {
      target: 'bob/app',
      question: 'Unrelated issue',
    });
    assert.notEqual(third.conversation_id, first.conversation_id);
    await until(() => hosts.bob.created.length === 2);
    assert.equal(hosts.alice.created.length, 0);
  }
);
