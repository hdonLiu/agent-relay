import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const defaultStateDir = () =>
  resolve(process.env.AGENT_RELAY_HOME || join(homedir(), '.agent-relay'));
export function prepareDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error('State directory must belong to you and have mode 0700: ' + dir);
}
export function saveJson(file, value) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(tmp, file);
}
export function loadJson(file) {
  const st = lstatSync(file);
  if (!st.isFile() || st.mode & 0o077 || (process.getuid && st.uid !== process.getuid()))
    throw new Error('Unsafe file permissions: ' + file);
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function readSettings(dir) {
  return loadJson(join(dir, 'config.json'));
}
export function saveSettings(dir, config) {
  saveJson(join(dir, 'config.json'), config);
}
function account(dir) {
  return createHash('sha256').update(resolve(dir)).digest('hex');
}
function run(bin, args, input) {
  const r = spawnSync(bin, args, { input, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0 || r.error)
    throw new Error(
      'Credential store unavailable (' +
        bin +
        '). On a headless machine explicitly select --credential-store file.'
    );
  return r.stdout.trim();
}
// Only an explicit "no matching item" authorizes first-use credential creation.
// Capture all keyring output locally. secret-tool search can include item values.
export function hasSecrets(dir, mode) {
  if (mode === 'file') {
    try {
      lstatSync(join(dir, 'secrets.json'));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  if (mode !== 'system') throw new Error('Unknown credential store');
  const mac = platform() === 'darwin';
  if (!mac && platform() !== 'linux') throw new Error('Unsupported credential store');
  const args = mac
    ? ['find-generic-password', '-s', 'agent-relay', '-a', account(dir)]
    : ['search', '--all', 'service', 'agent-relay', 'account', account(dir)];
  const result = spawnSync(mac ? '/usr/bin/security' : 'secret-tool', args, {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (!result.error && mac && result.status === 44) return false; // errSecItemNotFound
  if (result.error || result.status !== 0) throw new Error('Credential store unavailable');
  if (mac) return true;
  // secret-tool prints item metadata on stdout and matching attributes on stderr.
  if (result.stdout.trim()) return true;
  if (result.stderr.trim()) throw new Error('Credential store lookup incomplete');
  return false;
}
export function saveSecrets(dir, mode, secrets) {
  if (mode === 'file') return saveJson(join(dir, 'secrets.json'), secrets);
  const value = Buffer.from(JSON.stringify(secrets)).toString('base64url');
  if (mode !== 'system') throw new Error('credential-store must be system or file');
  if (platform() === 'darwin') {
    // Interactive input keeps the secret out of the process argument list.
    run(
      '/usr/bin/security',
      ['-i'],
      'add-generic-password -U -s agent-relay -a ' + account(dir) + ' -w ' + value + '\n'
    );
    const saved = loadSecrets(dir, mode);
    if (Object.keys(secrets).some((key) => saved[key] !== secrets[key]))
      throw new Error('Keychain did not save the device credentials');
  } else if (platform() === 'linux') {
    run(
      'secret-tool',
      ['store', '--label=Agent Relay device', 'service', 'agent-relay', 'account', account(dir)],
      value
    );
  } else throw new Error('A system credential store is unavailable on this platform');
}
export function loadSecrets(dir, mode) {
  if (mode === 'file') return loadJson(join(dir, 'secrets.json'));
  const args =
    platform() === 'darwin'
      ? ['/usr/bin/security', ['find-generic-password', '-s', 'agent-relay', '-a', account(dir), '-w']]
      : ['secret-tool', ['lookup', 'service', 'agent-relay', 'account', account(dir)]];
  return JSON.parse(Buffer.from(run(...args), 'base64url').toString('utf8'));
}
export function relayOrigin(input) {
  const u = new URL(input);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/')
    throw new Error('Supply only the HTTPS origin of the relay');
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
  )
    throw new Error('Public relay connections require HTTPS');
  return u.origin;
}
