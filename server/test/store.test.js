import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayStore } from '../collaboration/store.js';

const ack = (frame, bound_session_ref) => ({
  v: 1,
  type: 'ack',
  message_id: frame.message_id,
  bound_session_ref,
});

function setup(t, options) {
  const store = new RelayStore(options);
  t.after(() => store.close());
  const device = (username) => {
    store.issueUser(username);
    return store.redeem(store.enroll(username).code);
  };
  const alice = device('alice'),
    bob = device('bob'),
    carol = device('carol');
  const online = new Set([alice, bob, carol].map((d) => d.device_id));
  const frames = [];
  const live = {
    isOnline: (id) => online.has(id),
    send(id, frame) {
      if (!online.has(id)) return false;
      frames.push({ id, ...frame });
      return true;
    },
  };
  const target = {
    device_id: bob.device_id,
    project_id: 'isho',
    alias: 'bob/isho',
    allowed_senders: ['alice'],
  };
  store.putTarget('bob', 'project', target);
  const call = (device, tool, args, session_ref, request_id) =>
    store.call(device, tool, args, { session_ref, request_id }, live);
  const search = (device, args = {}) => call(device, 'search_peers', args);
  const ask = (args, request = 'R1', session = 'A') => call(alice, 'ask_peer', args, session, request);
  const reply = (q, session = 'B', request = 'R2') =>
    call(
      bob,
      'reply_to_peer',
      { in_reply_to: q.message_id, outcome: 'needs_info', text: 'Which version?' },
      session,
      request
    );
  return { store, alice, bob, carol, online, frames, live, target, call, search, ask, reply };
}

test('only authorized online projects are discoverable, and a sender must also be online', async (t) => {
  const { store, alice, bob, carol, online, target, call, search, ask, frames } = setup(t);
  store.putTarget('bob', 'fixed', { ...target, alias: 'bob/existing', fixed_session_ref: 'private' });
  const expected = { peers: [{ username: 'bob', target: 'bob/isho', target_id: 'project' }] };
  assert.deepEqual(await search(alice, { query: '@Bob' }), expected);
  assert.deepEqual(await search(alice, { query: 'isho' }), expected);
  assert.deepEqual(await search(carol), { peers: [] });
  assert.deepEqual(await search(bob), { peers: [] });
  await assert.rejects(call(carol, 'ask_peer', { username: 'bob', question: 'hi' }, 'C', 'x'), {
    code: 'TARGET_UNAVAILABLE',
  });
  online.delete(bob.device_id);
  assert.deepEqual(await search(alice), { peers: [] });
  await assert.rejects(ask({ username: 'bob', question: 'reachable?' }), { code: 'PEER_OFFLINE' });
  await assert.rejects(ask({ target: 'bob/isho', question: 'reachable?' }), { code: 'PEER_OFFLINE' });
  online.delete(alice.device_id);
  await assert.rejects(search(alice), { code: 'DEVICE_OFFLINE' });
  await assert.rejects(ask({ username: 'bob', question: 'reachable?' }), { code: 'DEVICE_OFFLINE' });
  assert.deepEqual(store.listConversations('alice'), []);
  assert.deepEqual(frames, []);
});

