// Public MCP tools shared by the local stdio and cloud HTTP endpoints.
export const toolsList = [
  {
    name: 'ask_peer',
    description:
      'Ask another authorized agent for help. On first contact use target. For follow-ups or additional context use the original conversation_id. The answer arrives asynchronously in this conversation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        target: { type: 'string', minLength: 1, description: 'Authorized recipient target ID or alias' },
        conversation_id: { type: 'string', minLength: 1 },
        question: { type: 'string', minLength: 1 },
      },
      oneOf: [{ required: ['target'] }, { required: ['conversation_id'] }],
    },
  },
  {
    name: 'reply_to_peer',
    description:
      'Return an answer or a request for clarification to the agent that asked this exact question. Use the original inbound question message_id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['in_reply_to', 'outcome', 'text'],
      properties: {
        in_reply_to: { type: 'string', minLength: 1 },
        outcome: { type: 'string', enum: ['answered', 'needs_info', 'needs_owner'] },
        text: { type: 'string', minLength: 1 },
      },
    },
  },
];
