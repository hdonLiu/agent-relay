import { digest, fail, id, identifier } from '../collaboration/db.js';

export class Mailbox {
  constructor(db) { this.db = db; }

  append(c, { sender = null, senderRef = null, recipient, destination = null, kind, original = null,
    outcome = null, text, state = 'pending', error = null, tool = null, requestId = null, hash = null }) {
    const message = id();
    const { seq } = this.db.get('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE conversation=? AND recipient=?',
      c.id, recipient);
    this.db.run(`INSERT INTO messages(id,conversation,seq,sender,sender_ref,recipient,destination_ref,
      kind,original,outcome,body,state,error,tool,request_id,payload_hash,created)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, message, c.id, seq,
    sender, senderRef, recipient, destination, kind, original, outcome, text, state, error,
    tool, requestId, hash, Date.now());
    return { status: 'accepted', conversation_id: c.id, message_id: message };
  }

  notice(c, original, code, recipient = c.origin_device, destination = c.origin_ref) {
    if (!destination || !this.db.get('SELECT 1 FROM devices WHERE id=? AND revoked=0', recipient)) return;
    if (this.db.get("SELECT 1 FROM messages WHERE kind='status' AND original=? AND error=?", original, code)) return;
    this.append(c, { recipient, destination, kind: 'status', original, error: code,
      text: `Delivery status: ${code}. Check the affected device before retrying.` });
  }

  terminate(c, reason, original) {
    if (c.terminal) return;
    this.db.run('UPDATE conversations SET terminal=? WHERE id=?', reason, c.id);
    this.db.run(`UPDATE messages SET state='failed',error=? WHERE conversation=? AND kind<>'status'
      AND state IN ('pending','waiting_binding','blocked')`, reason, c.id);
    const anchor = original
      ? this.db.get('SELECT id,sender,sender_ref FROM messages WHERE id=?', original)
      : this.db.get("SELECT id,sender,sender_ref FROM messages WHERE conversation=? AND kind='question' ORDER BY seq LIMIT 1", c.id);
    if (anchor) this.notice(c, anchor.id, reason, anchor.sender, anchor.sender_ref);
  }

  pending(deviceId, cutoffMs = null) {
    return this.db.transaction(() => {
      // Status notices travel independently: a broken return path must not stall unrelated work.
      const rows = this.db.all(`SELECT m.*,c.target,c.origin_device,c.origin_ref,c.peer_device,c.peer_ref,
        t.project, author.owner AS from_user FROM messages m
        JOIN conversations c ON c.id=m.conversation JOIN targets t ON t.id=c.target
        JOIN devices dest ON dest.id=m.recipient LEFT JOIN devices author ON author.id=m.sender
        WHERE m.recipient=? AND dest.revoked=0 AND m.state='pending'
        AND (? IS NULL OR m.attempted IS NULL OR m.attempted<=?)
        AND (m.kind='status' OR (c.terminal IS NULL AND NOT EXISTS(
          SELECT 1 FROM messages n WHERE n.conversation=m.conversation AND n.recipient=m.recipient
          AND n.kind<>'status' AND n.seq<m.seq AND n.state IN ('pending','waiting_binding','blocked'))))
        ORDER BY m.attempted IS NOT NULL,m.attempted,m.created,m.seq LIMIT 128`, deviceId, cutoffMs, cutoffMs);
      for (const row of rows) this.db.run('UPDATE messages SET attempted=? WHERE id=?', Date.now(), row.id);
      return rows.map(row => {
        const ref = row.destination_ref ?? row.peer_ref;
        const route = ref ? { mode: 'existing', session_ref: ref } : { mode: 'create_if_unbound' };
        if (row.kind === 'question') Object.assign(route, { target_id: row.target, project_id: row.project });
        const frame = { v: 1, type: 'deliver', message_id: row.id, conversation_id: row.conversation,
          seq: row.seq, kind: row.kind, from_user: row.from_user ?? 'system', route, text: row.body };
        if (row.original) frame.in_reply_to = row.original;
        if (row.outcome) frame.outcome = row.outcome;
        if (row.kind === 'status') frame.code = row.error;
        return frame;
      });
    });
  }

  received(device, message) {
    identifier(message, 'message_id');
    const m = this.db.get('SELECT * FROM messages WHERE id=? AND recipient=? AND attempted IS NOT NULL',
      message, device.device_id);
    if (!m) fail('MESSAGE_UNAVAILABLE', 404);
    return m;
  }

  ack(device, frame) {
    return this.db.transaction(() => {
      const m = this.received(device, frame.message_id);
      const c = this.db.get('SELECT * FROM conversations WHERE id=?', m.conversation);
      const expected = m.destination_ref ?? c.peer_ref;
      const ref = frame.bound_session_ref == null ? null : identifier(frame.bound_session_ref, 'bound_session_ref');
      if (expected && ref && expected !== ref) fail('BINDING_CONFLICT', 409);
      // The receiver may have enqueued the item just before access was revoked.
      // Confirm this authenticated, late receipt without reopening the closed route.
      if (m.state === 'failed') return { message_id: m.id, status: 'closed' };
      if (m.kind === 'question' && !c.peer_ref) {
        if (!ref) fail('BINDING_REQUIRED', 409);
        this.db.run('UPDATE conversations SET peer_ref=? WHERE id=? AND peer_ref IS NULL', ref, c.id);
        this.db.run(`UPDATE messages SET state=CASE WHEN sender_ref=? THEN 'pending' ELSE 'failed' END,
          error=CASE WHEN sender_ref=? THEN NULL ELSE 'WRONG_SESSION' END
          WHERE conversation=? AND state='waiting_binding'`, ref, ref, c.id);
      }
      this.db.run("UPDATE messages SET state='enqueued', error=CASE WHEN kind='status' THEN error END WHERE id=?", m.id);
      return { message_id: m.id, status: 'enqueued' };
    });
  }

  report(device, frame) {
    return this.db.transaction(() => {
      const reportId = identifier(frame.report_id, 'report_id');
      const code = identifier(frame.code ?? frame.reason, 'code');
      if (!/^[A-Z][A-Z_0-9]{0,95}$/.test(code)) fail('INVALID_ARGUMENTS', 400, 'Invalid report code');
      const stage = identifier(frame.stage, 'stage');
      if (frame.retryable != null && typeof frame.retryable !== 'boolean') fail('INVALID_ARGUMENTS');
      const m = this.received(device, frame.message_id);
      const hash = digest(JSON.stringify([m.id, stage, code, frame.retryable === true]));
      const existing = this.db.get('SELECT fingerprint FROM reports WHERE device=? AND id=?',
        device.device_id, reportId);
      if (existing && existing.fingerprint !== hash) fail('IDEMPOTENCY_CONFLICT', 409);
      const ack = { v: 1, type: 'report_ack', report_id: reportId };
      if (existing) return ack;
      const c = this.db.get('SELECT * FROM conversations WHERE id=?', m.conversation);
      this.db.run('INSERT INTO reports VALUES(?,?,?)', device.device_id, reportId, hash);
      if (m.kind === 'status') {
        // Never generate a new notice about failure to deliver a status notice.
        if (m.state !== 'enqueued' && !frame.retryable) {
          this.db.run("UPDATE messages SET state='failed' WHERE id=?", m.id);
        }
      } else if (!c.terminal) {
        if (['THREAD_UNAVAILABLE', 'SESSION_UNAVAILABLE', 'ACCESS_REVOKED'].includes(code)) {
          this.terminate(c, code, m.id);
        } else {
          const retry = frame.retryable === true && !code.includes('UNCERTAIN');
          // Once enqueued, failures refer to running the thread and must never enqueue it again.
          const state = m.state === 'enqueued' ? m.state : (retry ? 'pending' : 'blocked');
          this.db.run('UPDATE messages SET state=?,error=? WHERE id=?', state, code, m.id);
          if (!retry) this.notice(c, m.id, code, m.sender, m.sender_ref);
        }
      }
      return ack;
    });
  }
}
