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

test('joining after a project is published preserves it; restarting discards identities and projects', () => {
  const registry = new Registry();
  const alice = registration('alice');
  const bob = registration('bob');
  const aliceOwner = token();
  registry.register(token(), bob);
  const project = { device_id: bob.device_id, project_id: 'app', alias: 'bob/app' };
  registry.putTarget('bob', 'T', project);
  const identity = registry.register(aliceOwner, alice);
  assert.deepEqual(registry.register(aliceOwner, alice), identity);
  assert.equal(registry.resolveTarget('bob/app').target_id, 'T');
  assert.deepEqual(registry.listTargets(), [registry.resolveTarget('bob/app')]);
  assert.throws(() => registry.putTarget('alice', 'T', { ...project, alias: 'alice/app' }), { code: 'UNAUTHORIZED' });
  assert.throws(() => registry.putTarget('alice', 'T', {
    ...project, device_id: alice.device_id, alias: 'alice/app',
  }), { code: 'TARGET_UNAVAILABLE' });

  const restarted = new Registry();
  assert.equal(restarted.userForToken(aliceOwner), null);
  assert.equal(restarted.deviceForToken(bob.device_token, 'device'), null);
  assert.deepEqual(restarted.listTargets(), []);
  restarted.register(token(), registration('alice'));
  assert.equal(restarted.resolveTarget('bob/app'), null);
  assert.throws(() => restarted.putTarget('bob', 'T', project), { code: 'UNAUTHORIZED' });
});

test('target aliases follow a project change while old target IDs still resolve until device revocation', () => {
  const registry = new Registry();
  const bob = registration('bob');
  registry.register(token(), bob);
  const target = { device_id: bob.device_id, project_id: 'one', alias: 'bob/project' };
  registry.putTarget('bob', 'original', target);
  registry.putTarget('bob', 'replacement', { ...target, project_id: 'two' });
  assert.equal(registry.resolveTarget('bob/project').target_id, 'replacement');
  assert.equal(registry.resolveTarget('original').project_id, 'one');
  registry.revokeDevice('bob', bob.device_id);
  assert.equal(registry.resolveTarget('original'), null);
  assert.equal(registry.resolveTarget('bob/project'), null);
  assert.deepEqual(registry.listTargets(), []);
});

test('the owner management endpoint lists only the owner’s projects and omits local session references', async t => {
  const store = new RelayStore();
  const relay = createRelayServer({ store });
  t.after(async () => { await relay.close(); store.close(); });
  const { port } = await relay.listen(0);
  const bobOwner = token(), aliceOwner = token(), bob = registration('bob');
  store.register(bobOwner, bob);
  store.register(aliceOwner, registration('alice'));
  store.putTarget('bob', 'private', {
    device_id: bob.device_id, project_id: 'app', alias: 'bob/app', fixed_session_ref: 'local-thread',
  });
  async function listOwned(owner) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/targets`, {
      headers: { authorization: 'Bearer ' + owner },
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  assert.deepEqual(await listOwned(aliceOwner), []);
  const targets = await listOwned(bobOwner);
  assert.deepEqual(targets.map(target => target.target_id), ['private']);
  assert.equal(Object.hasOwn(targets[0], 'fixed_session_ref'), false);
});
