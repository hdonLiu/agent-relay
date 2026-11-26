import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function fail(code, status = 400, message = code) {
  throw Object.assign(new Error(message), { code, status });
}

export function identifier(value, name = 'id') {
  if (typeof value !== 'string' || !value.length || value.length > 256 ||
      value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) {
    fail('INVALID_ARGUMENTS', 400, `Invalid ${name}`);
  }
  return value;
}

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export const token = () => randomBytes(32).toString('base64url');
export const id = () => randomUUID();

export class Database {
  constructor(path) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE);
      CREATE INDEX IF NOT EXISTS username_nocase ON users(id COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS enrollments (
        hash TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users, mcp_hash TEXT UNIQUE NOT NULL,
        device_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users, device TEXT NOT NULL REFERENCES devices,
        project TEXT NOT NULL, alias TEXT UNIQUE, fixed_ref TEXT
      );
      CREATE TABLE IF NOT EXISTS grants (
        target TEXT NOT NULL REFERENCES targets, sender TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(target,sender)
      );
      CREATE INDEX IF NOT EXISTS grants_by_sender ON grants(sender);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, target TEXT NOT NULL REFERENCES targets, origin_device TEXT NOT NULL REFERENCES devices,
        origin_ref TEXT NOT NULL, peer_device TEXT NOT NULL REFERENCES devices, peer_ref TEXT,
        terminal TEXT, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations, seq INTEGER NOT NULL,
        sender TEXT REFERENCES devices, sender_ref TEXT, recipient TEXT NOT NULL REFERENCES devices,
        destination_ref TEXT, tool TEXT, request_id TEXT, payload_hash TEXT, kind TEXT NOT NULL,
        original TEXT REFERENCES messages, outcome TEXT, body TEXT NOT NULL, state TEXT NOT NULL,
        attempted INTEGER, error TEXT, created INTEGER NOT NULL,
        UNIQUE(sender,sender_ref,tool,request_id), UNIQUE(conversation,recipient,seq)
      );
      CREATE INDEX IF NOT EXISTS inbox ON messages(recipient,state,conversation,seq);
      CREATE UNIQUE INDEX IF NOT EXISTS one_notice ON messages(original,error) WHERE kind='status';
      CREATE TABLE IF NOT EXISTS reports (
        device TEXT NOT NULL REFERENCES devices, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY(device,id)
      );
    `);
    // Older relays allowed operators to grant a future username before issuing its credentials.
    this.transaction(() => {
      if (!this.all('PRAGMA table_info(grants)').some(column => column.name === 'active')) {
        this.sqlite.exec('ALTER TABLE grants ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
      }
    });
  }
  run(sql, ...args) { return this.sqlite.prepare(sql).run(...args); }
  all(sql, ...args) { return this.sqlite.prepare(sql).all(...args); }
  get(sql, ...args) { return this.sqlite.prepare(sql).get(...args); }

  transaction(action) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      this.sqlite.exec('COMMIT');
      return value;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.sqlite.close(); }
}
