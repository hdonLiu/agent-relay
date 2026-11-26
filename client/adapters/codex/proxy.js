import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';

export function hostError(code, message, submission = 'unknown', retryable = false) {
  return Object.assign(new Error(message), { code, submission, retryable });
}

// The Codex CLI proxy transparently forwards bytes to its private Unix socket.
// The daemon speaks WebSocket on that socket. createConnection supplies the
// process pipes for the HTTP upgrade, so the URL never opens a TCP connection.
export class AppServerProxy {
  #child;
  #ws;
  #ready;
  #nextId = 0;
  #requests = new Map();
  #closed = false;

  constructor({ binary = 'codex', start = () => spawn(binary, ['app-server', 'proxy'], {
    shell: false, stdio: ['pipe', 'pipe', 'ignore'],
  }), timeout = 30_000 } = {}) {
    this.start = start;
    this.timeout = timeout;
  }

  async #connect() {
    const child = this.start();
    const pipe = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const ws = new WebSocket('ws://localhost/', {
      createConnection: () => pipe, perMessageDeflate: false, handshakeTimeout: this.timeout,
    });
    this.#ws = ws;
    this.#child = child;
    const disconnected = () => this.#disconnect(ws);
    child.once('error', disconnected);
    child.once('exit', disconnected);
    pipe.on('error', disconnected);
    ws.on('error', disconnected);
    ws.once('close', disconnected);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('close', () => reject(hostError('HOST_UNAVAILABLE', 'The Codex proxy disconnected during handshake.')));
    });
    ws.on('message', raw => {
      if (this.#ws !== ws) return;
      let message;
      try { message = JSON.parse(raw); } catch { this.#disconnect(ws); return; }
      // Server requests (including local approvals) are the owner's to resolve.
      // Server and client can use overlapping request IDs.
      if (!message || message.method || !Object.hasOwn(message, 'id')) return;
      const pending = this.#requests.get(message.id);
      if (!pending) return;
      this.#requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = hostError('HOST_RPC_ERROR', 'Codex rejected the local request.');
        error.rpcCode = message.error.code;
        error.rpcMessage = String(message.error.message ?? '');
        pending.reject(error);
      } else if (Object.hasOwn(message, 'result')) {
        pending.resolve(message.result);
      } else {
        pending.reject(hostError('HOST_PROTOCOL_ERROR', 'Codex returned a malformed response.'));
      }
    });
    await this.#request(ws, 'initialize', {
      clientInfo: { name: 'agent-relay', version: '0.1.0' }, capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: 'initialized' }));
    return ws;
  }

  #disconnect(ws) {
    if (this.#ws !== ws) return;
    this.#ws = undefined;
    this.#ready = undefined;
    for (const p of this.#requests.values()) {
      clearTimeout(p.timer);
      p.reject(hostError('HOST_UNAVAILABLE', 'The local Codex connection closed.', 'unknown', true));
    }
    this.#requests.clear();
    ws.terminate();
    this.#child.kill();
    this.#child = undefined;
  }

  #request(ws, method, params) {
    if (ws !== this.#ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(hostError('HOST_UNAVAILABLE', 'The Codex proxy is disconnected.', 'not_submitted', true));
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(id);
        reject(hostError('HOST_TIMEOUT', 'No response from the local Codex daemon.', 'unknown', true));
      }, this.timeout);
      this.#requests.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }), error => { if (error) this.#disconnect(ws); });
    });
  }

  async call(method, params) {
    if (this.#closed) throw hostError('HOST_UNAVAILABLE', 'The Codex adapter is closed.', 'not_submitted', true);
    const ready = this.#ready ??= this.#connect();
    let ws;
    try { ws = await ready; } catch {
      if (this.#ready === ready) {
        if (this.#ws) this.#disconnect(this.#ws);
        this.#ready = undefined;
      }
      throw hostError('HOST_UNAVAILABLE', 'Could not initialize the local Codex proxy.', 'not_submitted', true);
    }
    return this.#request(ws, method, params);
  }

  close() {
    this.#closed = true;
    if (this.#ws) this.#disconnect(this.#ws);
  }
}
