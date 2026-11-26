import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
for (const component of ['server', 'client']) {
  const outfile = component + '/dist/index.js';
  await build({
    entryPoints: [component + '/index.js'],
    outfile,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    bundle: true,
    packages: 'external',
  });
  await chmod(outfile, 0o755);
}