test('username chooses an owned project, subsequent turns preserve both original sessions', async (t) => {
  const { store, alice, bob, carol, frames, ask, reply } = setup(t);
  const args = { username: '@Bob', question: 'Which version?' };
  const first = ask(args);
  const duplicate = ask({ question: args.question, username: 'bob' });
  const [q] = frames;
  assert.equal(frames.length, 1);
  assert.deepEqual(q.route, { mode: 'create_if_unbound', project_id: 'isho', target_id: 'project' });
  await assert.rejects(ask({ ...args, question: 'other' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(ask({ ...args, target: 'bob/isho' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(ask({ target: 'project', question: 'x'.repeat(32769) }), {
    code: 'INVALID_ARGUMENTS',
  });
  await assert.rejects(ask({ conversation_id: q.conversation_id, question: 'Which API?' }, 'early'), {
    code: 'BINDING_UNCONFIRMED',
  });

  store.ack(bob, ack(q, 'B'));
  assert.deepEqual(await first, await duplicate);
  assert.deepEqual(await ask(args), {
    status: 'accepted',
    conversation_id: q.conversation_id,
    message_id: q.message_id,
  });
  const follow = ask({ conversation_id: q.conversation_id, question: 'Android?' }, 'R3');
  assert.deepEqual(frames[1].route, {
    mode: 'existing',
    session_ref: 'B',
    project_id: 'isho',
    target_id: 'project',
  });
  assert.equal(frames[1].seq, 2);
  store.ack(bob, ack(frames[1], 'B'));
  await follow;
  await assert.rejects(ask({ conversation_id: q.conversation_id, question: 'hi' }, 'other', 'A2'), {
    code: 'CONVERSATION_UNAVAILABLE',
  });

  const next = ask({ target: 'bob/isho', question: 'Independent?' }, 'R4', 'A2');
  const second = frames[2];
  assert.notEqual(q.conversation_id, second.conversation_id);
  assert.equal(second.route.mode, 'create_if_unbound');
  store.ack(bob, ack(second, 'B2'));
  await next;
  const answer = reply(q);
  assert.equal(frames[3].id, alice.device_id);
  assert.equal(frames[3].outcome, 'needs_info');
  assert.deepEqual(frames[3].route, { mode: 'existing', session_ref: 'A' });
  store.ack(alice, ack(frames[3], 'A'));
  await answer;
  assert.deepEqual(
    store.listConversations('alice', { request_id: 'R1' }).map((c) => c.conversation_id),
    [q.conversation_id]
  );
  assert.throws(() => store.getConversation(carol.user_id, q.conversation_id), {
    code: 'CONVERSATION_UNAVAILABLE',
  });
  assert.doesNotMatch(
    JSON.stringify(store.getConversation('alice', q.conversation_id)),
    /Which version|Android/
  );
});

test('ambiguous usernames require an explicit project, and fixed sessions require an explicit target', async (t) => {
  const { store, bob, frames, target, ask } = setup(t);
  store.putTarget('bob', 'other', { ...target, alias: 'bob/other', project_id: 'other' });
  await assert.rejects(ask({ username: 'bob', question: 'hi' }), {
    code: 'TARGET_AMBIGUOUS',
    targets: ['bob/other', 'bob/isho'],
  });
  assert.equal(frames.length, 0);
  store.putTarget('bob', 'fixed', { ...target, alias: 'bob/existing', fixed_session_ref: 'fixed-session' });
  const result = ask({ target: 'bob/existing', question: 'About this thread?' });
  assert.equal(frames[0].route.session_ref, 'fixed-session');
  store.ack(bob, ack(frames[0], 'fixed-session'));
  await result;
});

test('a fast reply can finish before the original ACK and only the bound local session can send it', async (t) => {
  const { store, alice, bob, carol, frames, ask, reply } = setup(t);
  const first = ask({ target: 'project', question: 'hi' });
  const [q] = frames;
  const wrong = assert.rejects(reply(q, 'wrong', 'wrong-request'), { code: 'QUESTION_UNAVAILABLE' });
  const answer = reply(q);
  assert.equal(frames.length, 1);
  assert.throws(() => store.bind(carol, ack(q, 'wrong')), { code: 'MESSAGE_UNAVAILABLE' });
  store.bind(bob, ack(q, 'B'));
  await wrong;
  assert.equal(frames.length, 2);
  assert.equal(frames[1].in_reply_to, q.message_id);
  assert.equal(frames[1].route.session_ref, 'A');
  store.ack(alice, ack(frames[1], 'A'));
  await answer;
  assert.throws(() => store.ack(bob, ack(q, 'wrong')), { code: 'BINDING_CONFLICT' });
  store.ack(bob, ack(q, 'B'));
  await first;
});

test('disconnect and reconnect never send again, and existing bindings can serve later follow-ups', async (t) => {
  const { store, alice, bob, online, frames, ask } = setup(t);
  const args = { target: 'project', question: 'Who owns this?' };
  const first = ask(args);
  const [q] = frames;
  store.bind(bob, ack(q, 'B'));
  online.delete(bob.device_id);
  store.disconnected(bob.device_id);
  const unconfirmed = {
    code: 'DELIVERY_UNCONFIRMED',
    conversation_id: q.conversation_id,
    message_id: q.message_id,
  };
  await assert.rejects(first, unconfirmed);
  assert.equal(store.getConversation('alice', q.conversation_id).messages[0].state, 'unconfirmed');
  await assert.rejects(ask({ conversation_id: q.conversation_id, question: 'Follow up' }, 'R3'), {
    code: 'PEER_OFFLINE',
  });
  online.add(bob.device_id);
  await assert.rejects(ask(args), unconfirmed);
  assert.equal(frames.length, 1);
  store.ack(bob, ack(q, 'B'));
  assert.equal((await ask(args)).message_id, q.message_id);
  const follow = ask({ conversation_id: q.conversation_id, question: 'Follow up' }, 'R3');
  assert.equal(frames[1].route.session_ref, 'B');
  online.delete(alice.device_id);
  store.disconnected(alice.device_id);
  await assert.rejects(follow, { code: 'DELIVERY_UNCONFIRMED' });
  assert.equal(frames.length, 2);
});

test('write rejection leaves no work behind, and a missing ACK expires without redelivery', async (t) => {
  const { store, live, frames, ask } = setup(t, { ackTimeoutMs: 15 });
  const args = { username: 'bob', question: 'hi' };
  const send = live.send;
  live.send = () => false;
  await assert.rejects(ask(args), (e) => e.code === 'PEER_OFFLINE' && !e.message_id);
  assert.deepEqual(store.listConversations('alice'), []);
  live.send = () => {
    throw Object.assign(new Error('buffer full'), { code: 'PEER_BUSY' });
  };
  await assert.rejects(ask(args), (e) => e.code === 'PEER_BUSY' && !e.message_id);
  assert.deepEqual(store.listConversations('alice'), []);
  live.send = send;
  const first = ask(args);
  const [q] = frames;
  const failure = {
    code: 'DELIVERY_UNCONFIRMED',
    conversation_id: q.conversation_id,
    message_id: q.message_id,
  };
  await assert.rejects(first, failure);
  await assert.rejects(ask(args), failure);
  assert.equal(frames.length, 1);
});

test('revoking a grant or receiving a terminal host error stops the original conversation', async (t) => {
  const { store, alice, bob, target, frames, ask, reply } = setup(t);
  const first = ask({ target: 'project', question: 'Before revoke' });
  const [q] = frames;
  store.putTarget('bob', 'project', { ...target, allowed_senders: [] });
  await assert.rejects(first, { code: 'ACCESS_REVOKED' });
  store.putTarget('bob', 'project', target);
  assert.equal(store.ack(bob, ack(q, 'B')).status, 'closed');
  await assert.rejects(reply(q), { code: 'ACCESS_REVOKED' });
  const second = ask({ target: 'project', question: 'After regrant' }, 'R3');
  const q2 = frames[1];
  store.ack(bob, ack(q2, 'B2'));
  await second;
  const answer = reply(q2, 'B2');
  const fail = {
    v: 1,
    type: 'report',
    report_id: 'report',
    message_id: frames[2].message_id,
    code: 'THREAD_UNAVAILABLE',
  };
  assert.deepEqual(store.report(alice, fail), { v: 1, type: 'report_ack', report_id: 'report' });
  await assert.rejects(answer, { code: 'THREAD_UNAVAILABLE' });
  assert.equal(store.getConversation('alice', q2.conversation_id).closed_reason, 'THREAD_UNAVAILABLE');
});

test('bounded live metadata evicts inactive conversations, and a fresh store has no prior state', async (t) => {
  const { store, alice, bob, frames, ask, live } = setup(t, { maxMessages: 2 });
  const q1 = ask({ target: 'project', question: 'one' });
  const q2 = ask({ target: 'project', question: 'two' }, 'R2');
  await assert.rejects(ask({ target: 'project', question: 'three' }, 'R3'), { code: 'RELAY_CAPACITY' });
  store.ack(bob, ack(frames[0], 'B1'));
  await q1;
  const q3 = ask({ target: 'project', question: 'three' }, 'R3');
  assert.throws(() => store.getConversation('alice', frames[0].conversation_id), {
    code: 'CONVERSATION_UNAVAILABLE',
  });
  for (const frame of frames.slice(1)) store.ack(bob, ack(frame, frame.message_id));
  await Promise.all([q2, q3]);
  const restarted = new RelayStore();
  t.after(() => restarted.close());
  assert.deepEqual(restarted.listConversations('alice'), []);
  assert.equal(restarted.deviceForToken(alice.mcp_token, 'mcp'), null);
  await assert.rejects(restarted.call(alice, 'search_peers', {}, null, live), { code: 'UNAUTHORIZED' });
});
