import { failure } from './store.js';

function key(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512; }

function valid(frame) {
  if (frame.v !== 1 || !key(frame.message_id) || !key(frame.conversation_id) || typeof frame.text !== 'string') return false;
  if (!['question', 'reply', 'status'].includes(frame.kind)) return false;
  if (frame.route?.mode === 'existing') return key(frame.route.session_ref);
  return frame.kind === 'question' && frame.route?.mode === 'create_if_unbound'
    && key(frame.route.target_id) && key(frame.route.project_id);
}

function safeCode(error, fallback) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : fallback;
}

function definitelyUnsubmitted(error) {
  return error?.submission === 'not_submitted' || error?.notSubmitted === true;
}

const permanent = new Set(['THREAD_UNAVAILABLE', 'SESSION_UNAVAILABLE', 'ACCESS_REVOKED', 'TARGET_UNAVAILABLE',
  'TARGET_MISMATCH', 'INVALID_FRAME', 'ADAPTER_PROTOCOL_ERROR']);

export class InboundDelivery {
  constructor(store, targets, adapters, send) {
    this.store = store;
    this.targets = targets;
    this.adapters = adapters;
    this.send = send;
    this.byConversation = new Map();
    this.active = new Map();
    this.stopped = false;
  }

  stop() { this.stopped = true; }

  receive(frame, reconcileOnly = false) {
    if (this.stopped) return Promise.resolve();
    if (!valid(frame)) {
      if (key(frame.message_id)) this.report(frame, 'INVALID_FRAME', false);
      return Promise.resolve();
    }
    const existing = this.active.get(frame.message_id);
    if (existing) return existing;
    const previous = this.byConversation.get(frame.conversation_id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.process(frame, reconcileOnly)).finally(() => {
      this.active.delete(frame.message_id);
      if (this.byConversation.get(frame.conversation_id) === task) this.byConversation.delete(frame.conversation_id);
    });
    this.byConversation.set(frame.conversation_id, task);
    this.active.set(frame.message_id, task);
    return task;
  }

  report(frame, code, retryable) {
    const report = this.store.report(frame.message_id, code, retryable);
    if (report) this.send(report);
  }

  acknowledge(frame, ref) {
    this.send({ v: 1, type: 'ack', message_id: frame.message_id, bound_session_ref: ref });
  }

  target(id) {
    const target = Object.hasOwn(this.targets, id) && this.targets[id];
    if (!target) throw failure('TARGET_UNAVAILABLE');
    return target;
  }

  adapter(id) {
    if (!Object.hasOwn(this.adapters, id)) throw failure('ADAPTER_UNAVAILABLE', true);
    return this.adapters[id];
  }

  async route(frame) {
    const { route, conversation_id: conversation } = frame;
    if (route.mode === 'existing') {
      const session = this.store.session(route.session_ref);
      if (!session) throw failure('SESSION_UNAVAILABLE');
      if (frame.kind === 'question') {
        const binding = this.store.binding(conversation);
        const targetId = binding?.target ?? route.target_id;
        if (!key(targetId)) throw failure('TARGET_UNAVAILABLE');
        const target = this.target(targetId);
        if (target.adapter !== session.adapter || (route.target_id && route.target_id !== targetId)
          || (route.project_id && route.project_id !== target.project_id)
          || (binding ? binding.ref !== session.ref : target.fixed_session_ref !== session.ref)) {
          throw failure('TARGET_MISMATCH');
        }
        if (!binding) this.store.insertBinding(conversation, targetId, session.ref);
      }
      return session;
    }

    const target = this.target(route.target_id);
    if (target.project_id !== route.project_id || target.fixed_session_ref) throw failure('TARGET_MISMATCH');
    const binding = this.store.binding(conversation);
    if (binding) {
      if (binding.target !== route.target_id) throw failure('TARGET_MISMATCH');
      if (!binding.ref) throw failure('CREATION_UNCERTAIN');
      const session = this.store.session(binding.ref);
      if (!session || session.adapter !== target.adapter) throw failure('TARGET_MISMATCH');
      return session;
    }
    const adapter = this.adapter(target.adapter);
    this.store.insertBinding(conversation, route.target_id);
    let nativeId;
    try {
      nativeId = await adapter.createSession(target, conversation);
    } catch (error) {
      if (!definitelyUnsubmitted(error)) throw failure('CREATION_UNCERTAIN');
      this.store.clearUncreated(conversation);
      const code = safeCode(error, 'HOST_UNAVAILABLE');
      throw failure(code, error.retryable ?? !permanent.has(code));
    }
    if (!key(nativeId)) throw failure('CREATION_UNCERTAIN');
    const session = this.store.mapSession(target.adapter, nativeId);
    this.store.completeBinding(conversation, session.ref);
    return session;
  }

  async process(frame, reconcileOnly) {
    if (this.stopped) return;
    const id = frame.message_id;
    const row = this.store.receipt(id);
    if (row && row.conversation !== frame.conversation_id) return this.report(frame, 'INVALID_FRAME', false);
    if (row?.phase === 'accepted') return this.acknowledge(frame, row.ref);
    let session, adapter;
    try {
      session = await this.route(frame);
      adapter = this.adapter(session.adapter);
    } catch (error) {
      return this.report(frame, safeCode(error, 'DELIVERY_UNCERTAIN'), error?.retryable === true);
    }
    if (row && row.ref !== session.ref) return this.report(frame, 'TARGET_MISMATCH', false);
    if (row?.phase === 'submitting') {
      let result;
      try { result = await adapter.lookupDelivery(session.native_id, id); }
      catch { result = 'unknown'; }
      if (result === 'accepted') {
        this.store.acceptSubmission(id, id, true);
        return this.acknowledge(frame, session.ref);
      }
      if (result !== 'not_submitted') return this.report(frame, 'DELIVERY_UNCERTAIN', false);
      // Persist the report that releases a cloud-side block before making this
      // item ineligible for local reconciliation on the next start.
      if (reconcileOnly) this.report(frame, 'HOST_NOT_SUBMITTED', true);
      this.store.retrySubmission(id);
      if (reconcileOnly) return;
    }
    // A local recovery pass may verify past submission, but only a fresh cloud
    // dispatch authorizes a new one after reconnect or a change of grants.
    if (reconcileOnly) return this.report(frame, 'HOST_NOT_SUBMITTED', true);
    if (this.stopped) return;
    this.store.beginSubmission(frame, session.ref);
    let acceptance;
    try {
      const target = frame.kind === 'question' ? this.target(this.store.binding(frame.conversation_id).target) : undefined;
      acceptance = await adapter.deliver(session.native_id, frame, target);
    } catch (error) {
      if (!definitelyUnsubmitted(error)) return this.report(frame, 'DELIVERY_UNCERTAIN', false);
      const code = safeCode(error, 'HOST_UNAVAILABLE');
      this.store.retrySubmission(id);
      return this.report(frame, code, error.retryable ?? !permanent.has(code));
    }
    if (!key(acceptance?.submission_ref)) return this.report(frame, 'DELIVERY_UNCERTAIN', false);
    this.store.acceptSubmission(id, acceptance.submission_ref);
    this.acknowledge(frame, session.ref);
  }
}
