import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayStore } from '../collaboration/store.js';

const ctx = (session_ref, request_id) => ({ session_ref, request_id });
const ack = (message_id, bound_session_ref) => ({ v: 1, type: 'ack', message_id, bound_session_ref });
const code = expected => error => error.code === expected;

function setup(t, file = ':memory:') {
  const store = new RelayStore(file);
  t.after(() => store.close());
  const device = user => {
    store.issueUser(user);
    return store.redeem(store.enroll(user).code);
  };
  const alice = device('alice'), bob = device('bob'), carol = device('carol');
  const target = { device_id: bob.device_id, project_id: 'app', alias: 'bob/app', allowed_senders: ['alice'] };
  store.putTarget('bob', 'T1', target);
  const ask = (args, request = 'R1', ref = 'A') => store.call(alice, 'ask_peer', args, ctx(ref, request));
  const reply = (question, ref = 'B1', request = 'R2') => store.call(bob, 'reply_to_peer',
    { in_reply_to: question.message_id, outcome: 'answered', text: 'version 3.8' }, ctx(ref, request));
  return { store, alice, bob, carol, target, ask, reply };
}

test('enrollment code is one-use; device and operator tokens are scoped and revocable', t => {
  const { store, alice, bob, carol } = setup(t);
  const operator = store.issueUser('bob');
  assert.equal(store.userForToken(operator), 'bob');
  const reg = store.enroll('bob');
  const newDevice = store.redeem(reg.code);
  assert.throws(() => store.redeem(reg.code), code('INVALID_ENROLLMENT'));
  assert.equal(store.deviceForToken(newDevice.device_token, 'mcp'), null);
  assert.equal(store.userForToken(alice.mcp_token), null);
  assert.equal(store.deviceForToken(bob.mcp_token, 'mcp').device_id, bob.device_id);
  assert.deepEqual(store.listTargets('carol'), []);
  assert.deepEqual(store.listTargets('alice').map(x => x.target_id), ['T1']);
  assert.throws(() => store.call(carol, 'ask_peer', { target: 'T1', question: 'hi' }, ctx('C','R')), code('TARGET_UNAVAILABLE'));
  assert.throws(() => store.revokeDevice('carol', newDevice.device_id), code('DEVICE_UNAVAILABLE'));
  store.revokeDevice('bob', newDevice.device_id);
  assert.equal(store.deviceForToken(newDevice.device_token, 'device'), null);
  assert.equal(store.deviceForToken(newDevice.mcp_token, 'mcp'), null);
});

