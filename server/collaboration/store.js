import { digest, fail, id, identifier } from './values.js';
import { Registry } from '../registry/registry.js';

const maxTextBytes = 32 * 1024;
const outcomes = ['answered', 'needs_info', 'needs_owner'];

function fields(args, allowed) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !allowed.includes(key))
  )
    fail('INVALID_ARGUMENTS');
}

function addressName(value) {
  return identifier(identifier(value, 'username').replace(/^@/, ''), 'username').toLowerCase();
}

function parameters(tool, args) {
  if (tool === 'ask_peer') {
    const addresses = ['target', 'username', 'conversation_id'];
    fields(args, [...addresses, 'question']);
    const selected = addresses.filter((key) => Object.hasOwn(args, key));
    if (selected.length !== 1) fail('INVALID_ARGUMENTS');
    const key = selected[0];
    return {
      [key]: key === 'username' ? addressName(args[key]) : identifier(args[key]),
      question: text(args.question),
    };
  }
  if (tool !== 'reply_to_peer') fail('UNKNOWN_TOOL');
  fields(args, ['in_reply_to', 'outcome', 'text']);
  if (!outcomes.includes(args.outcome)) fail('INVALID_ARGUMENTS');
  return { in_reply_to: identifier(args.in_reply_to), outcome: args.outcome, text: text(args.text) };
}

function text(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maxTextBytes)
    fail('INVALID_ARGUMENTS');
  return value;
}

function receipt(message) {
  return { status: 'accepted', conversation_id: message.conversation.id, message_id: message.id };
}

function deliveryError(code, message) {
  return Object.assign(new Error(code), {
    code,
    status: 409,
    conversation_id: message.conversation.id,
    message_id: message.id,
  });
}

export class RelayStore {
  constructor({ ackTimeoutMs = 10_000, maxMessages = 20_000 } = {}) {
    this.ackTimeoutMs = ackTimeoutMs;
    this.maxMessages = maxMessages;
    this.conversations = new Map();
    this.messages = new Map();
    this.requests = new Map();
    this.pending = new Map();
    this.registry = new Registry(
      (targetId, sender) =>
        this.terminate(
          (conversation) =>
            conversation.target.target_id === targetId && conversation.origin.user_id === sender
        ),
      (deviceId) =>
        this.terminate(
          (conversation) =>
            conversation.origin.device_id === deviceId || conversation.target.device_id === deviceId
        )
    );
  }

  register(token, body) {
    return this.registry.register(token, body);
  }
  issueUser(user) {
    return this.registry.issueUser(user);
  }
  userForToken(token) {
    return this.registry.userForToken(token);
  }
  enroll(user) {
    return this.registry.enroll(user);
  }
  redeem(code) {
    return this.registry.redeem(code);
  }
  putTarget(owner, target, body) {
    return this.registry.putTarget(owner, target, body);
  }
  listTargets(owner) {
    return this.registry.listTargets(owner);
  }
  revokeDevice(owner, device) {
    return this.registry.revokeDevice(owner, device);
  }
  deviceForToken(token, scope) {
    return this.registry.deviceForToken(token, scope);
  }

  sharedProjects(user) {
    return this.registry
      .listTargets(user)
      .filter((target) => !target.fixed_session_ref && this.registry.canSend(user, target.target_id));
  }

  targetFor(user, input, live) {
    if (input.target) {
      const target = this.registry.resolveTarget(user, input.target);
      if (!target) fail('TARGET_UNAVAILABLE', 404);
      if (!live.isOnline(target.device_id)) fail('PEER_OFFLINE', 409);
      return target;
    }
    const allowed = this.sharedProjects(user).filter(
      (target) => target.owner_id.toLowerCase() === input.username
    );
    if (!allowed.length) fail('TARGET_UNAVAILABLE', 404);
    const online = allowed.filter((target) => live.isOnline(target.device_id));
    if (!online.length) fail('PEER_OFFLINE', 409);
    if (online.length > 1) {
      const targets = online.map((target) => target.alias ?? target.target_id);
      throw Object.assign(new Error('TARGET_AMBIGUOUS'), { code: 'TARGET_AMBIGUOUS', status: 409, targets });
    }
    return online[0];
  }

