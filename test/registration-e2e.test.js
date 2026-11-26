import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RelayStore } from '../server/collaboration/store.js';
import { createRelayServer } from '../server/http.js';

const cli = resolve('client/index.js');
const run = promisify(execFile);

test('a fresh stdio MCP registers a username and device, then setup publishes its project with the stored identity', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-signup-'));
  let store = new RelayStore();
  let relay = createRelayServer({ store });
  const { port } = await relay.listen(0);
  const origin = 'http://127.0.0.1:' + port;
  const clients = new Set();
  t.after(async () => {
    await Promise.allSettled([...clients].map((client) => client.close()));
    await relay.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(state) {
    const client = new Client({ name: 'owner', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, 'mcp', '--state-dir', state, '--server', origin, '--credential-store', 'file'],
        stderr: 'pipe',
      })
    );
    clients.add(client);
    return client;
  }
  const claim = (client, username) => client.callTool({ name: 'register_agent', arguments: { username } });
  const state = join(dir, 'alice');
  const first = await connect(state);
  const names = (await first.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('register_agent'));
  assert.equal(existsSync(join(state, 'config.json')), false);
  const registered = await claim(first, '@Alice');
  assert.notEqual(registered.isError, true);
  const identity = registered.structuredContent;
  assert.deepEqual(Object.keys(identity).sort(), ['device_id', 'status', 'user_id']);
  assert.equal(identity.user_id, 'alice');
  assert.equal(identity.status, 'registered');
  assert.ok(identity.device_id);

  const config = JSON.parse(readFileSync(join(state, 'config.json'), 'utf8'));
  const secrets = JSON.parse(readFileSync(join(state, 'secrets.json'), 'utf8'));
  for (const value of Object.values(secrets)) {
    assert.ok(value && !JSON.stringify(registered).includes(value));
    assert.ok(!JSON.stringify(config).includes(value));
  }
  assert.equal(store.userForToken(secrets.management_token), 'alice');
  assert.equal(store.deviceForToken(secrets.mcp_token, 'mcp').device_id, identity.device_id);

  await first.close();
  clients.delete(first);
  const reopened = await connect(state);
  assert.deepEqual((await claim(reopened, 'alice')).structuredContent, identity);
  const second = await connect(join(dir, 'other'));
  const conflict = await claim(second, 'alice');
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.code, 'USERNAME_TAKEN');
  assert.equal((await claim(second, 'bob')).structuredContent.user_id, 'bob');

  const project = join(dir, 'service-project');
  mkdirSync(project);
  await run(
    process.execPath,
    [
      cli,
      'setup',
      '--state-dir',
      state,
      '--manual',
      '--project',
      project,
      '--target',
      'alice/service',
      '--allow',
      'bob',
      '--agent-bin',
      process.execPath,
    ],
    {
      env: { ...process.env, AGENT_RELAY_USER_TOKEN: '' },
    }
  );
  const [target] = store.listTargets('bob');
  assert.equal(target.device_id, identity.device_id);
  assert.equal(target.alias, 'alice/service');

  // An empty replacement instance at the same address has no owners, grants or chats.
  const oldInstance = (await (await fetch(origin + '/health')).json()).instance_id;
  await relay.close();
  store.close();
  store = new RelayStore();
  relay = createRelayServer({ store });
  await relay.listen(port);
  const newInstance = (await (await fetch(origin + '/health')).json()).instance_id;
  assert.notEqual(newInstance, oldInstance);
  assert.equal(store.userForToken(secrets.management_token), null);
  assert.deepEqual(store.listTargets('bob'), []);
  assert.deepEqual((await claim(reopened, 'alice')).structuredContent, {
    ...identity,
    targets_require_setup: true,
  });
  assert.equal((await claim(second, 'bob')).structuredContent.user_id, 'bob');
  assert.deepEqual(store.listTargets('bob'), []);

  const publish = [
    cli,
    'setup',
    '--state-dir',
    state,
    '--manual',
    '--project',
    project,
    '--target',
    'alice/service',
    '--agent-bin',
    process.execPath,
  ];
  const options = { env: { ...process.env, AGENT_RELAY_USER_TOKEN: '' } };
  await run(process.execPath, publish, options);
  assert.deepEqual(store.listTargets('bob'), []);
  await run(process.execPath, [...publish, '--allow', 'bob'], options);
  assert.equal(store.listTargets('bob')[0].device_id, identity.device_id);

  // A partially restored state must not replace the only copy of the owner credential.
  rmSync(join(state, 'config.json'));
  await assert.rejects(
    run(
      process.execPath,
      [
        cli,
        'setup',
        '--state-dir',
        state,
        '--server',
        origin,
        '--manual',
        '--credential-store',
        'file',
        '--project',
        project,
        '--agent-bin',
        process.execPath,
      ],
      {
        env: { ...process.env, AGENT_RELAY_USER_TOKEN: secrets.management_token },
      }
    ),
    /still has credentials/
  );
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'secrets.json'), 'utf8')), secrets);
});
