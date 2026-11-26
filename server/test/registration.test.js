import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { token, id } from '../collaboration/db.js';
import { RelayStore } from '../collaboration/store.js';
import { createRelayServer } from '../http.js';

function registration(username) {
  return { username, device_id: id(), mcp_token: token(), device_token: token() };
}

test('public registration creates usable credentials and safely replays a lost HTTP response', async t => {
  const store = new RelayStore(':memory:');
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
  const store = new RelayStore(':memory:');
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

test('legacy grants survive migration, but a new public claimant needs a fresh decision from the sharing owner', t => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-signup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'relay.db');
  const previous = new RelayStore(file);
  previous.issueUser('operator');
  previous.issueUser('known');
  const device = previous.redeem(previous.enroll('operator').code);
  const target = { device_id: device.device_id, project_id: 'app', alias: 'operator/app',
    allowed_senders: ['known', 'alice'] };
  previous.putTarget('operator', 'T', target);
  previous.close();
  const oldSchema = new DatabaseSync(file);
  oldSchema.exec('ALTER TABLE grants DROP COLUMN active');
  oldSchema.close();

  const store = new RelayStore(file);
  t.after(() => store.close());
  assert.deepEqual(store.listTargets('known').map(row => row.target_id), ['T']);
  const owner = token(), alice = registration('alice');
  const identity = store.register(owner, alice);
  assert.deepEqual(store.listTargets('alice'), []);
  const ask = () => store.call(identity, 'ask_peer', { target: 'T', question: 'Hello?' },
    { session_ref: 'A', request_id: 'R1' });
  assert.throws(ask, { code: 'TARGET_UNAVAILABLE' });
  store.putTarget('operator', 'T', target);
  assert.deepEqual(store.register(owner, alice), identity);
  assert.deepEqual(store.listTargets('alice').map(row => row.target_id), ['T']);
  assert.ok(ask().conversation_id);
});
