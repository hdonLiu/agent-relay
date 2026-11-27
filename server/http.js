import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolsList } from '../protocol.js';
import serverPackage from './package.json' with { type: 'json' };

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

async function handleMcp(req, res, store, device, live) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  }
  const rpc = await body(req);
  const mcp = new Server({ name: 'agent-relay', version: serverPackage.version }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsList }));
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const result = await store.call(
        device,
        params.name,
        params.arguments || {},
        params._meta?.['peer.example/context'],
        live
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      };
    } catch (e) {
      const code = errorCode(e);
      const status = e.status || 500;
      const result = { code, retryable: status >= 500 || status === 429 };
      if (e.message_id) result.message_id = e.message_id;
      if (e.conversation_id) result.conversation_id = e.conversation_id;
      if (code === 'TARGET_AMBIGUOUS') result.targets = e.targets;
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
export function createRelayServer({ store, heartbeatMs = 30_000, tls }) {
  const instanceId = randomUUID();
  const online = new Map();
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxBody,
    perMessageDeflate: false,
  });
  function connectionFor(deviceId) {
    const connection = online.get(deviceId);
    if (connection?.ws.readyState !== WebSocket.OPEN || Date.now() - connection.pong > heartbeatMs * 2)
      return;
    return connection;
  }
  const live = {
    isOnline: (deviceId) => Boolean(connectionFor(deviceId)),
    send(deviceId, frame) {
      const connection = connectionFor(deviceId);
      if (!connection) return false;
      const ws = connection.ws;
      if (ws.bufferedAmount > maxBody * 16) throw fail(409, 'PEER_BUSY');
      ws.send(JSON.stringify(frame), (error) => {
        if (error) ws.terminate();
      });
      return true;
    },
  };
  function remove(connection) {
    if (online.get(connection.device.device_id) !== connection) return;
    online.delete(connection.device.device_id);
    store.disconnected(connection.device.device_id);
  }
  const handler = async (req, res) => {
    res.setHeader('x-agent-relay-instance', instanceId);
    try {
      const url = new URL(req.url, 'http://relay.invalid');
      const path = url.pathname;
      // The relay has no cookie/browser API. Reject cross-origin web requests.
      if (
        req.headers.origin &&
        (!URL.canParse(req.headers.origin) || new URL(req.headers.origin).host !== req.headers.host)
      )
        throw fail(403, 'ORIGIN_DENIED');
      if (path === '/health' && req.method === 'GET')
        return json(res, 200, { status: 'ok', instance_id: instanceId });
      const token = bearer(req);
      if (path === '/mcp') {
        const device = store.deviceForToken(token, 'mcp');
        if (!authenticatesDevice(device, req)) throw fail(401, 'UNAUTHORIZED');
        return await handleMcp(req, res, store, device, live);
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
      if (path === '/v1/targets' && req.method === 'GET') {
        const owned = store.listTargets().filter((target) => target.owner_id === owner);
        return json(
          res,
          200,
          owned.map(({ fixed_session_ref, ...target }) => target)
        );
      }
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
          return json(res, 200, value ?? { target_id: id });
        }
        if (match[1] === 'conversations' && req.method === 'GET')
          return json(res, 200, store.getConversation(owner, id));
        if (match[1] === 'devices' && req.method === 'DELETE') {
          store.revokeDevice(owner, id);
          const connection = online.get(id);
          if (connection) {
            remove(connection);
            connection.ws.close(1008, 'device revoked');
          }
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
      const c = { ws, device, pong: Date.now() };
      const prior = online.get(device.device_id);
      if (prior) {
        remove(prior);
        prior.ws.close(1000, 'connection replaced');
      }
      online.set(device.device_id, c);
      ws.on('error', () => {});
      ws.on('pong', () => {
        c.pong = Date.now();
      });
      ws.on('close', () => remove(c));
      ws.on('message', (data, binary) => {
        let f;
        try {
          if (binary || online.get(device.device_id) !== c || !store.deviceForToken(token, 'device'))
            throw fail(403, 'INVALID_CONNECTION');
          f = JSON.parse(data.toString());
          if (f?.v !== 1) throw fail(400, 'UNSUPPORTED_VERSION');
          if (f.type === 'bind') {
            store.bind(device, f);
          } else if (f.type === 'ack') {
            store.ack(device, f);
            ws.send(JSON.stringify({ v: 1, type: 'ack_ok', message_id: f.message_id }));
          } else if (f.type === 'report') ws.send(JSON.stringify(store.report(device, f)));
          else throw fail(400, 'UNKNOWN_FRAME');
        } catch (error) {
          // A late receipt can outlive the routing record. Finish the exchange
          // without recreating a message or disturbing other live deliveries.
          if (error.code === 'MESSAGE_UNAVAILABLE') {
            if (f.type === 'ack')
              ws.send(JSON.stringify({ v: 1, type: 'ack_ok', message_id: f.message_id }));
            if (f.type === 'report')
              ws.send(JSON.stringify({ v: 1, type: 'report_ack', report_id: f.report_id }));
          } else ws.close(1008, 'invalid delivery response');
        }
      });
    });
  });
  const timer = setInterval(() => {
    for (const c of online.values()) {
      if (Date.now() - c.pong > heartbeatMs * 2) c.ws.terminate();
      else c.ws.ping();
    }
  }, heartbeatMs);
  timer.unref();
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
      for (const c of online.values()) {
        remove(c);
        c.ws.terminate();
      }
      wsServer.close();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}
