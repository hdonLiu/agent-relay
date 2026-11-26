import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodexAdapter, identifyCall } from './index.js';

function resolveBinary(explicitPath) {
  const search = (process.env.PATH ?? '').split(delimiter)
    .filter(dir => isAbsolute(dir)).map(dir => join(dir, 'codex'));
  if (process.platform === 'darwin') {
    search.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  }
  for (const candidate of explicitPath ? [resolve(explicitPath)] : search) {
    try {
      const binary = realpathSync(candidate);
      if (!statSync(binary).isFile()) continue;
      accessSync(binary, constants.X_OK);
      return binary;
    } catch { /* Try another local installation. */ }
  }
  throw new Error('Could not locate an executable Codex CLI. Supply its absolute path during setup.');
}

function registerMcp({ binary, entry, stateDir, instance = 'codex' }) {
  // Capture the Node and entry paths at install time: a GUI may have a different PATH.
  const result = spawnSync(binary, ['mcp', 'add', 'peer', '--', process.execPath,
    entry, 'mcp', '--state-dir', stateDir, '--adapter', instance], { stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error('Could not register the local Codex MCP tools.');
}

export const codexProvider = { identifyCall, resolveBinary, registerMcp, create: options => new CodexAdapter(options) };
