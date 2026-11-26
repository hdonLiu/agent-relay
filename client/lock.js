import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Both utilities acquire flock(2) on an inherited open file description.
// Closing our descriptor or exiting the process releases the lock. Keeping
// the file in place ensures contenders always lock the same inode.
export function tryLock(directory, name) {
  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'linux') throw new Error('The connector supports macOS and Linux');
  const fd = openSync(join(directory, name + '.lock'), 'a', 0o600);
  const result = spawnSync(mac ? '/usr/bin/lockf' : 'flock', mac ? ['-s', '-t', '0', '3'] : ['--nonblock', '3'],
    { stdio: ['ignore', 'ignore', 'ignore', fd] });
  if (result.status === 0) return () => closeSync(fd);
  closeSync(fd);
  if (result.error) throw result.error;
  if (result.status === (mac ? 75 : 1)) return null;
  throw new Error('Cannot acquire ' + name + ' lock');
}
