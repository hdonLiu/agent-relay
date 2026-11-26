import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { prepareDir, relayOrigin } from '../settings.js';
import { LocalStore, failure, lockDirectory } from './store.js';
import { InboundDelivery } from './inbound.js';
import { OutboundCalls, toolError } from './outbound.js';
import { deviceStream } from './device-stream.js';

async function removeSocket(path) {
  try {
    if (!(await fs.lstat(path)).isSocket()) throw failure('IPC_PATH_OCCUPIED');
    await fs.unlink(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function readInput(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 192 * 1024) throw failure('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw failure('INVALID_JSON'); }
}

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
}

export async function startDaemon({ config, stateDir, adapters, onError = code => console.error('[agent-relay]', code) }) {
  const url = new URL(relayOrigin(config.server_url));
  for (const field of ['device_id', 'device_token', 'mcp_token']) {
    if (typeof config[field] !== 'string' || !config[field]) throw failure('INVALID_DEVICE_CONFIG');
  }
  prepareDir(stateDir);
  const unlock = lockDirectory(stateDir);
  const socketPath = join(stateDir, 'relay.sock');
  const abort = new AbortController();
  const tracked = new Set();
  let store, inbound, server, stream, timer, closing, socketBound = false, stop = false;
  function watch(promise) {
    tracked.add(promise);
    promise.catch(() => { if (!stop) onError('LOCAL_OPERATION_FAILED'); }).finally(() => tracked.delete(promise));
  }

  async function shutDown() {
    stop = true;
    clearInterval(timer);
    abort.abort();
    stream?.close();
    inbound?.stop();
    try {
      let closed;
      if (server?.listening) {
        closed = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
      }
      await Promise.allSettled(Object.values(adapters).map(adapter => Promise.resolve().then(() => adapter.close?.())));
      await Promise.allSettled([...tracked]);
      await closed;
      if (socketBound) await removeSocket(socketPath);
    } finally {
      try { store?.close(); } finally { unlock(); }
    }
  }

  try {
    store = new LocalStore(stateDir, config);
    const outbound = new OutboundCalls(store, adapters, url, config, abort.signal);
    inbound = new InboundDelivery(store, config.targets ?? {}, adapters, frame => stream.send(frame));
    let draining = false;
    async function recover() {
      if (stop || draining) return;
      draining = true;
      try {
        for (const frame of store.recoveryAcks()) stream.send(frame);
        for (const frame of store.pendingReports()) stream.send(frame);
        for (const frame of store.uncertainFrames()) {
          if (stop) return;
          watch(inbound.receive(frame, true));
        }
        for (const item of store.pendingCalls()) {
          if (stop) return;
          const result = await outbound.send(item);
          // A single offline request should not produce one failed network
          // connection per persisted item each time the network drops.
          if (result?.structuredContent?.local_status === 'awaiting_confirmation') return;
        }
      } finally { draining = false; }
    }

    stream = deviceStream({
      url, token: config.device_token, deviceId: config.device_id, onError,
      onOpen: () => watch(recover()),
      onFrame(frame) {
        if (frame.type === 'ack_ok' && typeof frame.message_id === 'string') store.confirmAck(frame.message_id);
        if (frame.type === 'report_ack' && typeof frame.report_id === 'string') store.confirmReport(frame.report_id);
        if (frame.type === 'deliver') watch(inbound.receive(frame));
      }
    });
    server = createServer((req, res) => {
      const reply = (status, body) => {
        if (!res.destroyed) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      if (req.method !== 'POST' || req.url !== '/call') return reply(404, toolError('NOT_FOUND'));
      // No inbound web-facing listener. The directory mode and socket permissions
      // confine this endpoint to the OS account that owns the device credentials.
      if (req.headers.origin) return reply(403, toolError('ORIGIN_FORBIDDEN'));
      const operation = (async () => {
        try { reply(200, await outbound.local(await readInput(req))); }
        catch (error) { reply(400, toolError(error.code || 'INVALID_REQUEST')); }
      })();
      watch(operation);
    });
    await removeSocket(socketPath);
    await listen(server, socketPath);
    socketBound = true;
    await fs.chmod(socketPath, 0o600);
    stream.start();
    timer = setInterval(() => watch(recover()), 10_000);
    watch(recover());
    return { close() { return closing ??= shutDown(); } };
  } catch (error) {
    await shutDown();
    throw error;
  }
}
