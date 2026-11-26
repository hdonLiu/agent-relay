import test from 'node:test';
import assert from 'node:assert/strict';
import { token, id } from '../collaboration/values.js';
import { Registry } from '../registry/registry.js';
import { RelayStore } from '../collaboration/store.js';
import { createRelayServer } from '../http.js';

function registration(username) {
  return { username, device_id: id(), mcp_token: token(), device_token: token() };
}

test('public registration creates usable credentials and safely replays a lost HTTP response', async t => {
  const store = new RelayStore();
  const relay = createRelayServer({ store });
  t.after(async () => { await relay.close(); store.close(); });
  const { port } = await relay.listen(0);
  const url = `http://127.0.0.1:${port}/v1/registrations`;
  const owner = token(), body = registration('alice');
  const submit = (secret, claim) => fetch(url, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: 'Bearer ' + secret
  }, body: JSON.stringify(claim) });
  const [first, repeat] = await Promise.all([submit(owner, body), submit(owner, body)]);
  for (const response of [first, repeat]) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user_id: 'alice', device_id: body.device_id });
  }
  assert.equal(store.userForToken(owner), 'alice');
  assert.equal(store.deviceForToken(body.mcp_token, 'mcp').device_id, body.device_id);
  assert.equal(store.deviceForToken(body.device_token, 'device').user_id, 'alice');
  const taken = await submit(token(), registration('alice'));
  assert.equal(taken.status, 409);
  assert.deepEqual(await taken.json(), { error: 'USERNAME_TAKEN' });
  assert.throws(() => store.register(owner, registration('alice')), { code: 'USERNAME_TAKEN' });
  assert.throws(() => store.issueUser('Alice'), { code: 'USERNAME_TAKEN' });
  assert.equal(store.userForToken(owner), 'alice');
  store.issueUser('alice');
  assert.throws(() => store.register(owner, body), { code: 'REGISTRATION_CREDENTIAL_CHANGED' });
  store.revokeDevice('alice', body.device_id);
  const revoked = await submit(owner, body);
  assert.equal(revoked.status, 403);
  assert.deepEqual(await revoked.json(), { error: 'DEVICE_REVOKED' });
  assert.equal(store.deviceForToken(body.device_token, 'device'), null);
});

test('conflicts roll back registration and preserve an existing operator identity and credential scopes', t => {
  const store = new RelayStore();
  t.after(() => store.close());
  const legacy = store.issueUser('Legacy');
  const oldDevice = store.redeem(store.enroll('Legacy').code);
  const owner = token(), alice = registration('alice');
  assert.throws(() => store.register(owner, { ...alice, username: 'legacy' }), { code: 'USERNAME_TAKEN' });
  assert.throws(() => store.register(owner, { ...alice, username: 'ALICE' }), { code: 'INVALID_USERNAME' });
  assert.throws(() => store.register(owner, { ...alice, device_token: owner }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => store.register(owner, { ...alice, device_id: oldDevice.device_id }), { code: 'REGISTRATION_CONFLICT' });
  assert.throws(() => store.register(owner, { ...alice, mcp_token: legacy }), { code: 'REGISTRATION_CONFLICT' });
  assert.equal(store.userForToken(legacy), 'Legacy');
  assert.equal(store.userForToken(owner), null);
  assert.equal(store.deviceForToken(alice.mcp_token, 'mcp'), null);
  assert.equal(store.register(owner, alice).user_id, 'alice');
});

test('newly claimed names require fresh grants; restarting discards all identities, projects and grants', () => {
  const registry = new Registry();
  const alice = registration('alice');
  const bob = registration('bob');
  const aliceOwner = token();
  registry.register(token(), bob);
  const project = {
    device_id: bob.device_id, project_id: 'app', alias: 'bob/app', allowed_senders: ['alice'],
  };
  registry.putTarget('bob', 'T', project);
  const identity = registry.register(aliceOwner, alice);
  assert.deepEqual(registry.listTargets('alice'), []);
  assert.equal(registry.resolveTarget('alice', 'bob/app'), null);
  registry.putTarget('bob', 'T', project);
  assert.deepEqual(registry.register(aliceOwner, alice), identity);
  assert.equal(registry.resolveTarget('alice', 'bob/app').target_id, 'T');

  const restarted = new Registry();
  assert.equal(restarted.userForToken(aliceOwner), null);
  assert.equal(restarted.deviceForToken(bob.device_token, 'device'), null);
  assert.deepEqual(restarted.listTargets('alice'), []);
  assert.equal(restarted.canSend('alice', 'T'), false);
  // Names can be re-claimed after a fresh boot; prior grants cannot follow them.
  restarted.register(token(), registration('alice'));
  assert.equal(restarted.resolveTarget('alice', 'bob/app'), null);
  assert.throws(() => restarted.putTarget('bob', 'T', project), { code: 'UNAUTHORIZED' });
});

test('target aliases follow a project change while old target IDs keep their grants until withdrawn', () => {
  const lost = [];
  const registry = new Registry((targetId, sender) => lost.push([targetId, sender]));
  const bob = registration('bob');
  registry.register(token(), bob);
  registry.register(token(), registration('alice'));
  const target = { device_id: bob.device_id, project_id: 'one', alias: 'bob/project', allowed_senders: ['alice'] };
  registry.putTarget('bob', 'original', target);
  registry.putTarget('bob', 'replacement', { ...target, project_id: 'two' });
  assert.equal(registry.resolveTarget('alice', 'bob/project').target_id, 'replacement');
  assert.equal(registry.resolveTarget('alice', 'original').project_id, 'one');
  assert.deepEqual(lost, []);
  registry.putTarget('bob', 'original', { ...target, alias: null, allowed_senders: [] });
  assert.equal(registry.resolveTarget('alice', 'original'), null);
  assert.deepEqual(lost, [['original', 'alice']]);
  registry.revokeDevice('bob', bob.device_id);
  assert.deepEqual(registry.listTargets('alice'), []);
});
