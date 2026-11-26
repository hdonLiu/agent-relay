import http from 'node:http';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolsList } from '../../protocol.js';
import { getAdapterType } from '../adapters/index.js';
import { registerAgent, RegistrationError } from '../registration.js';
import { relayOrigin } from '../settings.js';

const registrationTool = {
  name: 'register_agent',
  description: 'Register this device on the configured relay when its owner chooses a username. ' +
    'Repeat with the same username to confirm registration.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['username'],
    properties: {
      username: {
        type: 'string',
        description: '2–32 ASCII letters, digits, underscores or hyphens, starting with a letter. An initial @ is optional.',
      },
    },
  },
};

function failure(code, detail) {
  return {
    isError: true, content: [{ type: 'text', text: detail }], structuredContent: { code },
  };
}

function daemonCall(socketPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    let written = false;
    const lost = () => {
      const code = written && body.tool !== 'search_peers' ? 'DELIVERY_UNCONFIRMED' : 'CONNECTOR_UNAVAILABLE';
      reject(Object.assign(new Error(code), { code }));
    };
    const req = http.request({
      socketPath, method: 'POST', path: '/call', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 512 * 1024) {
          res.destroy(new Error('Oversized daemon result.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', lost);
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Array.isArray(result?.content) ||
              (res.statusCode >= 400 && result.isError !== true)) {
            throw new Error('Invalid daemon result.');
          }
          resolve(result);
        } catch {
          lost();
        }
      });
    });
    req.setTimeout(35_000, () => req.destroy(new Error('Local relay timed out.')));
    req.on('error', lost);
    req.end(payload, () => { written = true; });
  });
}

export async function runMcp({
  stateDir, adapterName = 'codex', serverUrl, credentialStore, transport = new StdioServerTransport(),
}) {
  const provider = getAdapterType(adapterName);
  const registrationOrigin = serverUrl === undefined ? undefined : relayOrigin(serverUrl);
  if (credentialStore !== undefined && !['system', 'file'].includes(credentialStore)) {
    throw new Error('Use --credential-store system or file.');
  }
  const localTools = registrationOrigin ? [...toolsList, registrationTool] : toolsList;
  const server = new Server({ name: 'agent-relay', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: localTools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = localTools.find(t => t.name === params.name);
    if (!tool) return failure('UNKNOWN_TOOL', 'Unknown agent relay tool.');
    const args = params.arguments ?? {};
    if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) {
      return failure('INVALID_ARGUMENTS', 'Unexpected tool argument. Use only the published business fields.');
    }
    if (tool === registrationTool) {
      try {
        const registration = await registerAgent({
          stateDir, serverUrl: registrationOrigin, credentialStore, username: args.username, adapterName,
        });
        const detail = registration.targets_require_setup
          ? ' Publish the local project again with setup and explicitly choose its allowed senders.'
          : '';
        return {
          content: [{ type: 'text', text: 'Registered @' + registration.user_id + ' on this device.' + detail }],
          structuredContent: registration,
        };
      } catch (error) {
        if (error instanceof RegistrationError) return failure(error.code, error.message);
        return failure('REGISTRATION_FAILED', 'Unable to register this device.');
      }
    }
    let origin;
    try { origin = provider.identifyCall(params._meta); } catch {
      return failure('CALL_CONTEXT_UNAVAILABLE', 'The host did not identify the originating session or tool call.');
    }
    try {
      return await daemonCall(path.join(stateDir, 'relay.sock'), {
        adapter: adapterName, ...origin, tool: tool.name, arguments: args,
      });
    } catch (error) {
      // A lost response may follow a committed operation. A new tool invocation
      // creates a new call ID and must not be suggested as an automatic retry.
      if (error.code === 'DELIVERY_UNCONFIRMED')
        return failure(error.code, 'The connection closed before delivery was confirmed. Check the conversation before sending again.');
      return failure('CONNECTOR_UNAVAILABLE', 'The local relay daemon is unavailable. Check its status.');
    }
  });
  await server.connect(transport);
  return server;
}
