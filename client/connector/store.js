import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadJson, loadSecrets, saveJson } from '../settings.js';

export function failure(code, retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}

// Setup and the running daemon must generate the same reference without writing
// each other's local state. Retain opaque references of existing fixed targets.
export function sessionRefFor({ stateDir, config, adapter, nativeId }) {
  if (![adapter, nativeId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 512)) {
    throw failure('CALL_CONTEXT_UNAVAILABLE');
  }
  for (const target of Object.values(config.targets ?? {})) {
    if (target.adapter === adapter && target.native_session_id === nativeId && target.fixed_session_ref) {
      return target.fixed_session_ref;
    }
  }
  const token = config.device_token ?? loadSecrets(stateDir, config.credential_store).device_token;
  return createHmac('sha256', token).update(JSON.stringify([adapter, nativeId])).digest('hex');
}

export class LocalStore {
  constructor(directory, config) {
    this.directory = directory;
    this.config = config;
    this.file = join(directory, 'session-refs.json');
    const saved = existsSync(this.file) ? loadJson(this.file) : null;
    if (saved && (saved.device_id !== config.device_id || saved.server_url !== config.server_url)) {
      throw failure('STATE_BELONGS_TO_OTHER_DEVICE');
    }
    // Only routing identifiers survive a connector restart. The daemon is the
    // sole writer, and new relay instances cannot resume prior conversations.
    const current = saved?.instance === config.relay_instance_id ? saved : null;
    this.sessions = new Map((current?.sessions ?? []).map(s => [s.ref, s]));
    this.bindings = new Map(current?.bindings ?? []);
    for (const target of Object.values(config.targets ?? {})) {
      if (target.fixed_session_ref && target.native_session_id) {
        this.sessions.set(target.fixed_session_ref, {
          adapter: target.adapter, native_id: target.native_session_id, ref: target.fixed_session_ref
        });
      }
    }
  }

  save() {
    saveJson(this.file, { device_id: this.config.device_id, server_url: this.config.server_url,
      instance: this.config.relay_instance_id, sessions: [...this.sessions.values()], bindings: [...this.bindings] });
  }

  mapSession(adapter, nativeId) {
    const ref = sessionRefFor({ stateDir: this.directory, config: this.config, adapter, nativeId });
    if (!this.sessions.has(ref)) {
      this.sessions.set(ref, { ref, adapter, native_id: nativeId });
      this.save();
    }
    return this.sessions.get(ref);
  }

  session(ref) { return this.sessions.get(ref); }

  binding(conversation) { return this.bindings.get(conversation); }

  insertBinding(conversation, target, ref = null) {
    this.bindings.set(conversation, { target, ref });
    this.save();
  }

  completeBinding(conversation, ref) {
    this.bindings.get(conversation).ref = ref;
    this.save();
  }

  clearUncreated(conversation) {
    this.bindings.delete(conversation);
    this.save();
  }
}
