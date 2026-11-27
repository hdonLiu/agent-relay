import { resolve, join, basename } from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getAdapterType } from './adapters/index.js';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stdin, stderr } from 'node:process';
import {
  saveSettings,
  readSettings,
  saveSecrets,
  loadSecrets,
  hasSecrets,
  relayOrigin,
} from './settings.js';
import { installService } from './service.js';
import { withRegistrationLock } from './registration.js';
import { sessionRefFor } from './connector/store.js';

async function prompt(label, hidden = false) {
  if (!stdin.isTTY)
    throw new Error('Missing ' + label + ' (supply command options for non-interactive setup)');
  stderr.write(label + ': ');
  const muted = new Writable({
    write(chunk, enc, cb) {
      cb();
    },
  });
  const rl = createInterface({ input: stdin, output: hidden ? muted : stderr, terminal: !!stdin.isTTY });
  try {
    return (await rl.question('')).trim();
  } finally {
    rl.close();
    if (hidden) stderr.write('\n');
  }
}
async function request(base, path, method, token, value) {
  const r = await fetch(base + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
  const data = await r.json();
  if (!r.ok)
    throw new Error('Relay setup request failed (' + r.status + '): ' + (data.error || 'unknown error'));
  return data;
}
export async function setup(v, stateDir, entry) {
  if (v.allow !== undefined)
    console.error('The --allow option is ignored. Published projects are shared with members of this relay.');
  return withRegistrationLock(stateDir, () => configureProject(v, stateDir, entry));
}

async function configureProject(v, stateDir, entry) {
  let config = existsSync(join(stateDir, 'config.json')) ? readSettings(stateDir) : null;
  if (!config && existsSync(join(stateDir, 'registration.json'))) {
    throw new Error(
      'Finish the pending register_agent call in your MCP client before setting up a project.'
    );
  }
  const origin = relayOrigin(v.server || config?.server_url || (await prompt('Relay HTTPS origin')));
  if (config && config.server_url !== origin)
    throw new Error('Use a separate state directory for a different relay.');
  const mode = v['credential-store'] || config?.credential_store || 'system';
  if (!['system', 'file'].includes(mode) || (config && mode !== config.credential_store))
    throw new Error('Invalid credential store. Use a separate device directory to change stores.');
  if (!config && hasSecrets(stateDir, mode)) {
    throw new Error(
      'This device directory still has credentials. Restore its config or enroll in a new state directory.'
    );
  }
  const saved = config ? loadSecrets(stateDir, mode) : null;
  const token =
    process.env.AGENT_RELAY_USER_TOKEN ||
    saved?.management_token ||
    (await prompt('Management credential from your relay operator', true));
  const cwd = realpathSync(resolve(v.project || (await prompt('Project directory'))));
  if (!statSync(cwd).isDirectory()) throw new Error('Project must be a directory');
  const adapterName = v.adapter || 'codex';
  const provider = getAdapterType(adapterName);
  const binary = provider.resolveBinary(v['agent-bin'] || config?.adapters?.[adapterName]?.binary);
  // Enrollment is local to this installation. Persist it before publishing any target.
  if (!config) {
    const { code } = await request(origin, '/v1/device-enrollments', 'POST', token, {});
    const device = await request(origin, '/v1/devices/redeem', 'POST', null, { code });
    config = {
      server_url: origin,
      device_id: device.device_id,
      user_id: device.user_id,
      credential_store: mode,
      adapters: {},
      targets: {},
    };
    try {
      saveSecrets(stateDir, mode, { mcp_token: device.mcp_token, device_token: device.device_token });
      saveSettings(stateDir, config);
    } catch (e) {
      await request(
        origin,
        '/v1/devices/' + encodeURIComponent(device.device_id),
        'DELETE',
        token
      ).catch(() => {});
      throw e;
    }
  }
  config.adapters[adapterName] = { binary };
  const alias = v.target || config.user_id + '/' + basename(cwd);
  const native = v['session-id'] || null;
  const prior = Object.entries(config.targets).find(
    ([, t]) =>
      t.alias === alias &&
      t.cwd === cwd &&
      t.adapter === adapterName &&
      (t.native_session_id || null) === native
  );
  const targetId = prior?.[0] || randomUUID();
  const projectId = prior?.[1].project_id || randomUUID();
  const fixed = native
    ? sessionRefFor({ stateDir, config, adapter: adapterName, nativeId: native })
    : null;
  config.targets[targetId] = {
    alias,
    adapter: adapterName,
    project_id: projectId,
    cwd,
    ...(fixed ? { fixed_session_ref: fixed, native_session_id: native } : {}),
  };
  saveSettings(stateDir, config);
  if (!v.manual) {
    provider.registerMcp({
      binary,
      entry,
      stateDir,
      instance: adapterName,
      ...(saved?.management_token ? { serverUrl: origin, credentialStore: mode } : {}),
    });
    installService(stateDir, entry);
  }
  await request(origin, '/v1/targets/' + targetId, 'PUT', token, {
    device_id: config.device_id,
    project_id: projectId,
    alias,
    ...(fixed ? { fixed_session_ref: fixed } : {}),
  });
  console.log('Registered target ' + alias + ' (' + targetId + ') on device ' + config.device_id + '.');
  console.log('When this device is online, other online members of this relay can ask the project.');
  if (v.manual)
    console.log(
      'Manual mode: register the peer stdio MCP entry and start agent-relay daemon using this state directory.'
    );
}