test('first ask is idempotent, per-lane FIFO permits independent collaborations', t => {
  const { store, alice, bob, ask, reply } = setup(t);
  const args = { target: 'bob/app', question: 'Which version?' };
  const first = ask(args);
  assert.deepEqual(ask({ question: args.question, target: args.target }), first);
  assert.throws(() => ask({ ...args, question: 'other' }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => ask({ question: 'other', target:'T1', conversation_id: first.conversation_id }), code('INVALID_ARGUMENTS'));
  assert.throws(() => ask({ target: 'T1', question: 'x'.repeat(32769) }), code('INVALID_ARGUMENTS'));
  const follow = ask({ conversation_id: first.conversation_id, question: 'Android too?' }, 'R3');
  const separate = ask({ target:'T1', question:'Independent topic' }, 'R4', 'A2');
  assert.throws(() => ask({ conversation_id: first.conversation_id, question: 'other' }, 'R5', 'A2'), code('CONVERSATION_UNAVAILABLE'));
  const heads = store.pending(bob.device_id);
  assert.deepEqual(new Set(heads.map(x=>x.message_id)), new Set([first.message_id,separate.message_id]));
  assert.deepEqual(heads[0].route, { mode:'create_if_unbound', target_id:'T1', project_id:'app' });
  store.ack(bob, ack(separate.message_id,'B2'));
  store.ack(bob, ack(first.message_id,'B1'));
  assert.deepEqual(store.pending(bob.device_id).map(x=>[x.message_id,x.seq,x.route.session_ref]), [[follow.message_id,2,'B1']]);
  reply(separate,'B2','RS');
  reply(first);
  assert.deepEqual(new Set(store.pending(alice.device_id).map(x=>x.route.session_ref)), new Set(['A','A2']));
  assert.equal(store.listConversations('alice', { request_id: 'R1' })[0].conversation_id, first.conversation_id);
  assert.throws(() => store.getConversation('carol', first.conversation_id), code('CONVERSATION_UNAVAILABLE'));
});

test('fast replies await the authenticated first ack; wrong candidate never claims the thread', t => {
  const { store, alice, bob, carol, ask, reply } = setup(t);
  const m = ask({ target:'T1', question:'hello' });
  assert.throws(() => reply(m), code('QUESTION_UNAVAILABLE'));
  store.pending(bob.device_id);
  const wrong = reply(m,'B-other','R3');
  const right = reply(m);
  assert.deepEqual(store.pending(alice.device_id), []);
  assert.throws(() => store.ack(carol, ack(m.message_id,'B-other')), code('MESSAGE_UNAVAILABLE'));
  assert.throws(() => store.ack(bob, ack(m.message_id)), code('BINDING_REQUIRED'));
  store.ack(bob, ack(m.message_id,'B1'));
  store.ack(bob, ack(m.message_id,'B1'));
  assert.throws(() => store.ack(bob, ack(m.message_id,'B-other')), code('BINDING_CONFLICT'));
  const [frame] = store.pending(alice.device_id);
  assert.deepEqual([frame.message_id,frame.in_reply_to,frame.route.session_ref], [right.message_id,m.message_id,'A']);
  assert(!store.getConversation('alice', m.conversation_id).messages.some(row => row.message_id === wrong.message_id));
  assert.throws(() => reply(m,'B-other','R4'), code('QUESTION_UNAVAILABLE'));
});

test('switching alias pins offline first ask; fixed target and grant revocation survive redelivery', t => {
  const { store, alice, bob, target, ask, reply } = setup(t);
  const first = ask({ target:'bob/app', question:'old' });
  store.putTarget('bob','T2',{ ...target, project_id:'next', fixed_session_ref:'existing' });
  assert.throws(() => store.putTarget('bob','T1',{ ...target, project_id:'moved' }), code('TARGET_IMMUTABLE'));
  const second = ask({ target:'bob/app', question:'new' },'R2');
  const deliveries = store.pending(bob.device_id);
  assert.deepEqual(deliveries.find(x=>x.message_id===first.message_id).route,
    { mode:'create_if_unbound', target_id:'T1', project_id:'app' });
  assert.equal(deliveries.find(x=>x.message_id===second.message_id).route.session_ref,'existing');
  store.putTarget('bob','T1',{ ...target, alias:null, allowed_senders:[] });
  assert(!store.pending(bob.device_id).some(x => x.message_id === first.message_id));
  assert.throws(() => reply(first), code('ACCESS_REVOKED'));
  assert.equal(store.ack(bob, ack(first.message_id, 'late-B1')).status, 'closed');
  assert.equal(store.pending(alice.device_id)[0].code,'ACCESS_REVOKED');
  assert.equal(store.getConversation('alice',first.conversation_id).closed_reason,'ACCESS_REVOKED');
});

test('pending work and diagnostic reports persist; uncertain delivery blocks requeue until reconciled', t => {
  const dir = mkdtempSync(join(tmpdir(),'relay-store-'));
  t.after(() => rmSync(dir,{ recursive:true,force:true }));
  const file = join(dir,'relay.db');
  const { store, alice, bob, ask } = setup(t,file);
  const m = ask({ target:'T1', question:'offline' });
  store.pending(bob.device_id);
  const reopened = new RelayStore(file);
  t.after(() => reopened.close());
  assert.equal(reopened.pending(bob.device_id)[0].message_id,m.message_id);
  const report = { v:1,type:'report', message_id:m.message_id, report_id:'report1', stage:'delivery',
    code:'DELIVERY_UNCERTAIN',retryable:false };
  assert.deepEqual(reopened.report(bob,report),reopened.report(bob,report));
  assert.throws(() => reopened.report(bob,{ ...report,code:'OTHER' }), code('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(reopened.pending(bob.device_id),[]);
  assert.equal(reopened.pending(alice.device_id).length,1);
  reopened.ack(bob,ack(m.message_id,'B1'));
  assert.equal(reopened.getConversation('alice',m.conversation_id).messages[0].state,'enqueued');
});

test('terminal failure to deliver an answer reports back to the connected answering session', t => {
  const { store, alice, bob, ask, reply } = setup(t);
  const q = ask({ target:'T1', question:'hello' });
  store.pending(bob.device_id);
  store.ack(bob,ack(q.message_id,'B1'));
  const answer = reply(q);
  store.pending(alice.device_id);
  store.report(alice,{v:1,type:'report',report_id:'r',message_id:answer.message_id,
    stage:'delivery',code:'THREAD_UNAVAILABLE'});
  const notices = store.pending(bob.device_id);
  assert.equal(notices.length,1);
  assert.equal(notices[0].kind,'status');
  assert.equal(notices[0].route.session_ref,'B1');
  assert.deepEqual(store.pending(alice.device_id),[]);
});

test('slash-qualified target aliases belong to their named owner', t => {
  const { store, alice, target } = setup(t);
  assert.throws(() => store.putTarget('alice', 'newTarget', { ...target, device_id:alice.device_id, alias:'carol/new' }),
    code('ALIAS_NAMESPACE_MISMATCH'));
  assert.throws(() => store.putTarget('alice','carol/other', { ...target, device_id:alice.device_id, alias:null }),
    code('INVALID_ARGUMENTS'));
  assert.throws(() => store.issueUser('carol/something'),code('INVALID_ARGUMENTS'));
});

test('large mailboxes honor retry deadlines without starving other conversations', t => {
  const { store, bob, ask } = setup(t);
  for(let i=0;i<134;i++) ask({ target:'T1',question:'hello' }, 'new-'+i);
  const page = store.pending(bob.device_id,0);
  const rest = store.pending(bob.device_id,0);
  assert.equal(page.length,128);
  assert.equal(rest.length,6);
  assert.equal(new Set([...page,...rest].map(x=>x.message_id)).size,134);
  assert.deepEqual(store.pending(bob.device_id,0),[]);
  assert.equal(store.pending(bob.device_id,Date.now()).length,128);
});
