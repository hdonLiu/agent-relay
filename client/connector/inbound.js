import { randomUUID } from 'node:crypto';
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
  constructor(store, targets, adapters) {
    this.store = store;
    this.targets = targets;
    this.adapters = adapters;
    this.receipts = new Map();
    this.byConversation = new Map();
    this.active = new Map();
    this.stopped = false;
  }

  stop() { this.stopped = true; }

  receive(frame, link) {
    if (this.stopped) return Promise.resolve();
    if (!valid(frame)) {
      if (key(frame.message_id)) this.report(link, frame, 'INVALID_FRAME', false);
      return Promise.resolve();
    }
    const existing = this.active.get(frame.message_id);
    if (existing) return existing;
    const previous = this.byConversation.get(frame.conversation_id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.process(frame, link)).finally(() => {
      this.active.delete(frame.message_id);
      if (this.byConversation.get(frame.conversation_id) === task) this.byConversation.delete(frame.conversation_id);
    });
    this.byConversation.set(frame.conversation_id, task);
    this.active.set(frame.message_id, task);
    return task;
  }

  report(link, frame, code, retryable) {
    link.send({ v: 1, type: 'report', report_id: randomUUID(), message_id: frame.message_id,
      stage: 'delivery', code, retryable });
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

  async process(frame, link) {
    if (this.stopped || !link.isOpen()) return;
    const id = frame.message_id;
    const prior = this.receipts.get(id);
    if (prior) {
      if (prior.conversation !== frame.conversation_id) return this.report(link, frame, 'INVALID_FRAME', false);
      if (prior.code) return this.report(link, frame, prior.code, prior.retryable);
      return link.send({ v: 1, type: 'ack', message_id: id, bound_session_ref: prior.ref });
    }
    let session;
    let delivering = false;
    try {
      session = await this.route(frame);
      if (this.stopped || !link.isOpen()) return;
      const adapter = this.adapter(session.adapter);
      const target = frame.kind === 'question' ? this.target(this.store.binding(frame.conversation_id).target) : undefined;
      if (frame.route.mode === 'create_if_unbound') {
        link.send({ v: 1, type: 'bind', message_id: id, bound_session_ref: session.ref });
      }
      delivering = true;
      const accepted = await adapter.deliver(session.native_id, frame, target);
      if (!key(accepted?.submission_ref)) throw failure('DELIVERY_UNCONFIRMED');
    } catch (error) {
      const uncertain = delivering && !definitelyUnsubmitted(error);
      const code = uncertain ? 'DELIVERY_UNCONFIRMED' : safeCode(error, 'DELIVERY_UNCONFIRMED');
      const retryable = !uncertain && (error?.retryable ?? !permanent.has(code));
      this.receipts.set(id, { conversation: frame.conversation_id, code, retryable });
      return this.report(link, frame, code, retryable);
    }
    this.receipts.set(id, { conversation: frame.conversation_id, ref: session.ref });
    link.send({ v: 1, type: 'ack', message_id: id, bound_session_ref: session.ref });
  }
}
