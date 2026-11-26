import { digest, fail, id, identifier, token } from '../collaboration/db.js';

function validRegistrationToken(value) {
  return typeof value === 'string' && value.length === 43 &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}

export class Registry {
  constructor(db, terminate) {
    this.db = db;
    this.terminate = terminate;
  }

  issueUser(userId) {
    identifier(userId, 'user');
    if (userId.includes('/')) fail('INVALID_ARGUMENTS', 400, 'User IDs cannot contain a slash');
    const value = token();
    return this.db.transaction(() => {
      // Existing exact IDs (including legacy case variants) retain credential rotation.
      if (!this.db.get('SELECT 1 FROM users WHERE id=?', userId) &&
          this.db.get('SELECT 1 FROM users WHERE id=? COLLATE NOCASE', userId)) {
        fail('USERNAME_TAKEN', 409);
      }
      this.db.run('INSERT INTO users VALUES(?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash',
        userId, digest(value));
      return value;
    });
  }

  register(managementToken, body) {
    if (!validRegistrationToken(managementToken)) fail('UNAUTHORIZED', 401);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['username', 'device_id', 'mcp_token', 'device_token'].includes(key))) {
      fail('INVALID_ARGUMENTS');
    }
    const { username, device_id, mcp_token, device_token } = body;
    if (typeof username !== 'string' || !/^[a-z][a-z0-9_-]{1,31}$/.test(username)) fail('INVALID_USERNAME');
    if (typeof device_id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(device_id) ||
        !validRegistrationToken(mcp_token) || !validRegistrationToken(device_token) ||
        new Set([managementToken, mcp_token, device_token]).size !== 3) fail('INVALID_ARGUMENTS');

    const hashes = [managementToken, mcp_token, device_token].map(digest);
    const [ownerHash, mcpHash, deviceHash] = hashes;
    const result = { user_id: username, device_id };
    return this.db.transaction(() => {
      const replay = this.db.get(`SELECT u.token_hash, d.revoked FROM users u JOIN devices d ON d.owner=u.id
        WHERE u.id=? AND d.id=? AND d.mcp_hash=? AND d.device_hash=?`,
        username, device_id, mcpHash, deviceHash);
      if (replay) {
        if (replay.revoked) fail('DEVICE_REVOKED', 403);
        if (replay.token_hash !== ownerHash) fail('REGISTRATION_CREDENTIAL_CHANGED', 403);
        return result;
      }
      if (this.db.get('SELECT 1 FROM users WHERE id=? COLLATE NOCASE', username)) fail('USERNAME_TAKEN', 409);
      if (this.db.get('SELECT 1 FROM users WHERE token_hash IN (?,?,?)', ...hashes) ||
          this.db.get(`SELECT 1 FROM devices WHERE id=? OR mcp_hash IN (?,?,?) OR device_hash IN (?,?,?)`,
            device_id, ...hashes, ...hashes)) fail('REGISTRATION_CONFLICT', 409);
      this.db.run('INSERT INTO users(id,token_hash) VALUES(?,?)', username, ownerHash);
      this.db.run('INSERT INTO devices(id,owner,mcp_hash,device_hash) VALUES(?,?,?,?)',
        device_id, username, mcpHash, deviceHash);
      // Grants naming a previously unissued identity need confirmation by the sharing owner.
      this.db.run('UPDATE grants SET active=0 WHERE sender=?', username);
      return result;
    });
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
      for (const sender of senders) this.db.run('INSERT INTO grants(target,sender) VALUES(?,?)', target, sender);
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
      WHERE d.revoked=0 AND (t.owner=? OR EXISTS(SELECT 1 FROM grants g WHERE g.target=t.id AND g.sender=? AND g.active=1))
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
