import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
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
  assert.equal(first.type, 'ack');
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
  assert.equal(offline.local_status, 'awaiting_confirmation');
  assert.equal(offline.request_id, calls[1]._meta['peer.example/context'].request_id);
  await daemon.close();
  daemon = await startDaemon(options);
  await until(() => clients.length === 2);
  await until(() => calls.length === 3);
  assert.deepEqual(calls[2], calls[1]);
  assert.equal(oversizedRequests, 1);
  assert.equal((await local(stateDir, interrupted)).structuredContent.message_id, 'R');
  assert.equal(calls.length, 3);
  clients[1].send(JSON.stringify(question()));
  assert.equal((await until(() => reports[1])).bound_session_ref, first.bound_session_ref);
  const followup = question('M3');
  followup.route = { mode: 'existing', session_ref: first.bound_session_ref };
  clients[1].send(JSON.stringify(followup));
  assert.equal((await until(() => reports[2])).type, 'ack');
  assert.equal(creates, 1);
  assert.deepEqual(submissions, [['B1', 'M1'], ['B1', 'M3']]);
});

test('uncertain execution requires evidence before another attempt and durable confirmation after acceptance', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-receipt-'));
  const store = new LocalStore(dir, { device_id: 'd', server_url: 'https://relay.example' });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const frames = [];
  let submissions = 0, evidence = 'unknown';
  const adapter = {
    async createSession() { return 'B'; },
    async deliver() { submissions++; throw new Error('connection lost after submission'); },
    async lookupDelivery() { return evidence; }
  };
  const delivery = new InboundDelivery(store, { T_APP: { adapter: 'sample', project_id: 'P_APP' } },
    { sample: adapter }, frame => frames.push(frame));
  await Promise.all([delivery.receive(question()), delivery.receive(question())]);
  assert.equal(frames[0].code, 'DELIVERY_UNCERTAIN');
  assert.equal(frames[0].type, 'report');
  store.confirmReport(frames[0].report_id);
  await delivery.receive(question());
  assert.equal(submissions, 1);
  evidence = 'not_submitted';
  await delivery.receive(question(), true);
  assert.equal(frames.at(-1).code, 'HOST_NOT_SUBMITTED');
  assert.equal(submissions, 1);
  // The cloud authorizes another attempt. Its new ambiguous outcome must
  // suspend delivery even though the first uncertainty was already reported.
  evidence = 'unknown';
  await delivery.receive(question());
  assert.equal(frames.at(-1).code, 'DELIVERY_UNCERTAIN');
  assert.notEqual(frames.at(-1).report_id, frames[0].report_id);
  assert.equal(submissions, 2);
  evidence = 'accepted';
  await delivery.receive(question(), true);
  assert.equal(frames.at(-1).type, 'ack');
  assert.equal(submissions, 2);
  assert.deepEqual(store.pendingReports(), []);
  // Recovery may observe the host even with WSS down. The cloud can already
  // have blocked the original delivery, so the client must resend this ACK.
  const restarted = new LocalStore(dir, { device_id: 'd', server_url: 'https://relay.example' });
  try {
    assert.deepEqual(restarted.recoveryAcks(), [frames.at(-1)]);
    restarted.confirmAck('M1');
    assert.deepEqual(restarted.recoveryAcks(), []);
  } finally { restarted.close(); }
});
