import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { saveSecrets } from '../settings.js';
import { tryLock } from '../lock.js';
import { WebSocketServer } from 'ws';
import { startDaemon } from '../connector/daemon.js';
import { LocalStore, sessionRefFor } from '../connector/store.js';
import { InboundDelivery } from '../connector/inbound.js';

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 250; i++) {
    const result = fn();
    if (result) return result;
    await tick(10);
  }
  assert.fail('timed out waiting for device operation');
}

function question(id = 'M1', conversation = 'C1') {
  return {
    v: 1, type: 'deliver', kind: 'question', message_id: id, conversation_id: conversation,
    seq: 1, text: 'Does this client support an empty ID?', from_user: 'alice',
    route: { target_id: 'T_APP', project_id: 'P_APP', mode: 'create_if_unbound' }
  };
}

async function local(stateDir, input) {
  const req = request({ socketPath: join(stateDir, 'relay.sock'), method: 'POST', path: '/call' });
  const ready = once(req, 'response');
  req.end(JSON.stringify(input));
  const [res] = await ready;
  let data = '';
  for await (const chunk of res) data += chunk;
  return JSON.parse(data);
}

test('device IPC, MCP and WSS share one stable binding and survive daemon restart', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'relay-device-'));
  const calls = [], reports = [], clients = [];
  let loseResponse = false;
  let oversizedRequests = 0;
  const mock = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer mcp-token');
    assert.equal(req.headers['x-agent-relay-device-id'], 'bob-mac');
    let data = '';
    for await (const part of req) data += part;
    const rpc = JSON.parse(data);
    if (rpc.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    let result = { protocolVersion: '2025-11-25' };
    if (rpc.method === 'tools/call') {
      if (rpc.params.arguments.text === 'oversized') {
        oversizedRequests++;
        return res.writeHead(413).end();
      }
      calls.push(rpc.params);
      if (loseResponse) {
        loseResponse = false;
        return res.destroy();
      }
      result = { content: [], structuredContent: { status: 'accepted', conversation_id: 'C1', message_id: 'R' } };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  const websocket = new WebSocketServer({ server: mock, path: '/v1/device-stream' });
  websocket.on('connection', (client, req) => {
    assert.equal(req.headers.authorization, 'Bearer ws-token');
    assert.equal(req.headers['x-agent-relay-device-id'], 'bob-mac');
    clients.push(client);
    client.on('message', raw => reports.push(JSON.parse(raw)));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const config = {
    server_url: 'http://127.0.0.1:' + mock.address().port, user_id: 'bob', device_id: 'bob-mac',
    mcp_token: 'mcp-token', device_token: 'ws-token',
    targets: { T_APP: { project_id: 'P_APP', adapter: 'sample', cwd: '/example/approved-project' } }
  };
  const submissions = [];
  let creates = 0;
  const adapter = {
    async createSession(target) {
      assert.equal(target.cwd, '/example/approved-project');
      creates++;
      return 'B1';
    },
    async deliver(session, frame, target) {
      assert.equal(target.cwd, '/example/approved-project');
      submissions.push([session, frame.message_id]);
      return { submission_ref: frame.message_id };
    },
    async lookupDelivery() { return 'unknown'; }
  };
  const options = { stateDir, config, adapters: { sample: adapter }, onError: () => {} };
  let daemon = await startDaemon(options);
  t.after(async () => {
    await daemon.close();
    websocket.close();
    for (const socket of clients) socket.terminate();
    mock.closeAllConnections();
    await new Promise(resolve => mock.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });
  await assert.rejects(startDaemon(options), { code: 'DAEMON_ALREADY_RUNNING' });
  await until(() => clients[0]);
  clients[0].send(JSON.stringify(question()));
  const first = await until(() => reports[0]);
  assert.equal(first.type, 'bind');
  assert.equal((await until(() => reports[1])).type, 'ack');
  assert.equal(first.bound_session_ref, sessionRefFor({ stateDir, config, adapter: 'sample', nativeId: 'B1' }));
  assert.notEqual(first.bound_session_ref, 'B1');

  const replyInput = { adapter: 'sample', native_session_id: 'B1', native_call_id: 'tool1', tool: 'reply_to_peer',
    arguments: { in_reply_to: 'M1', outcome: 'answered', text: 'Yes.' } };
  assert.equal((await local(stateDir, replyInput)).structuredContent.message_id, 'R');
  const context = calls[0]._meta['peer.example/context'];
  assert.equal(context.session_ref, first.bound_session_ref);
  assert.ok(context.request_id);
  assert.equal((await local(stateDir, replyInput)).structuredContent.message_id, 'R');
  assert.equal(calls.length, 1);
  const changed = { ...replyInput, arguments: { ...replyInput.arguments, text: 'Changed.' } };
  assert.equal((await local(stateDir, changed)).structuredContent.code, 'IDEMPOTENCY_CONFLICT');
  const oversized = { ...replyInput, native_call_id: 'large', arguments: { ...replyInput.arguments, text: 'oversized' } };
  assert.equal((await local(stateDir, oversized)).structuredContent.code, 'REQUEST_TOO_LARGE');

  // The cloud accepted the request, but its response never reached the device.
  loseResponse = true;
  const interrupted = { ...replyInput, native_call_id: 'tool2' };
  const offline = (await local(stateDir, interrupted)).structuredContent;
  assert.equal(offline.code, 'DELIVERY_UNCONFIRMED');
  assert.equal((await local(stateDir, interrupted)).structuredContent.code, 'DELIVERY_UNCONFIRMED');
  assert.equal(calls.length, 2);
  assert.equal(offline.request_id, calls[1]._meta['peer.example/context'].request_id);
  await daemon.close();
  daemon = await startDaemon(options);
  await until(() => clients.length === 2);
  assert.equal(calls.length, 2); // a fresh connection did not submit any saved body
  assert.equal(oversizedRequests, 1);
  assert.equal((await local(stateDir, interrupted)).structuredContent.message_id, 'R');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], calls[1]); // explicit host retry only, same server idempotency key
  const followup = question('M3');
  followup.route = { mode: 'existing', session_ref: first.bound_session_ref };
  clients[1].send(JSON.stringify(followup));
  assert.equal((await until(() => reports[2])).type, 'ack');
  const search = { ...replyInput, tool: 'search_peers', arguments: { query: '@alice' } };
  await local(stateDir, search);
  await local(stateDir, search);
  assert.equal(calls.filter(call => call.name === 'search_peers').length, 2); // always live
  assert.equal(creates, 1);
  assert.deepEqual(submissions, [['B1', 'M1'], ['B1', 'M3']]);
  const files = await readdir(stateDir);
  assert.ok(!files.some(name => name.includes('sqlite')));
  const refs = await readFile(join(stateDir, 'session-refs.json'), 'utf8');
  assert.ok(!refs.includes(question().text) && !refs.includes('Yes.'));
});

test('failed host confirmation does not re-execute a duplicate or acknowledge over a replacement connection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-receipt-'));
  const store = new LocalStore(dir, { device_id: 'd', device_token: 'secret', server_url: 'https://relay.example' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const frames = [];
  let submissions = 0;
  const adapter = {
    async createSession() { return 'B'; },
    async deliver() { submissions++; throw new Error('connection lost after submission'); }
  };
  const delivery = new InboundDelivery(store, { T_APP: { adapter: 'sample', project_id: 'P_APP' } }, { sample: adapter });
  const link = { send: frame => frames.push(frame), isOpen: () => true };
  await Promise.all([delivery.receive(question(), link), delivery.receive(question(), link)]);
  assert.equal(frames[0].type, 'bind');
  assert.equal(frames[1].code, 'DELIVERY_UNCONFIRMED');
  assert.equal(frames[1].type, 'report');
  await delivery.receive(question(), link);
  assert.equal(submissions, 1);
  assert.equal(frames.at(-1).code, 'DELIVERY_UNCONFIRMED');
  const disconnected = { send: () => assert.fail('sent on disconnected link'), isOpen: () => false };
  await delivery.receive(question('M2'), disconnected);
  assert.equal(submissions, 1);
});

