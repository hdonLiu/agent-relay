import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerAgent } from '../registration.js';
import { loadSecrets, readSettings, saveJson, saveSecrets, saveSettings } from '../settings.js';

async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-registration-'));
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    await handler(req, res, JSON.parse(text));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    stateDir: dir,
    serverUrl: 'http://127.0.0.1:' + server.address().port,
    credentialStore: 'file',
  };
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

test('registration reuses durable credentials after a lost acceptance and resolves concurrent calls', async (t) => {
  const claims = [];
  const checks = [];
  const options = await fixture(t, async (req, res, body) => {
    if (req.url === '/mcp') {
      checks.push(req.headers);
      return json(res, 200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } });
    }
    assert.equal(req.url, '/v1/registrations');
    claims.push({ body, bearer: req.headers.authorization });
    if (claims.length === 1) return req.socket.destroy(); // server committed; response was lost
    return json(res, 200, { user_id: body.username, device_id: body.device_id });
  });
  await assert.rejects(registerAgent({ ...options, username: 'a' }), { code: 'INVALID_USERNAME' });
  await assert.rejects(registerAgent({ ...options, username: '@Alice' }), {
    code: 'REGISTRATION_UNCONFIRMED',
  });
  const first = claims[0];
  assert.equal(first.body.username, 'alice');
  const secrets = loadSecrets(options.stateDir, 'file');
  assert.equal(new Set(Object.values(secrets)).size, 3);
  for (const v of Object.values(secrets)) assert.equal(Buffer.from(v, 'base64url').length, 32);
  assert.equal(first.bearer, 'Bearer ' + secrets.management_token);
  const journal = await readFile(join(options.stateDir, 'registration.json'), 'utf8');
  for (const v of Object.values(secrets)) assert.equal(journal.includes(v), false);
  await assert.rejects(registerAgent({ ...options, username: 'bob' }), { code: 'REGISTRATION_PENDING' });
  await assert.rejects(
    registerAgent({ ...options, username: 'alice', serverUrl: 'https://other.example' }),
    { code: 'RELAY_ORIGIN_MISMATCH' }
  );
  const results = await Promise.all([
    registerAgent({ ...options, username: 'alice' }),
    registerAgent({ ...options, username: '@ALICE' }),
  ]);
  assert.deepEqual(
    results,
    Array(2).fill({ status: 'registered', device_id: first.body.device_id, user_id: 'alice' })
  );
  assert.deepEqual(claims, [first, first]);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]['x-agent-relay-device-id'], first.body.device_id);
  assert.equal(checks[0].authorization, 'Bearer ' + first.body.mcp_token);
  assert.equal(readSettings(options.stateDir).user_id, 'alice');
  await assert.rejects(readFile(join(options.stateDir, 'registration.json')), { code: 'ENOENT' });
  assert.deepEqual(loadSecrets(options.stateDir, 'file'), secrets);
});

test('a rejected username permits selecting a new name, and a revoked registration stays revoked', async (t) => {
  const claims = [];
  const options = await fixture(t, async (req, res, body) => {
    if (req.url === '/mcp') return json(res, 401, { error: 'UNAUTHORIZED' });
    claims.push(body);
    if (body.username === 'taken') return json(res, 409, { error: 'USERNAME_TAKEN' });
    return json(res, 201, { user_id: body.username, device_id: body.device_id });
  });
  await assert.rejects(registerAgent({ ...options, username: 'taken' }), { code: 'USERNAME_TAKEN' });
  const registered = await registerAgent({ ...options, username: 'alice' });
  assert.equal(registered.user_id, 'alice');
  assert.deepEqual(claims[0], { ...claims[1], username: 'taken' });
  await assert.rejects(registerAgent({ ...options, username: 'alice' }), { code: 'DEVICE_REVOKED' });
  await assert.rejects(registerAgent({ ...options, username: 'bob' }), {
    code: 'LOCAL_IDENTITY_MISMATCH',
  });
  assert.equal(claims.length, 2);
});

