import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
  hasSecrets,
  loadJson,
  loadSecrets,
  prepareDir,
  readSettings,
  relayOrigin,
  saveJson,
  saveSecrets,
  saveSettings,
} from './settings.js';

const messages = {
  INVALID_USERNAME:
    'Choose a username of 2 to 32 letters, digits, underscores or hyphens, starting with a letter.',
  RELAY_SERVER_REQUIRED: 'Configure the relay origin in the local MCP launcher with --server.',
  INVALID_RELAY_ORIGIN: 'Use an HTTPS relay origin, or HTTP on loopback for development.',
  RELAY_ORIGIN_MISMATCH: 'This device directory belongs to a different relay.',
  CREDENTIAL_STORE_MISMATCH: 'Use the credential store associated with this device directory.',
  INVALID_CREDENTIAL_STORE: 'Use the system credential store or explicitly configure file storage.',
  CREDENTIAL_STORE_UNAVAILABLE:
    'Could not read or save the local device credentials. Check the configured credential store.',
  LOCAL_CREDENTIALS_EXIST:
    'The credential store already contains an identity for this directory. Restore its configuration or use a different state directory.',
  LOCAL_IDENTITY_MISMATCH: 'This device directory is already registered to another username.',
  REGISTRATION_PENDING: 'Retry registration with the original username to confirm its outcome.',
  REGISTRATION_BUSY:
    'Another process is updating the local device registration. Retry when it finishes.',
  USERNAME_TAKEN: 'This username has already been claimed. Choose another username.',
  DEVICE_REVOKED: 'The relay rejected this device credential. Restore access with the relay operator.',
  REGISTRATION_CREDENTIAL_CHANGED:
    'The relay management credential has changed. Contact the relay operator.',
  REGISTRATION_CONFLICT:
    'The relay rejected this installation identity. Check the registered device with the relay operator.',
  REGISTRATION_UNCONFIRMED:
    'The relay has not confirmed registration. Retry with the same username and state directory.',
  REGISTRATION_REJECTED: 'The relay rejected the registration request.',
  REGISTRATION_FAILED:
    'Could not complete registration. Check the state directory and relay configuration.',
};

export class RegistrationError extends Error {
  constructor(code) {
    super(messages[code]);
    this.code = code;
  }
}

const reject = (code) => {
  throw new RegistrationError(code);
};

// The MCP and interactive setup can run in different processes. SQLite releases
// this lock on process exit; the short async wait also works within one process.
export async function withRegistrationLock(stateDir, operation) {
  prepareDir(stateDir);
  const db = new DatabaseSync(join(stateDir, 'registration-lock.sqlite'));
  const deadline = Date.now() + 25_000;
  try {
    db.exec('PRAGMA busy_timeout=0;');
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE;');
        break;
      } catch (err) {
        if (err.errcode !== 5) throw err;
        if (Date.now() >= deadline) reject('REGISTRATION_BUSY');
        await delay(80);
      }
    }
    return await operation();
  } finally {
    db.close();
  }
}

function usernameFor(input) {
  const value = typeof input === 'string' ? input.trim().replace(/^@/, '') : '';
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/.test(value)) reject('INVALID_USERNAME');
  return value.toLowerCase();
}

function originFor(input, saved) {
  if (!input && !saved) reject('RELAY_SERVER_REQUIRED');
  let origin;
  try {
    origin = relayOrigin(input ?? saved);
  } catch {
    reject('INVALID_RELAY_ORIGIN');
  }
  if (saved && saved !== origin) reject('RELAY_ORIGIN_MISMATCH');
  return origin;
}

function credentialOperation(operation) {
  try {
    return operation();
  } catch {
    reject('CREDENTIAL_STORE_UNAVAILABLE');
  }
}

async function post(url, headers, body) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return { response, data };
  } catch {
    reject('REGISTRATION_UNCONFIRMED');
  }
}

async function confirmExisting(config, secrets) {
  if (!secrets?.mcp_token) reject('CREDENTIAL_STORE_UNAVAILABLE');
  const id = randomUUID();
  const { response, data } = await post(
    config.server_url + '/mcp',
    {
      authorization: 'Bearer ' + secrets.mcp_token,
      'x-agent-relay-device-id': config.device_id,
      accept: 'application/json, text/event-stream',
    },
    {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'agent-relay-device', version: '1' },
      },
    }
  );
  if (response.status === 401 || response.status === 403) reject('DEVICE_REVOKED');
  if (!response.ok || data?.id !== id || typeof data.result?.protocolVersion !== 'string')
    reject('REGISTRATION_UNCONFIRMED');
  return { user_id: config.user_id, device_id: config.device_id, status: 'registered' };
}

