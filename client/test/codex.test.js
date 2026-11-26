import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { CodexAdapter, identifyCall } from '../adapters/codex/index.js';
import { AppServerProxy } from '../adapters/codex/proxy.js';

const question = {
  kind: 'question', conversation_id: 'C1', message_id: 'M1', from_user: 'alice', text: 'Does v3 support an empty ID?',
};

test('requires host-originated call and thread IDs; root session ID is not a substitute', () => {
  assert.throws(() => identifyCall({ sessionId: 'root', callId: '1' }), { code: 'CALL_CONTEXT_UNAVAILABLE' });
  assert.deepEqual(identifyCall({ sessionId: 'root', threadId: 'child', callId: '1' }), {
    native_session_id: 'child', native_call_id: '1',
  });
});

test('creates a read-only local thread and can queue its first input before it is indexed', async () => {
  const calls = [];
  const adapter = new CodexAdapter({ rpc: { async call(method, params) {
    calls.push(method);
    if (method === 'config/read') return { config: { mcp_servers: { peer: {}, unrelated: {} } } };
    if (method === 'thread/start') {
      assert.equal(params.cwd, '/work/app');
      assert.deepEqual(params.runtimeWorkspaceRoots, ['/work/app']);
      assert.equal(params.ephemeral, false);
      assert.equal(params.permissions, 'agent-relay-project');
      assert.deepEqual(params.config['permissions.agent-relay-project.filesystem'], { ':minimal': 'read', ':workspace_roots': 'read' });
      assert.equal(params.config['permissions.agent-relay-project.network.enabled'], false);
      assert.deepEqual(params.config.mcp_servers, { peer: { required: true }, unrelated: { enabled: false } });
      assert.equal(params.approvalPolicy, undefined);
      return { thread: { id: 'B1' } };
    }
    assert.equal(params.threadId, 'B1');
    assert.equal(params.clientUserMessageId, 'M1');
    assert.match(params.input[0].text, /reply_to_peer/);
    assert.match(params.input[0].text, /untrusted/);
    return { queuedSubmission: { clientUserMessageId: 'M1', id: 'Q1' } };
  } } });
  assert.equal(await adapter.createSession({ cwd: '/work/app' }), 'B1');
  assert.deepEqual(await adapter.deliver('B1', question), { submission_ref: 'Q1' });
  assert.deepEqual(calls, ['config/read', 'thread/start', 'thread/queue/add']);
});

test('uses only the original, non-archived thread in the current account and resumes it before queueing', async () => {
  const calls = [];
  const adapter = new CodexAdapter({ rpc: { async call(method, params) {
    calls.push(method);
    if (method === 'thread/list') {
      assert.deepEqual(params.includedThreadIds, ['A']);
      assert.equal(params.currentAccountOnly, true);
      assert.equal(params.archived, false);
      return { data: [{ id: 'A', status: { type: 'notLoaded' } }] };
    }
    assert.equal(params.threadId, 'A');
    if (method === 'thread/resume') return { thread: { id: 'A' } };
    assert.match(params.input[0].text, /continue the original/);
    return { queuedSubmission: { clientUserMessageId: 'M2', id: 'Q2' } };
  } } });
  await adapter.deliver('A', { ...question, kind: 'reply', message_id: 'M2', in_reply_to: 'M1', text: 'Yes.' });
  assert.deepEqual(calls, ['thread/list', 'thread/resume', 'thread/queue/add']);
});

test('rejects a registered question target bound to another project before resume or delivery', async () => {
  const adapter = new CodexAdapter({ rpc: { async call(method) {
    assert.equal(method, 'thread/list');
    return { data: [{ id: 'fixed', cwd: '/other/project', status: { type: 'notLoaded' } }] };
  } } });
  await assert.rejects(adapter.deliver('fixed', question, { cwd: '/project', native_session_id: 'fixed' }),
    { code: 'TARGET_PROJECT_MISMATCH', submission: 'not_submitted' });
});

test('unavailable thread never causes a fork or new session, mismatched queue receipt is inconclusive', async () => {
  const missing = new CodexAdapter({ rpc: { async call(method) {
    assert.equal(method, 'thread/list'); return { data: [] };
  } } });
  await assert.rejects(missing.deliver('removed', question), { submission: 'not_submitted' });
  const adapter = new CodexAdapter({ rpc: { async call(method) {
    if (method === 'thread/list') return { data: [{ id: 'A', status: { type: 'active' } }] };
    assert.equal(method, 'thread/queue/add');
    return { queuedSubmission: { clientUserMessageId: 'different', id: 'Q1' } };
  } } });
  await assert.rejects(adapter.deliver('A', question), { code: 'DELIVERY_UNCERTAIN', submission: 'unknown' });
});

test('reconciles across all queue and history pages; absent evidence stays unknown', async () => {
  const adapter = new CodexAdapter({ rpc: { async call(method, params) {
    assert.equal(params.threadId, 'B1');
    if (method === 'thread/queue/list') return { data: [] };
    assert.equal(params.itemsView, 'full');
    if (!params.cursor) return { data: [], nextCursor: 'next' };
    return { data: [{ items: [{ type: 'userMessage', clientId: 'M1' }] }] };
  } } });
  assert.equal(await adapter.lookupDelivery('B1', 'M1'), 'accepted');
  assert.equal(await adapter.lookupDelivery('B1', 'M2'), 'unknown');
});

test('proxy initializes once for concurrent RPC and never handles owner approvals as client responses', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const sent = [];
  server.on('connection', ws => ws.on('message', bytes => {
    const req = JSON.parse(bytes);
    sent.push(req);
    if (req.id !== undefined) {
      ws.send(JSON.stringify({ id: req.id, method: 'item/commandExecution/requestApproval' }));
      ws.send(JSON.stringify({ id: req.id, result: { method: req.method } }));
    }
  }));
  const child = new EventEmitter();
  child.stdout = child.stdin = connect(server.address().port, '127.0.0.1');
  child.kill = () => child.stdin.destroy();
  const proxy = new AppServerProxy({ start: () => child });
  try {
    const results = await Promise.all([proxy.call('thread/list', {}), proxy.call('thread/read', {})]);
    assert.deepEqual(results, [{ method: 'thread/list' }, { method: 'thread/read' }]);
    assert.deepEqual(sent.map(x => x.method), ['initialize', 'initialized', 'thread/list', 'thread/read']);
    assert.equal(sent[0].params.capabilities.experimentalApi, true);
  } finally {
    proxy.close();
    await new Promise(resolve => server.close(resolve));
  }
});
