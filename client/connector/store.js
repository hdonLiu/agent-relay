import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export function failure(code, retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

// An OS-backed SQLite lock dies with the process. Only its owner may clean up
// a socket left behind by a killed daemon. A PID file alone cannot ensure this.
export function lockDirectory(directory) {
  const lock = new DatabaseSync(join(directory, 'daemon-lock.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    return () => lock.close();
  } catch (error) {
    lock.close();
    if (error.errcode === 5) throw failure('DAEMON_ALREADY_RUNNING');
    throw error;
  }
}

export class LocalStore {
  constructor(directory, config) {
    this.db = new DatabaseSync(join(directory, 'connector.sqlite'));
    try {
      this.db.exec(`
        PRAGMA busy_timeout=5000;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), device TEXT, origin TEXT);
        CREATE TABLE IF NOT EXISTS sessions (
          ref TEXT PRIMARY KEY, adapter TEXT NOT NULL, native_id TEXT NOT NULL, UNIQUE(adapter,native_id)
        );
        CREATE TABLE IF NOT EXISTS bindings (
          conversation TEXT PRIMARY KEY, target TEXT NOT NULL, ref TEXT
        );
        CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY, conversation TEXT NOT NULL, ref TEXT NOT NULL,
          phase TEXT NOT NULL, frame TEXT NOT NULL, evidence TEXT
        );
        CREATE TABLE IF NOT EXISTS recovery_acks (message TEXT PRIMARY KEY, ref TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reports (
          id TEXT PRIMARY KEY, message TEXT NOT NULL UNIQUE, code TEXT NOT NULL, frame TEXT NOT NULL,
          confirmed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY, ref TEXT NOT NULL, call_key TEXT NOT NULL, tool TEXT NOT NULL,
          args TEXT NOT NULL, result TEXT, UNIQUE(ref,call_key,tool)
        );
      `);
      this.db.prepare('INSERT OR IGNORE INTO identity VALUES(1,?,?)').run(config.device_id, config.server_url);
      const identity = this.db.prepare('SELECT * FROM identity WHERE id=1').get();
      if (identity.device !== config.device_id || identity.origin !== config.server_url) {
        throw failure('STATE_BELONGS_TO_OTHER_DEVICE');
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  mapSession(adapter, nativeId) {
    this.db.prepare('INSERT OR IGNORE INTO sessions VALUES(?,?,?)').run(randomUUID(), adapter, nativeId);
    return this.db.prepare('SELECT * FROM sessions WHERE adapter=? AND native_id=?').get(adapter, nativeId);
  }

  session(ref) {
    return this.db.prepare('SELECT * FROM sessions WHERE ref=?').get(ref);
  }

  binding(conversation) {
    return this.db.prepare('SELECT * FROM bindings WHERE conversation=?').get(conversation);
  }

  insertBinding(conversation, target, ref = null) {
    this.db.prepare('INSERT INTO bindings VALUES(?,?,?)').run(conversation, target, ref);
  }

  completeBinding(conversation, ref) {
    this.db.prepare('UPDATE bindings SET ref=? WHERE conversation=? AND ref IS NULL').run(ref, conversation);
  }

  clearUncreated(conversation) {
    this.db.prepare('DELETE FROM bindings WHERE conversation=? AND ref IS NULL').run(conversation);
  }

  outboxItem(ref, callKey, tool, args) {
    const serialized = JSON.stringify(canonical(args));
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,ref,call_key,tool,args) VALUES(?,?,?,?,?)')
      .run(randomUUID(), ref, callKey, tool, serialized);
    const item = this.db.prepare('SELECT * FROM outbox WHERE ref=? AND call_key=? AND tool=?').get(ref, callKey, tool);
    if (item.args !== serialized) throw failure('IDEMPOTENCY_CONFLICT');
    return item;
  }

  pendingCalls() {
    return this.db.prepare('SELECT * FROM outbox WHERE result IS NULL ORDER BY rowid').all();
  }

  saveResult(id, result) {
    this.db.prepare('UPDATE outbox SET result=? WHERE id=?').run(JSON.stringify(result), id);
  }

  receipt(id) {
    return this.db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
  }

  beginSubmission(frame, ref) {
    this.db.prepare(`INSERT INTO receipts VALUES(?,?,?,'submitting',?,NULL)
      ON CONFLICT(id) DO UPDATE SET phase='submitting'`).run(frame.message_id, frame.conversation_id, ref, JSON.stringify(frame));
  }

  retrySubmission(id) {
    this.db.prepare("UPDATE receipts SET phase='ready' WHERE id=?").run(id);
  }

  acceptSubmission(id, evidence, reconciled = false) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE receipts SET phase='accepted',evidence=? WHERE id=?").run(evidence, id);
      // The cloud may have suspended delivery after a report. Its normal retry
      // loop cannot repair a lost reconciliation ACK, so persist this ACK too.
      if (reconciled || this.db.prepare('SELECT 1 FROM reports WHERE message=? LIMIT 1').get(id)) {
        this.db.prepare('INSERT OR IGNORE INTO recovery_acks SELECT id,ref FROM receipts WHERE id=?').run(id);
      }
      this.db.prepare('UPDATE reports SET confirmed=1 WHERE message=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recoveryAcks() {
    return this.db.prepare('SELECT message,ref FROM recovery_acks').all().map(row => ({
      v: 1, type: 'ack', message_id: row.message, bound_session_ref: row.ref
    }));
  }

  confirmAck(id) {
    this.db.prepare('DELETE FROM recovery_acks WHERE message=?').run(id);
  }

  uncertainFrames() {
    return this.db.prepare("SELECT frame FROM receipts WHERE phase='submitting'").all().map(row => JSON.parse(row.frame));
  }

  report(message, code, retryable) {
    const frame = { v: 1, type: 'report', report_id: randomUUID(), message_id: message, stage: 'delivery', code, retryable };
    // A later state supersedes the old report. Re-entering a previously confirmed
    // state needs a fresh report ID so the cloud can apply that transition again.
    this.db.prepare(`INSERT INTO reports(id,message,code,frame) VALUES(?,?,?,?)
      ON CONFLICT(message) DO UPDATE SET id=excluded.id,code=excluded.code,frame=excluded.frame,confirmed=0
      WHERE excluded.code<>reports.code`)
      .run(frame.report_id, message, code, JSON.stringify(frame));
    const row = this.db.prepare('SELECT frame,confirmed FROM reports WHERE message=?').get(message);
    return row.confirmed ? null : JSON.parse(row.frame);
  }

  pendingReports() {
    return this.db.prepare('SELECT frame FROM reports WHERE confirmed=0').all().map(row => JSON.parse(row.frame));
  }

  confirmReport(id) {
    this.db.prepare('UPDATE reports SET confirmed=1 WHERE id=?').run(id);
  }
}

// Used by setup when publishing a specific existing native chat. It shares
// the same mapping as a concurrent outgoing local MCP call from that chat.
export function sessionRefFor({ stateDir, config, adapter, nativeId }) {
  if (![adapter, nativeId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 512)) {
    throw failure('CALL_CONTEXT_UNAVAILABLE');
  }
  const store = new LocalStore(stateDir, config);
  try { return store.mapSession(adapter, nativeId).ref; }
  finally { store.close(); }
}
