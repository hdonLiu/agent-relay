#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultStateDir, prepareDir, readSettings, loadSecrets } from './settings.js';
import { setup } from './setup.js';
import { startDaemon } from './connector/daemon.js';
import { runMcp } from './mcp/index.js';
import { getAdapterType } from './adapters/index.js';

async function main() {
  const {
    values: v,
    positionals: [command, ...rest],
  } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'state-dir': { type: 'string' },
      server: { type: 'string' },
      project: { type: 'string' },
      target: { type: 'string' },
      allow: { type: 'string', multiple: true },
      manual: { type: 'boolean' },
      adapter: { type: 'string' },
      'credential-store': { type: 'string' },
      'session-id': { type: 'string' },
      'agent-bin': { type: 'string' },
    },
  });
  if (!command || v.help) {
    console.log(
      'agent-relay setup [--server HTTPS_ORIGIN] [--project DIR] [--adapter NAME] [--agent-bin PATH] [--target ALIAS] [--session-id NATIVE_ID] [--manual] [--credential-store system|file]\nagent-relay mcp [--server HTTPS_ORIGIN] [--credential-store system|file] [--adapter codex]\nagent-relay daemon\nAll commands accept --state-dir DIR. Pass --server to mcp to enable username and device registration.'
    );
    return;
  }
  if (rest.length) throw new Error('Unexpected positional arguments.');
  const stateDir = resolve(v['state-dir'] || defaultStateDir());
  if (command === 'setup') return setup(v, stateDir, realpathSync(process.argv[1]));
  if (command === 'mcp') return runMcp({
    stateDir, adapterName: v.adapter || 'codex', serverUrl: v.server, credentialStore: v['credential-store'],
  });
  if (command !== 'daemon') throw new Error('Unknown command. Use --help.');
  prepareDir(stateDir);
  const config = readSettings(stateDir);
  const { mcp_token, device_token } = loadSecrets(stateDir, config.credential_store);
  Object.assign(config, { mcp_token, device_token });
  const adapters = {};
  for (const [name, options] of Object.entries(config.adapters)) {
    let provider;
    try {
      provider = getAdapterType(name);
    } catch {
      console.error('Unavailable local adapter: ' + name);
      continue;
    }
    adapters[name] = provider.create(options);
  }
  const instance = await startDaemon({ stateDir, config, adapters });
  let closing = false;
  async function stop() {
    if (!closing) {
      closing = true;
      await instance.close();
    }
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