  async call(device, tool, args, ctx, live) {
    this.registry.requireDevice(device);
    if (!live.isOnline(device.device_id)) fail('DEVICE_OFFLINE', 409);
    if (tool === 'search_peers') {
      fields(args, ['query']);
      const query = args.query === undefined || args.query === '' ? '' : addressName(args.query);
      return {
        peers: this.sharedProjects(device.user_id)
          .filter((target) => live.isOnline(target.device_id))
          .map((target) => ({
            username: target.owner_id,
            target: target.alias ?? target.target_id,
            target_id: target.target_id,
          }))
          .filter(
            (target) =>
              !query ||
              target.username.toLowerCase().includes(query) ||
              target.target.toLowerCase().includes(query)
          ),
      };
    }
    if (!ctx?.session_ref || !ctx?.request_id) fail('CALL_CONTEXT_UNAVAILABLE');
    const session = identifier(ctx.session_ref);
    const requestId = identifier(ctx.request_id);
    const input = parameters(tool, args);
    const key = JSON.stringify([device.device_id, session, tool, requestId]);
    const hash = digest(JSON.stringify(input));
    const before = this.requests.get(key);
    if (before) {
      if (before.hash !== hash) fail('IDEMPOTENCY_CONFLICT', 409);
      if (before.message?.state === 'enqueued') return receipt(before.message);
      return before.result;
    }

    const request = { key, requestId, hash };
    this.requests.set(key, request);
    request.result = this.route(device, session, input, live, request);
    try {
      return await request.result;
    } finally {
      if (!request.message) this.requests.delete(key);
    }
  }

