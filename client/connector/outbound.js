import { randomUUID } from 'node:crypto';
import { failure } from './store.js';

export function toolError(code, retryable = false) {
  return {
    isError: true,
    structuredContent: { code, retryable },
    content: [{ type: 'text', text: code }]
  };
}

class RelayMcp {
  constructor(url, config, signal) {
    this.url = new URL('/mcp', url);
    this.token = config.mcp_token;
    this.deviceId = config.device_id;
    this.signal = signal;
    this.version = '2025-11-25';
    this.initialization = null;
  }

  async post(message, notification = false) {
    const response = await fetch(this.url, {
      method: 'POST', redirect: 'error',
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
      headers: {
        authorization: 'Bearer ' + this.token, 'x-agent-relay-device-id': this.deviceId, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': this.version
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...message })
    });
    if (!response.ok) {
      await response.body?.cancel();
      // A request rejected on its size/type can never succeed by replay. It
      // must not remain at the front of the device's offline outbox.
      if (message.method === 'tools/call' && [400, 413, 415, 422].includes(response.status)) {
        const code = response.status === 413 ? 'REQUEST_TOO_LARGE' : 'CLOUD_REQUEST_REJECTED';
        throw Object.assign(failure(code), { rejected: true });
      }
      const code = response.status === 401 || response.status === 403 ? 'CLOUD_AUTH_FAILED' : 'CLOUD_HTTP_ERROR';
      throw failure(code, response.status >= 500 || response.status === 429);
    }
    if (notification) { await response.body?.cancel(); return; }
    const reply = await response.json();
    if (reply.jsonrpc !== '2.0' || reply.id !== message.id || reply.error || !reply.result) {
      throw failure('CLOUD_PROTOCOL_ERROR');
    }
    return reply.result;
  }

  async initialize() {
    const result = await this.post({
      id: randomUUID(), method: 'initialize', params: {
        protocolVersion: this.version, capabilities: {}, clientInfo: { name: 'agent-relay-device', version: '1' }
      }
    });
    if (!['2025-11-25', '2025-06-18', '2025-03-26'].includes(result.protocolVersion)) {
      throw failure('CLOUD_PROTOCOL_VERSION');
    }
    this.version = result.protocolVersion;
    await this.post({ method: 'notifications/initialized' }, true);
  }

  async call(item) {
    this.initialization ??= this.initialize().catch(error => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
    const result = await this.post({
      id: randomUUID(), method: 'tools/call', params: {
        name: item.tool, arguments: JSON.parse(item.args),
        _meta: { 'peer.example/context': { session_ref: item.ref, request_id: item.id } }
      }
    });
    if (!Array.isArray(result.content)) throw failure('CLOUD_PROTOCOL_ERROR');
    return result;
  }
}

export class OutboundCalls {
  constructor(store, adapters, url, config, signal) {
    this.store = store;
    this.adapters = adapters;
    this.cloud = new RelayMcp(url, config, signal);
    this.active = new Map();
  }

  local(input) {
    const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
    if (!input || !validId(input.adapter) || !Object.hasOwn(this.adapters, input.adapter)
      || !validId(input.native_session_id) || (input.native_call_id != null && !validId(input.native_call_id))
      || !['ask_peer', 'reply_to_peer'].includes(input.tool) || !input.arguments
      || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
      return toolError('CALL_CONTEXT_UNAVAILABLE');
    }
    const session = this.store.mapSession(input.adapter, input.native_session_id);
    const item = this.store.outboxItem(session.ref, input.native_call_id ?? randomUUID(), input.tool, input.arguments);
    return this.send(item);
  }

  send(item) {
    if (item.result) return Promise.resolve(JSON.parse(item.result));
    let task = this.active.get(item.id);
    if (task) return task;
    task = this.transmit(item).finally(() => this.active.delete(item.id));
    this.active.set(item.id, task);
    return task;
  }

  async transmit(item) {
    try {
      const result = await this.cloud.call(item);
      if (!(result.isError && result.structuredContent?.retryable)) {
        this.store.saveResult(item.id, result);
      }
      return result;
    } catch (error) {
      // The relay may have committed before a transport break. The persisted
      // request ID is reused on every retry, including after process restart.
      const code = typeof error.code === 'string' ? error.code : 'CLOUD_UNREACHABLE';
      if (error.rejected) {
        const result = toolError(code);
        this.store.saveResult(item.id, result);
        return result;
      }
      const detail = code === 'CLOUD_AUTH_FAILED'
        ? 'The relay rejected the configured device credential. Check the device registration.'
        : 'Cloud acceptance has not been confirmed.';
      return {
        isError: true,
        structuredContent: { code, local_status: 'awaiting_confirmation', request_id: item.id },
        content: [{ type: 'text', text: detail + ' The connector will retry this saved request. Keep its request ID: ' + item.id }]
      };
    }
  }
}