async function register({ stateDir, serverUrl, credentialStore }, username) {
  const intentFile = join(stateDir, 'registration.json');
  const config = existsSync(join(stateDir, 'config.json')) ? readSettings(stateDir) : undefined;
  const journal = !config && existsSync(intentFile) ? loadJson(intentFile) : undefined;
  // A crash during credential creation precedes any HTTP request. The owner may
  // choose a different store/name, e.g. file storage on a headless machine.
  const intent = journal?.credentials_saved ? journal : undefined;
  const saved = config ?? intent;
  const origin = originFor(serverUrl, saved?.server_url);
  const mode = credentialStore ?? saved?.credential_store ?? 'system';
  if (!['system', 'file'].includes(mode)) reject('INVALID_CREDENTIAL_STORE');
  if (saved && mode !== saved.credential_store) reject('CREDENTIAL_STORE_MISMATCH');
  if (config) {
    if (config.user_id.toLowerCase() !== username) reject('LOCAL_IDENTITY_MISMATCH');
    return confirmExisting(
      config,
      credentialOperation(() => loadSecrets(stateDir, mode))
    );
  }
  if (intent?.username && intent.username !== username) reject('REGISTRATION_PENDING');
  const matchingJournal = journal?.server_url === origin && journal.credential_store === mode;
  const pending = matchingJournal
    ? journal
    : {
        server_url: origin,
        device_id: randomUUID(),
        credential_store: mode,
        credentials_saved: false,
      };
  pending.username = username;

  // Only a non-secret fingerprint is journaled before storing the credentials.
  // This also identifies our own incomplete write after a process crash.
  const fingerprint = (keys) =>
    createHash('sha256')
      .update(JSON.stringify([keys.management_token, keys.mcp_token, keys.device_token]))
      .digest('hex');
  if (!pending.credentials_saved) {
    if (credentialOperation(() => hasSecrets(stateDir, mode))) {
      if (!pending.fingerprint) reject('LOCAL_CREDENTIALS_EXIST');
      const stored = credentialOperation(() => loadSecrets(stateDir, mode));
      if (pending.fingerprint !== fingerprint(stored)) reject('LOCAL_CREDENTIALS_EXIST');
    } else {
      const token = () => randomBytes(32).toString('base64url');
      const keys = { management_token: token(), mcp_token: token(), device_token: token() };
      pending.fingerprint = fingerprint(keys);
      saveJson(intentFile, pending);
      credentialOperation(() => saveSecrets(stateDir, mode, keys));
    }
    pending.credentials_saved = true;
  }
  // After this write a request may have reached the cloud. A retry must use
  // exactly the same credentials, username and device ID.
  saveJson(intentFile, pending);
  const secrets = credentialOperation(() => loadSecrets(stateDir, mode));
  if (pending.fingerprint && fingerprint(secrets) !== pending.fingerprint)
    reject('LOCAL_CREDENTIALS_EXIST');
  if (
    ![secrets.management_token, secrets.mcp_token, secrets.device_token].every(
      (key) => typeof key === 'string' && key.length === 43
    )
  ) {
    reject('CREDENTIAL_STORE_UNAVAILABLE');
  }
  const { response, data } = await post(
    origin + '/v1/registrations',
    { authorization: 'Bearer ' + secrets.management_token },
    {
      username,
      device_id: pending.device_id,
      mcp_token: secrets.mcp_token,
      device_token: secrets.device_token,
    }
  );
  if (response.status === 409 && data?.error === 'USERNAME_TAKEN') {
    pending.username = null;
    saveJson(intentFile, pending);
    reject('USERNAME_TAKEN');
  }
  if (
    response.status === 403 &&
    ['DEVICE_REVOKED', 'REGISTRATION_CREDENTIAL_CHANGED'].includes(data?.error)
  )
    reject(data.error);
  if (response.status === 409 && data?.error === 'REGISTRATION_CONFLICT')
    reject('REGISTRATION_CONFLICT');
  if (!response.ok && response.status < 500) reject('REGISTRATION_REJECTED');
  if (!response.ok || data?.user_id !== username || data.device_id !== pending.device_id)
    reject('REGISTRATION_UNCONFIRMED');
  saveSettings(stateDir, {
    server_url: origin,
    device_id: data.device_id,
    user_id: data.user_id,
    credential_store: mode,
    adapters: {},
    targets: {},
  });
  rmSync(intentFile, { force: true });
  return { user_id: data.user_id, device_id: data.device_id, status: 'registered' };
}

export async function registerAgent(options) {
  try {
    const username = usernameFor(options.username);
    return await withRegistrationLock(options.stateDir, () => register(options, username));
  } catch (error) {
    if (error instanceof RegistrationError) throw error;
    throw new RegistrationError('REGISTRATION_FAILED');
  }
}