  async route(device, session, input, live, request) {
    let conversation, destination, route, original;
    if (input.in_reply_to) {
      original = this.messages.get(input.in_reply_to);
      if (!original || original.kind !== 'question' || original.recipient !== device.device_id)
        fail('QUESTION_UNAVAILABLE', 404);
      conversation = original.conversation;
      if (conversation.terminal) fail(conversation.terminal, 409);
      destination = conversation.origin.device_id;
      if (!live.isOnline(destination)) fail('PEER_OFFLINE', 409);
      // The authenticated device announces its chosen session before giving its
      // host the input. Its parallel HTTPS call can arrive before the WSS bind.
      if (!conversation.peerRef && original.binding && !(await original.binding.promise))
        fail(conversation.terminal ?? 'QUESTION_UNAVAILABLE', 409);
      if (conversation.terminal) fail(conversation.terminal, 409);
      if (
        this.conversations.get(conversation.id) !== conversation ||
        conversation.peerRef !== session ||
        original.state === 'failed'
      )
        fail('QUESTION_UNAVAILABLE', 404);
      route = { mode: 'existing', session_ref: conversation.originRef };
    } else {
      if (input.conversation_id) {
        conversation = this.conversations.get(input.conversation_id);
        if (
          !conversation ||
          conversation.origin.device_id !== device.device_id ||
          conversation.originRef !== session
        )
          fail('CONVERSATION_UNAVAILABLE', 404);
        if (conversation.terminal) fail(conversation.terminal, 409);
        if (!conversation.peerRef) fail('BINDING_UNCONFIRMED', 409);
      } else {
        const target = this.targetFor(device.user_id, input, live);
        conversation = {
          id: id(),
          origin: { user_id: device.user_id, device_id: device.device_id },
          originRef: session,
          target,
          peerRef: target.fixed_session_ref ?? null,
          messages: [],
          pending: 0,
          questions: 0,
          replies: 0,
          created: Date.now(),
        };
      }
      destination = conversation.target.device_id;
      route = conversation.peerRef
        ? { mode: 'existing', session_ref: conversation.peerRef }
        : { mode: 'create_if_unbound' };
      Object.assign(route, {
        target_id: conversation.target.target_id,
        project_id: conversation.target.project_id,
      });
    }
    this.registry.requireDevice(device);
    if (!this.registry.canSend(conversation.origin.user_id, conversation.target.target_id))
      fail('ACCESS_REVOKED', 409);
    if (!live.isOnline(device.device_id)) fail('DEVICE_OFFLINE', 409);
    if (!live.isOnline(destination)) fail('PEER_OFFLINE', 409);
    this.makeRoom(conversation);
    const message = {
      id: id(),
      conversation,
      kind: original ? 'reply' : 'question',
      recipient: destination,
      sender: device.device_id,
      requestId: request.requestId,
      requestKey: request.key,
      state: 'sending',
      seq: original ? ++conversation.replies : ++conversation.questions,
      original: original?.id,
      outcome: input.outcome,
    };
    if (!conversation.peerRef) message.binding = Promise.withResolvers();
    // Only retain routing metadata. The frame contents go straight to the current socket.
    const frame = {
      v: 1,
      type: 'deliver',
      message_id: message.id,
      conversation_id: conversation.id,
      seq: message.seq,
      kind: message.kind,
      from_user: device.user_id,
      route,
      text: input.question ?? input.text,
    };
    if (original) Object.assign(frame, { in_reply_to: original.id, outcome: input.outcome });
    request.message = message;
    conversation.messages.push(message);
    conversation.pending++;
    this.conversations.delete(conversation.id);
    this.conversations.set(conversation.id, conversation);
    this.messages.set(message.id, message);
    const waiting = Promise.withResolvers();
    waiting.timer = setTimeout(
      () => this.settle(message, 'unconfirmed', 'DELIVERY_UNCONFIRMED'),
      this.ackTimeoutMs
    );
    this.pending.set(message.id, waiting);
    let unsent;
    try {
      if (!live.send(destination, frame)) unsent = 'PEER_OFFLINE';
    } catch (error) {
      if (error?.code === 'PEER_BUSY') unsent = 'PEER_BUSY';
      else this.settle(message, 'unconfirmed', 'DELIVERY_UNCONFIRMED');
    }
    if (unsent) {
      this.settle(message, 'failed', unsent);
      this.messages.delete(message.id);
      conversation.messages.splice(conversation.messages.indexOf(message), 1);
      if (!conversation.messages.length) this.conversations.delete(conversation.id);
      delete request.message;
    }
    return waiting.promise;
  }

  makeRoom(current) {
    if (this.messages.size < this.maxMessages) return;
    for (const [conversationId, conversation] of this.conversations) {
      if (conversation !== current && !conversation.pending) {
        this.conversations.delete(conversationId);
        for (const message of conversation.messages) {
          this.messages.delete(message.id);
          this.requests.delete(message.requestKey);
        }
        return;
      }
    }
    fail('RELAY_CAPACITY', 503);
  }

  received(device, frame) {
    this.registry.requireDevice(device);
    const message = this.messages.get(identifier(frame.message_id));
    if (!message || message.recipient !== device.device_id) fail('MESSAGE_UNAVAILABLE', 404);
    return message;
  }

  settle(message, state, code) {
    message.state = state;
    message.error = code;
    message.binding?.resolve(state === 'enqueued');
    delete message.binding;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(message.id);
    message.conversation.pending--;
    if (code === 'PEER_OFFLINE' || code === 'PEER_BUSY')
      waiting.reject(Object.assign(new Error(code), { code, status: 409 }));
    else if (code) waiting.reject(deliveryError(code, message));
    else waiting.resolve(receipt(message));
  }

