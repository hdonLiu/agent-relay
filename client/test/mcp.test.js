import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runMcp } from '../mcp/index.js';

test('local MCP lists two tools, forwards host-bound identity, rejects model-supplied routing', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'peer-mcp-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const requests = [];
  const daemon = http.createServer(async (req, res) => {
    assert.equal(req.url, '/call');
    let text = '';
    for await (const part of req) text += part;
    requests.push(JSON.parse(text));
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'accepted' }],
      structuredContent: { status: 'accepted', conversation_id: 'C1', message_id: 'M1' } }));
  });
  await new Promise(resolve => daemon.listen(join(stateDir, 'relay.sock'), resolve));
  t.after(() => new Promise(resolve => daemon.close(resolve)));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await runMcp({ stateDir, transport: serverTransport });
  const client = new Client({ name: 'isolated-test-host', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(clientTransport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['ask_peer', 'reply_to_peer']);
  const arguments_ = { target: 'bob/app', question: 'Minimum version?' };
  const accepted = await client.callTool({
    name: 'ask_peer', arguments: arguments_, _meta: { threadId: 'A', callId: 'R', 'peer.example/context': { session_ref: 'spoofed' } },
  });
  assert.equal(accepted.structuredContent.message_id, 'M1');
  assert.deepEqual(requests[0], { adapter: 'codex', native_session_id: 'A', native_call_id: 'R', tool: 'ask_peer', arguments: arguments_ });
  const rejected = await client.callTool({ name: 'ask_peer', arguments: arguments_ });
  assert.equal(rejected.structuredContent.code, 'CALL_CONTEXT_UNAVAILABLE');
  const spoofed = await client.callTool({ name: 'ask_peer', arguments: { ...arguments_, session_ref: 'spoofed' }, _meta: { threadId: 'A', callId: 'R2' } });
  assert.equal(spoofed.structuredContent.code, 'INVALID_ARGUMENTS');
  assert.equal(requests.length, 1);
});
