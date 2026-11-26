import http from 'node:http';
import https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolsList } from '../protocol.js';

const maxBody = 128 * 1024;
function fail(status, code) {
  return Object.assign(new Error(code), { status, code });
}
function bearer(req) {
  return /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1] || '';
}
// Refuse credentials restored from a different device than the local ledger.
function authenticatesDevice(device, req) {
  const expected = req.headers['x-agent-relay-device-id'];
  return Boolean(device && (expected === undefined || expected === device.device_id));
}
function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    throw fail(415, 'JSON_REQUIRED');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw fail(413, 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw fail(400, 'INVALID_JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'OBJECT_REQUIRED');
  return value;
}
function errorCode(e) {
  return typeof e.code === 'string' && Number.isInteger(e.status) ? e.code : 'INTERNAL_ERROR';
}

async function handleMcp(req, res, store, device, notify) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  }
  const rpc = await body(req);
  const mcp = new Server({ name: 'agent-relay', version: '0.1.0' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsList }));
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const result = store.call(
        device,
        params.name,
        params.arguments || {},
        params._meta?.['peer.example/context']
      );
      notify();
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      };
    } catch (e) {
      const code = errorCode(e);
      const status = e.status || 500;
      const result = { code, retryable: status >= 500 || status === 429 };
      return { content: [{ type: 'text', text: code }], structuredContent: result, isError: true };
    }
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.once('close', () => {
    void mcp.close().catch(() => {});
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, rpc);
}

// API access is bearer-only. The deployment reverse proxy terminates public TLS.
export function createRelayServer({ store, retryMs = 30_000, heartbeatMs = 30_000, tls }) {
  const online = new Map();
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxBody,
    perMessageDeflate: false,
  });
  function flush(connection) {
    const { ws, device } = connection;
    if (ws.readyState !== WebSocket.OPEN || online.get(device.device_id) !== connection) return;
    if (!store.deviceForToken(connection.token, 'device')) return ws.close(1008, 'device revoked');
    if (ws.bufferedAmount > maxBody * 16) return;
    const cutoff = connection.fresh ? undefined : Date.now() - retryMs;
    connection.fresh = false;
    for (const frame of store.pending(device.device_id, cutoff)) ws.send(JSON.stringify(frame));
  }
  function safeFlush(c) {
    try {
      flush(c);
    } catch {
      c.ws.close(1011, 'delivery unavailable');
    }
  }
  let scheduled = false;
  function notify() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const c of online.values()) safeFlush(c);
    });
  }
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://relay.invalid');
      const path = url.pathname;
      // The relay has no cookie/browser API. Reject cross-origin web requests.
      if (
        req.headers.origin &&
        (!URL.canParse(req.headers.origin) || new URL(req.headers.origin).host !== req.headers.host)
      )
        throw fail(403, 'ORIGIN_DENIED');
      if (path === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
      const token = bearer(req);
      if (path === '/mcp') {
        const device = store.deviceForToken(token, 'mcp');
        if (!authenticatesDevice(device, req)) throw fail(401, 'UNAUTHORIZED');
        return await handleMcp(req, res, store, device, notify);
      }
      if (path === '/v1/registrations' && req.method === 'POST') {
        if (!token) throw fail(401, 'UNAUTHORIZED');
        return json(res, 200, store.register(token, await body(req)));
      }
      if (path === '/v1/devices/redeem' && req.method === 'POST') {
        const data = await body(req);
        return json(res, 201, store.redeem(data.code));
      }
      const owner = store.userForToken(token);
      if (!owner) throw fail(401, 'UNAUTHORIZED');
      if (path === '/v1/device-enrollments' && req.method === 'POST')
        return json(res, 201, store.enroll(owner));
      if (path === '/v1/targets' && req.method === 'GET')
        return json(res, 200, store.listTargets(owner));
      if (path === '/v1/conversations' && req.method === 'GET')
        return json(res, 200, store.listConversations(owner, Object.fromEntries(url.searchParams)));
      const match = /^\/v1\/(devices|targets|conversations)\/([^/]+)$/.exec(path);
      if (match) {
        let id;
        try {
          id = decodeURIComponent(match[2]);
        } catch {
          throw fail(400, 'INVALID_PATH');
        }
        if (match[1] === 'targets' && req.method === 'PUT') {
          const value = store.putTarget(owner, id, await body(req));
          notify();
          return json(res, 200, value ?? { target_id: id });
        }
        if (match[1] === 'conversations' && req.method === 'GET')
          return json(res, 200, store.getConversation(owner, id));
        if (match[1] === 'devices' && req.method === 'DELETE') {
          store.revokeDevice(owner, id);
          notify();
          return json(res, 200, { revoked: true });
        }
      }
      throw fail(404, 'NOT_FOUND');
    } catch (e) {
      if (!res.headersSent) return json(res, e.status || 500, { error: errorCode(e) });
      res.end();
    }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.requestTimeout = 30_000;
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (req.url !== '/v1/device-stream' || req.headers.origin)
      return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    const token = bearer(req),
      device = store.deviceForToken(token, 'device');
    if (!authenticatesDevice(device, req))
      return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      const c = { ws, device, token, fresh: true, pong: Date.now() };
      const prior = online.get(device.device_id);
      online.set(device.device_id, c);
      prior?.ws.close(1000, 'connection replaced');
      ws.on('error', () => {});
      ws.on('pong', () => {
        c.pong = Date.now();
      });
      ws.on('close', () => {
        if (online.get(device.device_id) === c) online.delete(device.device_id);
      });
      ws.on('message', (data, binary) => {
        try {
          if (binary || online.get(device.device_id) !== c || !store.deviceForToken(token, 'device'))
            throw fail(403, 'INVALID_CONNECTION');
          const f = JSON.parse(data.toString());
          if (f?.v !== 1) throw fail(400, 'UNSUPPORTED_VERSION');
          if (f.type === 'ack') {
            store.ack(device, f);
            ws.send(JSON.stringify({ v: 1, type: 'ack_ok', message_id: f.message_id }));
          } else if (f.type === 'report') ws.send(JSON.stringify(store.report(device, f)));
          else throw fail(400, 'UNKNOWN_FRAME');
          notify();
        } catch {
          ws.close(1008, 'invalid delivery response');
        }
      });
      safeFlush(c);
    });
  });
  const timer = setInterval(() => {
    for (const c of online.values()) {
      if (Date.now() - c.pong > heartbeatMs * 2) c.ws.terminate();
      else c.ws.ping();
    }
  }, heartbeatMs);
  timer.unref();
  const redeliver = setInterval(notify, Math.max(25, Math.min(retryMs, 5000)));
  redeliver.unref();
  return {
    server,
    async listen(port = 8787, host = '127.0.0.1') {
      await new Promise((ok, no) => {
        server.once('error', no);
        server.listen(port, host, () => {
          server.off('error', no);
          ok();
        });
      });
      return server.address();
    },
    async close() {
      clearInterval(timer);
      clearInterval(redeliver);
      for (const c of online.values()) c.ws.terminate();
      wsServer.close();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}