  bind(device, frame) {
    const message = this.received(device, frame);
    if (message.kind !== 'question') fail('INVALID_FRAME');
    if (message.conversation.terminal) return;
    const ref = identifier(frame.bound_session_ref);
    if (message.conversation.peerRef && message.conversation.peerRef !== ref) fail('BINDING_CONFLICT', 409);
    message.conversation.peerRef = ref;
    message.binding?.resolve(true);
    delete message.binding;
  }

  ack(device, frame) {
    const message = this.received(device, frame);
    if (message.conversation.terminal) return { message_id: message.id, status: 'closed' };
    if (message.kind === 'question') this.bind(device, frame);
    else if (frame.bound_session_ref !== message.conversation.originRef) fail('BINDING_CONFLICT', 409);
    this.settle(message, 'enqueued');
    return { message_id: message.id, status: 'enqueued' };
  }

  report(device, frame) {
    const message = this.received(device, frame);
    const reportId = identifier(frame.report_id);
    const code = identifier(frame.code);
    if (!/^[A-Z][A-Z0-9_]{0,95}$/.test(code)) fail('INVALID_FRAME');
    if (!message.conversation.terminal && message.state !== 'enqueued') {
      const uncertain = /UNCERTAIN|UNCONFIRMED/.test(code);
      this.settle(message, uncertain ? 'unconfirmed' : 'failed', uncertain ? 'DELIVERY_UNCONFIRMED' : code);
      if (['THREAD_UNAVAILABLE', 'SESSION_UNAVAILABLE', 'ACCESS_REVOKED'].includes(code)) {
        this.terminate((conversation) => conversation === message.conversation, code);
      }
    }
    return { v: 1, type: 'report_ack', report_id: reportId };
  }

  disconnected(deviceId) {
    for (const messageId of this.pending.keys()) {
      const message = this.messages.get(messageId);
      if (message.sender === deviceId || message.recipient === deviceId)
        this.settle(message, 'unconfirmed', 'DELIVERY_UNCONFIRMED');
    }
  }

  terminate(matches, code = 'ACCESS_REVOKED') {
    for (const conversation of this.conversations.values()) {
      if (!matches(conversation)) continue;
      conversation.terminal = code;
      for (const message of conversation.messages)
        if (this.pending.has(message.id)) this.settle(message, 'unconfirmed', code);
    }
  }

  listConversations(user, query = {}) {
    return [...this.conversations.values()]
      .filter(
        (conversation) =>
          (conversation.origin.user_id === user || conversation.target.owner_id === user) &&
          (!query.device_id || conversation.origin.device_id === query.device_id) &&
          (!query.session_ref || conversation.originRef === query.session_ref) &&
          (!query.request_id ||
            conversation.messages.some(
              (message) =>
                message.requestId === query.request_id &&
                (message.kind === 'question' ? conversation.origin.user_id : conversation.target.owner_id) ===
                  user
            ))
      )
      .map((conversation) => ({
        conversation_id: conversation.id,
        target_id: conversation.target.target_id,
        closed_reason: conversation.terminal ?? null,
        created_at: conversation.created,
      }))
      .sort((a, b) => b.created_at - a.created_at);
  }

  getConversation(user, conversationId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || (conversation.origin.user_id !== user && conversation.target.owner_id !== user))
      fail('CONVERSATION_UNAVAILABLE', 404);
    return {
      conversation_id: conversation.id,
      target_id: conversation.target.target_id,
      closed_reason: conversation.terminal ?? null,
      messages: conversation.messages.map((message) => ({
        message_id: message.id,
        seq: message.seq,
        kind: message.kind,
        in_reply_to: message.original ?? null,
        outcome: message.outcome ?? null,
        state: message.state,
        code: message.error ?? null,
      })),
    };
  }

  close() {
    for (const messageId of this.pending.keys())
      this.settle(this.messages.get(messageId), 'unconfirmed', 'DELIVERY_UNCONFIRMED');
    this.messages.clear();
    this.requests.clear();
    this.conversations.clear();
    this.registry = new Registry();
  }
}