test('legacy enrollment is verified with its device credential and preserves local configuration', async (t) => {
  const options = await fixture(t, async (req, res, body) => {
    assert.equal(req.url, '/mcp');
    assert.equal(req.headers.authorization, 'Bearer legacy-mcp');
    assert.equal(req.headers['x-agent-relay-device-id'], 'old-device');
    json(res, 200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } });
  });
  const config = {
    server_url: options.serverUrl,
    user_id: 'Alice',
    device_id: 'old-device',
    credential_store: 'file',
    adapters: { codex: { binary: 'codex' } },
    targets: { project: {} },
  };
  const secrets = { mcp_token: 'legacy-mcp', device_token: 'legacy-device' };
  saveSettings(options.stateDir, config);
  saveSecrets(options.stateDir, 'file', secrets);
  assert.deepEqual(await registerAgent({ ...options, username: '@alice' }), {
    status: 'registered',
    user_id: 'Alice',
    device_id: 'old-device',
  });
  assert.deepEqual(loadSecrets(options.stateDir, 'file'), secrets);
  assert.deepEqual(readSettings(options.stateDir), config);
});

test('orphaned credentials survive reinstall; an interrupted pre-send journal can resume its own identity', async (t) => {
  const claims = [];
  const options = await fixture(t, async (req, res, body) => {
    claims.push(body);
    return json(res, 200, { user_id: body.username, device_id: body.device_id });
  });
  await registerAgent({ ...options, username: 'alice' });
  const keys = loadSecrets(options.stateDir, 'file');
  const original = readSettings(options.stateDir);
  const configPath = join(options.stateDir, 'config.json');
  await rm(configPath);
  await assert.rejects(registerAgent({ ...options, username: 'bob' }), {
    code: 'LOCAL_CREDENTIALS_EXIST',
  });
  assert.deepEqual(loadSecrets(options.stateDir, 'file'), keys);
  assert.equal(claims.length, 1);
  await assert.rejects(readFile(join(options.stateDir, 'registration.json')), { code: 'ENOENT' });

  // The credentials were stored, but the process died before marking the write complete.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([keys.management_token, keys.mcp_token, keys.device_token]))
    .digest('hex');
  saveJson(join(options.stateDir, 'registration.json'), {
    server_url: original.server_url,
    device_id: original.device_id,
    credential_store: 'file',
    username: 'alice',
    credentials_saved: false,
    fingerprint,
  });
  assert.equal((await registerAgent({ ...options, username: 'alice' })).device_id, original.device_id);
  assert.deepEqual(loadSecrets(options.stateDir, 'file'), keys);
  assert.deepEqual(claims[1], claims[0]);
});

test('explicit registration after a relay restart preserves project setup and reuses device proof after a lost response', async t => {
  let instance = 'instance-a';
  let enrolled = false, dropClaimResponse = false;
  const claims = [];
  const options = await fixture(t, async (req, res, body) => {
    res.setHeader('x-agent-relay-instance', instance);
    if (req.url === '/mcp') {
      if (!enrolled) return json(res, 401, { error: 'UNAUTHORIZED' });
      return json(res, 200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } });
    }
    claims.push({ auth: req.headers.authorization, body });
    enrolled = true;
    if (dropClaimResponse) return req.socket.destroy();
    json(res, 201, { user_id: body.username, device_id: body.device_id });
  });
  const registration = { ...options, username: 'alice' };
  await registerAgent(registration);
  const original = readSettings(options.stateDir);
  original.targets = { project: { cwd: '/project' } };
  saveSettings(options.stateDir, original);
  enrolled = false;
  await assert.rejects(registerAgent(registration), { code: 'DEVICE_REVOKED' });
  assert.equal(claims.length, 1);
  assert.deepEqual(readSettings(options.stateDir), original);

  instance = 'instance-b';
  dropClaimResponse = true;
  await assert.rejects(registerAgent(registration), { code: 'REGISTRATION_UNCONFIRMED' });
  assert.deepEqual(readSettings(options.stateDir), original);
  assert.equal((await registerAgent(registration)).targets_require_setup, true);
  assert.deepEqual(claims, [claims[0], claims[0]]);
  assert.equal(readSettings(options.stateDir).relay_instance_id, instance);
});
