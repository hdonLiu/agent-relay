import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import { relayOrigin } from '../client/settings.js';

// The simulated host uses the same public registration, MCP and device protocols as a real peer.
export async function registerPeer(origin, username) {
  origin = relayOrigin(origin);
  const token = () => randomBytes(32).toString('base64url');
  const ownerToken = token(),
    mcpToken = token(),
    deviceToken = token();
  const deviceId = randomUUID(),
    projectId = randomUUID(),
    targetId = randomUUID();

  async function manage(method, path, body) {
    const res = await fetch(new URL(path, origin), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: 'Bearer ' + ownerToken, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await res.json();
    assert.ok(res.ok, method + ' ' + path + ': ' + (payload.error ?? res.status));
    return payload;
  }

  const registered = await manage('POST', '/v1/registrations', {
    username,
    device_id: deviceId,
    mcp_token: mcpToken,
    device_token: deviceToken,
  });
  assert.deepEqual(registered, { user_id: username, device_id: deviceId });
  const mcp = new Client({ name: 'agent-relay-e2e-peer', version: '1' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', origin), {
      requestInit: {
        redirect: 'error',
        headers: { authorization: 'Bearer ' + mcpToken, 'x-agent-relay-device-id': deviceId },
      },
    })
  );

  const frames = [];
  const awaitingAck = new Map();
  const inboundSessions = new Map();
  const outboundQuestions = new Map();
  const originSessions = new Set();
  let ws, fault;

  function sessionFor(frame) {
    return frame.kind === 'question' ? inboundSessions.get(frame.conversation_id) : frame.route.session_ref;
  }

  function onMessage(body) {
    const frame = JSON.parse(body.toString());
    assert.equal(frame.v, 1);
    if (frame.type === 'ack_ok') {
      const delivered = awaitingAck.get(frame.message_id);
      assert.ok(delivered, 'Unexpected acknowledgement');
      awaitingAck.delete(frame.message_id);
      frames.push(delivered);
      return;
    }
    assert.equal(frame.type, 'deliver');
    if (frame.kind === 'question') {
      assert.equal(frame.route.project_id, projectId);
      assert.equal(frame.route.target_id, targetId);
      if (frame.route.mode === 'create_if_unbound') {
        assert.ok(!inboundSessions.has(frame.conversation_id), 'Conversation was recreated');
        const ref = 'mock-' + randomUUID();
        inboundSessions.set(frame.conversation_id, ref);
        ws.send(
          JSON.stringify({ v: 1, type: 'bind', message_id: frame.message_id, bound_session_ref: ref })
        );
      } else {
        assert.equal(frame.route.mode, 'existing');
        assert.ok(inboundSessions.has(frame.conversation_id), 'No bound simulated session');
        assert.equal(frame.route.session_ref, sessionFor(frame));
      }
    } else {
      assert.equal(frame.kind, 'reply');
      assert.equal(frame.route.mode, 'existing');
      assert.ok(originSessions.has(frame.route.session_ref), 'Reply missed the originating mock session');
      // A very fast reply may precede the HTTP acceptance of its question.
      const originRef = outboundQuestions.get(frame.in_reply_to);
      if (originRef) assert.equal(frame.route.session_ref, originRef);
    }
    awaitingAck.set(frame.message_id, frame);
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'ack',
        message_id: frame.message_id,
        bound_session_ref: sessionFor(frame),
      })
    );
  }

  return {
    username,
    frames,
    sessionFor,
    publish() {
      return manage('PUT', '/v1/targets/' + targetId, {
        device_id: deviceId,
        project_id: projectId,
        alias: username + '/project',
      });
    },
    async connect() {
      const url = new URL('/v1/device-stream', origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(url, {
        handshakeTimeout: 5_000,
        headers: { authorization: 'Bearer ' + deviceToken, 'x-agent-relay-device-id': deviceId },
      });
      ws.on('error', (error) => {
        fault = error;
      });
      ws.on('message', (body) => {
        try {
          onMessage(body);
        } catch (error) {
          fault = error;
          ws.terminate();
        }
      });
      await once(ws, 'open');
    },
    async call(tool, args, sessionRef = 'mock-origin') {
      if (fault) throw fault;
      if (tool === 'ask_peer') originSessions.add(sessionRef);
      const result = await mcp.callTool({
        name: tool,
        arguments: args,
        _meta: { 'peer.example/context': { session_ref: sessionRef, request_id: randomUUID() } },
      });
      if (result.isError)
        throw Object.assign(new Error(result.structuredContent.code), result.structuredContent);
      if (tool === 'ask_peer') outboundQuestions.set(result.structuredContent.message_id, sessionRef);
      return result.structuredContent;
    },
    async waitFor(predicate, timeoutMs = 15_000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (fault) throw fault;
        const matched = frames.find(predicate);
        if (matched) return matched;
        if (ws?.readyState !== WebSocket.OPEN) throw new Error('Mock peer device stream closed');
        await delay(30);
      }
      throw new Error('Timed out waiting for an acknowledged delivery on the mock peer');
    },
    async close() {
      try {
        if (ws && ws.readyState !== WebSocket.CLOSED) {
          const closed = once(ws, 'close');
          ws.close();
          await closed;
        }
      } finally {
        await mcp.close();
      }
    },
  };
}
