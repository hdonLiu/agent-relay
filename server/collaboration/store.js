import { Database, digest, fail, id, identifier } from './db.js';
import { Registry } from '../registry/registry.js';
import { Mailbox } from '../delivery/mailbox.js';

const maxTextBytes = 32 * 1024;

function parameters(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_ARGUMENTS');
  const question = tool === 'ask_peer';
  if (!question && tool !== 'reply_to_peer') fail('UNKNOWN_TOOL');
  const allowed = question ? ['target', 'conversation_id', 'question'] : ['in_reply_to', 'outcome', 'text'];
  if (Object.keys(input).some(key => !allowed.includes(key))) fail('INVALID_ARGUMENTS');
  const body = input[question ? 'question' : 'text'];
  if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body) > maxTextBytes) fail('INVALID_ARGUMENTS');
  if (question) {
    if (('target' in input) === ('conversation_id' in input)) fail('INVALID_ARGUMENTS');
    const key = 'target' in input ? 'target' : 'conversation_id';
    return { [key]: identifier(input[key], key), question: body };
  }
  if (!['answered', 'needs_info', 'needs_owner'].includes(input.outcome)) fail('INVALID_ARGUMENTS');
  return { in_reply_to: identifier(input.in_reply_to), outcome: input.outcome, text: body };
}

export class RelayStore {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.mailbox = new Mailbox(this.db);
    this.registry = new Registry(this.db, (c, reason) => this.mailbox.terminate(c, reason));
  }

  register(managementToken, body) { return this.registry.register(managementToken, body); }
  issueUser(userId) { return this.registry.issueUser(userId); }
  userForToken(token) { return this.registry.userForToken(token); }
  enroll(userId) { return this.registry.enroll(userId); }
  redeem(code) { return this.registry.redeem(code); }
  deviceForToken(token, scope) { return this.registry.deviceForToken(token, scope); }
  putTarget(owner, target, body) { return this.registry.putTarget(owner, target, body); }
  listTargets(owner) { return this.registry.listTargets(owner); }
  revokeDevice(owner, device) { return this.registry.revokeDevice(owner, device); }
  close() { this.db.close(); }

  pending(deviceId, cutoffMs) { return this.mailbox.pending(deviceId, cutoffMs); }
  ack(device, frame) {
    this.registry.requireDevice(device);
    if (!frame || frame.v !== 1 || frame.type !== 'ack') fail('INVALID_FRAME');
    return this.mailbox.ack(device, frame);
  }
  report(device, frame) {
    this.registry.requireDevice(device);
    if (!frame || frame.v !== 1 || frame.type !== 'report') fail('INVALID_FRAME');
    return this.mailbox.report(device, frame);
  }

  call(device, tool, args, ctx) {
    this.registry.requireDevice(device);
    if (!ctx?.session_ref || !ctx?.request_id) fail('CALL_CONTEXT_UNAVAILABLE');
    const session = identifier(ctx.session_ref, 'session_ref');
    const request = identifier(ctx.request_id, 'request_id');
    const input = parameters(tool, args);
    const hash = digest(JSON.stringify(input));
    return this.db.transaction(() => {
      const existing = this.db.get(`SELECT id,conversation,payload_hash FROM messages
        WHERE sender=? AND sender_ref=? AND tool=? AND request_id=?`, device.device_id, session, tool, request);
      if (existing) {
        if (existing.payload_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 409);
        return { status: 'accepted', conversation_id: existing.conversation, message_id: existing.id };
      }
      const call = { sender: device.device_id, senderRef: session, tool, requestId: request, hash };
      if (tool === 'ask_peer') {
        const c = input.target ? this.start(device, session, input.target) :
          this.db.get('SELECT * FROM conversations WHERE id=? AND origin_device=? AND origin_ref=?',
            input.conversation_id, device.device_id, session);
        if (!c) fail('CONVERSATION_UNAVAILABLE', 404);
        if (c.terminal) fail(c.terminal, 409);
        return this.mailbox.append(c, { ...call, kind: 'question', recipient: c.peer_device, text: input.question });
      }
      const source = this.db.get(`SELECT * FROM messages WHERE id=? AND kind='question'
        AND recipient=? AND attempted IS NOT NULL`, input.in_reply_to, device.device_id);
      if (!source) fail('QUESTION_UNAVAILABLE', 404);
      const c = this.db.get('SELECT * FROM conversations WHERE id=?', source.conversation);
      if (c.terminal) fail(c.terminal, 409);
      if (c.peer_ref && c.peer_ref !== session) fail('QUESTION_UNAVAILABLE', 404);
      return this.mailbox.append(c, { ...call, kind: 'reply', recipient: c.origin_device, destination: c.origin_ref,
        original: source.id, text: input.text, outcome: input.outcome, state: c.peer_ref ? 'pending' : 'waiting_binding' });
    });
  }

  start(device, session, address) {
    const t = this.db.get(`SELECT t.* FROM targets t JOIN devices d ON d.id=t.device JOIN grants g ON g.target=t.id
      WHERE (t.id=? OR t.alias=?) AND g.sender=? AND g.active=1 AND d.revoked=0`, address, address, device.user_id);
    if (!t) fail('TARGET_UNAVAILABLE', 404);
    const conversation = id();
    this.db.run(`INSERT INTO conversations(id,target,origin_device,origin_ref,peer_device,peer_ref,created)
      VALUES(?,?,?,?,?,?,?)`, conversation, t.id, device.device_id, session, t.device, t.fixed_ref, Date.now());
    return this.db.get('SELECT * FROM conversations WHERE id=?', conversation);
  }

  listConversations(user, query = {}) {
    const clauses = ['(a.owner=? OR b.owner=?)'];
    const args = [user, user];
    for (const [key, column] of [['device_id','c.origin_device'],['session_ref','c.origin_ref']]) {
      if (query[key]) { clauses.push(`${column}=?`); args.push(identifier(query[key], key)); }
    }
    if (query.request_id) {
      clauses.push(`EXISTS(SELECT 1 FROM messages m JOIN devices s ON s.id=m.sender
        WHERE m.conversation=c.id AND m.request_id=? AND s.owner=?)`);
      args.push(identifier(query.request_id), user);
    }
    return this.db.all(`SELECT c.id AS conversation_id,c.target AS target_id,c.terminal AS closed_reason,c.created AS created_at
      FROM conversations c JOIN devices a ON a.id=c.origin_device JOIN devices b ON b.id=c.peer_device
      WHERE ${clauses.join(' AND ')} ORDER BY c.created DESC,c.id`, ...args);
  }

  getConversation(user, conversation) {
    const c = this.db.get(`SELECT c.*,a.owner AS a,b.owner AS b FROM conversations c JOIN devices a ON a.id=c.origin_device
      JOIN devices b ON b.id=c.peer_device WHERE c.id=? AND (a.owner=? OR b.owner=?)`, conversation, user, user);
    if (!c) fail('CONVERSATION_UNAVAILABLE', 404);
    // A read-only diagnostic view. The mailbox content is delivered over the authenticated device channel.
    const messages = this.db.all(`SELECT id AS message_id,seq,kind,original AS in_reply_to,outcome,state,error AS code
      FROM messages WHERE conversation=? AND (kind<>'reply' OR sender_ref=?) ORDER BY created,rowid`,
      conversation, c.peer_ref);
    return { conversation_id: c.id, target_id: c.target, closed_reason: c.terminal, messages };
  }
}
