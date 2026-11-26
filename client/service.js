import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function cmd(bin, args, ignore = false) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20_000 });
  if (!ignore && r.status !== 0)
    throw new Error(
      'Could not configure background service: ' +
        bin +
        ' ' +
        args[0] +
        '. Use daemon in the foreground to diagnose.'
    );
  return r.status;
}
function xml(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function systemdArg(s) {
  if (/[\n\r\0]/.test(s)) throw new Error('Invalid service path');
  return (
    '"' +
    s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') +
    '"'
  );
}
export function installService(stateDir, entry) {
  const name = 'agent-relay-' + createHash('sha256').update(stateDir).digest('hex').slice(0, 12);
  const args = [process.execPath, entry, 'daemon', '--state-dir', stateDir];
  if (platform() === 'darwin') {
    const domain = 'gui/' + process.getuid();
    const label = 'io.github.hdonliu.' + name;
    const path = join(homedir(), 'Library', 'LaunchAgents', label + '.plist');
    const text =
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>' +
      label +
      '</string><key>ProgramArguments</key><array>' +
      args.map((a) => '<string>' + xml(a) + '</string>').join('') +
      '</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardErrorPath</key><string>' +
      xml(join(stateDir, 'daemon.log')) +
      '</string></dict></plist>\n';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode: 0o600 });
    if (cmd('launchctl', ['print', domain + '/' + label], true) === 0)
      cmd('launchctl', ['bootout', domain + '/' + label]);
    cmd('launchctl', ['bootstrap', domain, path]);
    return;
  }
  if (platform() === 'linux') {
    const path = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
      'systemd',
      'user',
      name + '.service'
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '[Unit]\nDescription=Agent Relay device connector\n[Service]\nExecStart=' +
        args.map(systemdArg).join(' ') +
        '\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=default.target\n',
      { mode: 0o600 }
    );
    cmd('systemctl', ['--user', 'daemon-reload']);
    cmd('systemctl', ['--user', 'enable', name + '.service']);
    cmd('systemctl', ['--user', 'restart', name + '.service']);
    return;
  }
  throw new Error('Automatic startup supports macOS and Linux. Use setup --manual on other hosts.');
}
