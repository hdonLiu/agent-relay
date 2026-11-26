import { digest, fail, id, identifier, token } from '../collaboration/db.js';

export class Registry {
  constructor(db, terminate) {
    this.db = db;
    this.terminate = terminate;
  }

  issueUser(userId) {
    identifier(userId, 'user');
    if (userId.includes('/')) fail('INVALID_ARGUMENTS', 400, 'User IDs cannot contain a slash');
    const value = token();
    this.db.run('INSERT INTO users VALUES(?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash',
      userId, digest(value));
    return value;
  }

  userForToken(value) {
    if (typeof value !== 'string' || !value) return null;
    return this.db.get('SELECT id FROM users WHERE token_hash=?', digest(value))?.id ?? null;
  }

  enroll(userId) {
    if (!this.db.get('SELECT 1 FROM users WHERE id=?', userId)) fail('UNAUTHORIZED', 401);
    const code = token();
    const expires = Date.now() + 10 * 60 * 1000;
    this.db.run('DELETE FROM enrollments WHERE expires<=?', Date.now());
    this.db.run('INSERT INTO enrollments VALUES(?,?,?)', digest(code), userId, expires);
    return { code, expires_at: new Date(expires).toISOString() };
  }

  redeem(code) {
    identifier(code, 'enrollment code');
    const hash = digest(code);
    return this.db.transaction(() => {
      const entry = this.db.get('SELECT owner FROM enrollments WHERE hash=? AND expires>?', hash, Date.now());
      if (!entry) fail('INVALID_ENROLLMENT', 401);
      const device = id(), mcp = token(), stream = token();
      this.db.run('DELETE FROM enrollments WHERE hash=?', hash);
      this.db.run('INSERT INTO devices(id,owner,mcp_hash,device_hash) VALUES(?,?,?,?)',
        device, entry.owner, digest(mcp), digest(stream));
      return { device_id: device, user_id: entry.owner, mcp_token: mcp, device_token: stream };
    });
  }

  deviceForToken(value, scope) {
    if (typeof value !== 'string' || !value || !['mcp', 'device'].includes(scope)) return null;
    const column = scope === 'mcp' ? 'mcp_hash' : 'device_hash';
    return this.db.get(`SELECT id AS device_id,owner AS user_id FROM devices WHERE ${column}=? AND revoked=0`,
      digest(value)) ?? null;
  }

  requireDevice(device) {
    if (!device || !this.db.get('SELECT 1 FROM devices WHERE id=? AND owner=? AND revoked=0',
      device.device_id ?? null, device.user_id ?? null)) fail('UNAUTHORIZED', 401);
  }

  putTarget(owner, target, body) {
    identifier(target, 'target_id');
    if (!body || typeof body !== 'object') fail('INVALID_ARGUMENTS');
    const dev = identifier(body.device_id, 'device_id');
    const project = identifier(body.project_id, 'project_id');
    const alias = body.alias != null ? identifier(body.alias, 'alias') : null;
    if (target.includes('/')) fail('INVALID_ARGUMENTS', 400, 'Target IDs cannot contain a slash');
    if (alias?.includes('/') && (!alias.startsWith(owner + '/') || alias === owner + '/')) {
      fail('ALIAS_NAMESPACE_MISMATCH', 400);
    }
    const fixed = body.fixed_session_ref != null ? identifier(body.fixed_session_ref, 'fixed_session_ref') : null;
    if (!Array.isArray(body.allowed_senders) || body.allowed_senders.length > 1000) fail('INVALID_ARGUMENTS');
    const senders = new Set(body.allowed_senders.map(value => identifier(value, 'allowed sender')));
    return this.db.transaction(() => {
      this.requireDevice({ device_id: dev, user_id: owner });
      const existing = this.db.get('SELECT * FROM targets WHERE id=?', target);
      if (existing && existing.owner !== owner) fail('TARGET_UNAVAILABLE', 404);
      if (existing && (existing.device !== dev || existing.project !== project || existing.fixed_ref !== fixed)) {
        fail('TARGET_IMMUTABLE', 409);
      }
      // Aliases can move between endpoints of one owner. A stable target ID always keeps its identity.
      if (this.db.get('SELECT 1 FROM targets WHERE alias=? AND id<>?', target, target) ||
          this.db.get('SELECT 1 FROM targets WHERE id=? AND id<>?', alias, target)) fail('TARGET_NAME_CONFLICT', 409);
      const previous = this.db.get('SELECT id,owner FROM targets WHERE alias=?', alias);
      if (previous && previous.owner !== owner) fail('TARGET_NAME_CONFLICT', 409);
      if (previous && previous.id !== target) this.db.run('UPDATE targets SET alias=NULL WHERE id=?', previous.id);
      this.db.run(`INSERT INTO targets VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET alias=excluded.alias`, target, owner, dev, project, alias, fixed);
      const removed = this.db.all('SELECT sender FROM grants WHERE target=?', target)
        .filter(row => !senders.has(row.sender));
      this.db.run('DELETE FROM grants WHERE target=?', target);
      for (const sender of senders) this.db.run('INSERT INTO grants VALUES(?,?)', target, sender);
      for (const { sender } of removed) {
        const conversations = this.db.all(`SELECT c.* FROM conversations c JOIN devices d ON d.id=c.origin_device
          WHERE c.target=? AND d.owner=? AND c.terminal IS NULL`, target, sender);
        for (const c of conversations) this.terminate(c, 'ACCESS_REVOKED');
      }
      return { target_id: target, device_id: dev, project_id: project, alias, fixed_session_ref: fixed,
        allowed_senders: [...senders] };
    });
  }

  listTargets(owner) {
    return this.db.all(`SELECT t.id AS target_id,t.project AS project_id,t.alias,t.owner AS owner_id,
      t.device AS device_id FROM targets t JOIN devices d ON d.id=t.device
      WHERE d.revoked=0 AND (t.owner=? OR EXISTS(SELECT 1 FROM grants g WHERE g.target=t.id AND g.sender=?))
      ORDER BY t.id`, owner, owner);
  }

  revokeDevice(owner, dev) {
    return this.db.transaction(() => {
      if (!this.db.get('SELECT 1 FROM devices WHERE id=? AND owner=?', dev, owner)) fail('DEVICE_UNAVAILABLE', 404);
      this.db.run('UPDATE devices SET revoked=1 WHERE id=?', dev);
      const cs = this.db.all(`SELECT * FROM conversations WHERE (origin_device=? OR peer_device=?) AND terminal IS NULL`, dev, dev);
      for (const c of cs) this.terminate(c, 'ACCESS_REVOKED');
      return { device_id: dev, revoked: true };
    });
  }
}
