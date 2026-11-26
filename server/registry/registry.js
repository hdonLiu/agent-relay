import { digest, fail, id, identifier, token } from '../collaboration/values.js';

function validRegistrationToken(value) {
  return typeof value === 'string' && value.length === 43 &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}

function targetInfo(target) {
  const { target_id, device_id, project_id, alias, owner_id, fixed_session_ref } = target;
  return { target_id, device_id, project_id, alias, owner_id, fixed_session_ref };
}

// Each server instance owns its registry. Operations validate before changing
// the maps and finish synchronously on the Node.js event loop.
export class Registry {
  constructor(onGrantRevoked = () => {}, onDeviceRevoked = () => {}) {
    this.users = new Map();
    this.devices = new Map();
    this.credentials = new Map();
    this.enrollments = new Map();
    this.targets = new Map();
    this.aliases = new Map();
    this.onGrantRevoked = onGrantRevoked;
    this.onDeviceRevoked = onDeviceRevoked;
  }

  #setUser(username, hash) {
    const previous = this.users.get(username.toLowerCase());
    if (previous) this.credentials.delete(previous.hash);
    this.users.set(username.toLowerCase(), { username, hash });
    this.credentials.set(hash, { scope: 'owner', user_id: username });
  }

  #setDevice(username, deviceId, mcpHash, deviceHash) {
    this.devices.set(deviceId, { username, mcpHash, deviceHash, revoked: false });
    this.credentials.set(mcpHash, { scope: 'mcp', device_id: deviceId, user_id: username });
    this.credentials.set(deviceHash, { scope: 'device', device_id: deviceId, user_id: username });
  }

  issueUser(username) {
    identifier(username, 'user');
    if (username.includes('/')) fail('INVALID_ARGUMENTS', 400, 'User IDs cannot contain a slash');
    const previous = this.users.get(username.toLowerCase());
    if (previous && previous.username !== username) fail('USERNAME_TAKEN', 409);
    const value = token();
    this.#setUser(username, digest(value));
    return value;
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
    const user = this.users.get(username);
    const device = this.devices.get(device_id);
    const result = { user_id: username, device_id };
    if (device?.username === username && device.mcpHash === mcpHash && device.deviceHash === deviceHash) {
      if (device.revoked) fail('DEVICE_REVOKED', 403);
      if (user.hash !== ownerHash) fail('REGISTRATION_CREDENTIAL_CHANGED', 403);
      return result;
    }
    if (user) fail('USERNAME_TAKEN', 409);
    if (device || hashes.some(hash => this.credentials.has(hash))) fail('REGISTRATION_CONFLICT', 409);
    this.#setUser(username, ownerHash);
    this.#setDevice(username, device_id, mcpHash, deviceHash);
    // A freshly claimed name must be explicitly authorized by the sharing owner.
    for (const target of this.targets.values()) target.senders.delete(username);
    return result;
  }

  userForToken(value) {
    if (typeof value !== 'string' || !value) return null;
    const credential = this.credentials.get(digest(value));
    return credential?.scope === 'owner' ? credential.user_id : null;
  }

  enroll(username) {
    if (typeof username !== 'string' || this.users.get(username.toLowerCase())?.username !== username) {
      fail('UNAUTHORIZED', 401);
    }
    const now = Date.now();
    for (const [hash, entry] of this.enrollments) {
      if (entry.expires <= now) this.enrollments.delete(hash);
    }
    const code = token();
    const expires = now + 10 * 60 * 1000;
    this.enrollments.set(digest(code), { username, expires });
    return { code, expires_at: new Date(expires).toISOString() };
  }

  redeem(code) {
    identifier(code, 'enrollment code');
    const hash = digest(code);
    const entry = this.enrollments.get(hash);
    this.enrollments.delete(hash);
    if (!entry || entry.expires <= Date.now()) fail('INVALID_ENROLLMENT', 401);
    const device = id(), mcp = token(), stream = token();
    this.#setDevice(entry.username, device, digest(mcp), digest(stream));
    return { device_id: device, user_id: entry.username, mcp_token: mcp, device_token: stream };
  }

  deviceForToken(value, scope) {
    if (typeof value !== 'string' || !value || !['mcp', 'device'].includes(scope)) return null;
    const credential = this.credentials.get(digest(value));
    if (credential?.scope !== scope || this.devices.get(credential.device_id).revoked) return null;
    return { user_id: credential.user_id, device_id: credential.device_id };
  }

  requireDevice(identity) {
    const device = this.devices.get(identity?.device_id);
    if (!device || device.revoked || device.username !== identity.user_id) fail('UNAUTHORIZED', 401);
  }

  putTarget(owner, targetId, body) {
    identifier(targetId, 'target_id');
    if (!body || typeof body !== 'object') fail('INVALID_ARGUMENTS');
    const device = identifier(body.device_id, 'device_id');
    const project = identifier(body.project_id, 'project_id');
    const alias = body.alias == null ? null : identifier(body.alias, 'alias');
    if (targetId.includes('/')) fail('INVALID_ARGUMENTS', 400, 'Target IDs cannot contain a slash');
    if (alias?.includes('/') && (!alias.startsWith(owner + '/') || alias === owner + '/')) {
      fail('ALIAS_NAMESPACE_MISMATCH', 400);
    }
    const fixed = body.fixed_session_ref == null ? null : identifier(body.fixed_session_ref, 'fixed_session_ref');
    if (!Array.isArray(body.allowed_senders) || body.allowed_senders.length > 1000) fail('INVALID_ARGUMENTS');
    const senders = new Set(body.allowed_senders.map(value => {
      const name = identifier(value, 'allowed sender').toLowerCase();
      const handle = name.replace(/^@/, '');
      // Existing operator-issued identities can have their own case or a literal @.
      return (this.users.get(name) ?? this.users.get(handle))?.username ?? identifier(handle, 'allowed sender');
    }));

    this.requireDevice({ device_id: device, user_id: owner });
    const existing = this.targets.get(targetId);
    if (existing && existing.owner_id !== owner) fail('TARGET_UNAVAILABLE', 404);
    if (existing && (existing.device_id !== device || existing.project_id !== project ||
        existing.fixed_session_ref !== fixed)) fail('TARGET_IMMUTABLE', 409);
    if ((this.aliases.has(targetId) && this.aliases.get(targetId) !== targetId) ||
        (alias !== targetId && this.targets.has(alias))) fail('TARGET_NAME_CONFLICT', 409);
    const previous = this.targets.get(this.aliases.get(alias));
    if (previous && previous.owner_id !== owner) fail('TARGET_NAME_CONFLICT', 409);
    if (previous) previous.alias = null;
    if (existing?.alias) this.aliases.delete(existing.alias);
    if (alias) this.aliases.set(alias, targetId);

    const target = { target_id: targetId, device_id: device, project_id: project, alias, owner_id: owner,
      fixed_session_ref: fixed, senders };
    this.targets.set(targetId, target);
    if (existing) {
      for (const sender of existing.senders) {
        if (!senders.has(sender)) this.onGrantRevoked(targetId, sender);
      }
    }
    return { target_id: targetId, device_id: device, project_id: project, alias,
      fixed_session_ref: fixed, allowed_senders: [...senders] };
  }

  canSend(username, targetId) {
    const target = this.targets.get(targetId);
    return Boolean(target && !this.devices.get(target.device_id).revoked && target.senders.has(username));
  }

  resolveTarget(username, address) {
    const target = this.targets.get(address) ?? this.targets.get(this.aliases.get(address));
    return target && this.canSend(username, target.target_id) ? targetInfo(target) : null;
  }

  listTargets(username) {
    const visible = [];
    for (const target of this.targets.values()) {
      if (this.devices.get(target.device_id).revoked) continue;
      if (target.owner_id === username || target.senders.has(username)) visible.push(targetInfo(target));
    }
    return visible.sort((a, b) => a.target_id.localeCompare(b.target_id));
  }

  revokeDevice(owner, deviceId) {
    const device = this.devices.get(deviceId);
    if (!device || device.username !== owner) fail('DEVICE_UNAVAILABLE', 404);
    if (!device.revoked) {
      device.revoked = true;
      this.onDeviceRevoked(deviceId);
    }
    return { device_id: deviceId, revoked: true };
  }
}