test('a killed connector releases its process lock so a replacement can claim the same directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "const { tryLock } = await import(process.argv[1]); if (tryLock(process.argv[2], 'daemon')) process.stdout.write('ready'); setInterval(() => {}, 1000)",
    new URL('../lock.js', import.meta.url).href, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  assert.equal(tryLock(dir, 'daemon'), null);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const unlock = tryLock(dir, 'daemon');
  assert.equal(typeof unlock, 'function');
  unlock();
});

test('setup and daemon use the same opaque reference for a fixed native thread', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-fixed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { device_id: 'd', server_url: 'https://relay.example', credential_store: 'file', targets: {} };
  const secrets = { device_token: 'local-device-secret' };
  saveSecrets(dir, 'file', secrets);
  const input = { stateDir: dir, config, adapter: 'sample', nativeId: 'B-fixed' };
  const fixed = sessionRefFor(input);
  const store = new LocalStore(dir, { ...config, ...secrets });
  assert.equal(store.mapSession('sample', 'B-fixed').ref, fixed);
  const target = { adapter: 'sample', project_id: 'P_APP', native_session_id: 'B-fixed', fixed_session_ref: fixed };
  config.targets = { T_APP: target };
  const delivery = new InboundDelivery(new LocalStore(dir, { ...config, ...secrets }), config.targets, {
    sample: { async deliver(nativeId, frame, resolved) {
      assert.equal(nativeId, 'B-fixed');
      assert.equal(resolved, target);
      return { submission_ref: frame.message_id };
    } }
  });
  const frames = [];
  await delivery.receive({ ...question(), route: { mode: 'existing', session_ref: fixed, target_id: 'T_APP', project_id: 'P_APP' } },
    { isOpen: () => true, send: frame => frames.push(frame) });
  assert.deepEqual(frames, [{ v: 1, type: 'ack', message_id: 'M1', bound_session_ref: fixed }]);

  // Fixed targets set up on an earlier connector keep their published reference.
  target.fixed_session_ref = 'previous-reference';
  assert.equal(sessionRefFor(input), 'previous-reference');
});
