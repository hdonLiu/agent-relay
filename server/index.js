#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { RelayStore } from './collaboration/store.js';
import { createRelayServer } from './http.js';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      db: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command = 'serve', user] = positionals;
  if (values.help) {
    console.log(
      'agent-relay-server serve [--db PATH] [--host 127.0.0.1] [--port 8787] [--tls-cert CERT.pem --tls-key KEY.pem]\nagent-relay-server issue-user USER [--db PATH]'
    );
    return;
  }
  if (
    !['serve', 'issue-user'].includes(command) ||
    positionals.length > (command === 'serve' ? 1 : 2) ||
    (command === 'issue-user' && !user)
  )
    throw new Error('Invalid command. Use --help.');
  process.umask(0o077);
  const path = resolve(
    values.db || process.env.RELAY_DB || join(homedir(), '.agent-relay-server', 'relay.sqlite')
  );
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const store = new RelayStore(path);
  if (command === 'issue-user') {
    try {
      console.log(store.issueUser(user));
    } finally {
      store.close();
    }
    return;
  }
  const port = Number(values.port ?? process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if (Boolean(values['tls-cert']) !== Boolean(values['tls-key']))
    throw new Error('Supply both TLS certificate and key.');
  const tls = values['tls-cert']
    ? { cert: readFileSync(values['tls-cert']), key: readFileSync(values['tls-key']) }
    : undefined;
  const relay = createRelayServer({ store, tls });
  const address = await relay.listen(port, values.host || process.env.RELAY_HOST || '127.0.0.1');
  console.error('Agent Relay listening on ' + address.address + ':' + address.port);
  let closing = false;
  async function stop() {
    if (closing) return;
    closing = true;
    await relay.close();
    store.close();
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
