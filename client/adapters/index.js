import { codexProvider } from './codex/provider.js';

// A provider owns all host-specific configuration, call identity and session I/O.
const providers = new Map([['codex', codexProvider]]);

export function getAdapterType(name) {
  const provider = providers.get(name);
  if (!provider) throw new Error('Unsupported local agent adapter.');
  return provider;
}
