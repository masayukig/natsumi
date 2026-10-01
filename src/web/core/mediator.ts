import type { Approval } from '../../shared/protocol/conversation.ts';
import { encodeCommand, readEnvelope, type Accepted, type ClientCommand, type ServerEvent, type Snapshot } from '../../shared/protocol/envelope.ts';
import type { SettingKey } from '../../shared/protocol/settings.ts';
import type { Effect } from './effects.ts';
import type { AppEvent } from './events.ts';
import { parseSettingInput } from './settings.ts';
import type { AppState, ApprovalFlow, Screen } from './state.ts';
import { place } from './stream.ts';
import { codeWords, pushWords, resolutionWords, unavailableWords } from './words.ts';

/**
 * The browser app's mediator (ADR 0058; the Mac's `UIMediator`, mac/CLAUDE.md): (state, event) → (state, effects). It is
 * the one place that decides what follows anything, and it is pure: it keeps no state of its own and touches nothing
 * outside; the effects say what main.ts is to do.
 */

export interface Mediated { state: AppState; effects: Effect[] }

const MAX_WAIT_MS = 30_000;
const RESULTS_KEPT = 3;

export function initialState(options: { screen: Screen; idPrefix: string; deviceId?: string }): AppState {
  return {
    screen: options.screen, idPrefix: options.idPrefix, nextId: 1,
    link: 'idle', socketOpen: false, attempts: 0, visible: false,
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
    avatarRequested: false,
    messages: [], pending: {}, expression: 'neutral', outbox: [], sentCount: 0,
    readThrough: null, unreadReplyCount: 0, unacknowledged: [], localReads: [],
    approvals: [], flows: {}, results: [], settingEntries: {}, push: { status: 'unsupported' },
  };
}

export function mediate(state: AppState, event: AppEvent): Mediated {
  const run = new Run(state);
  run.handle(event);
  run.readIfSeen();
  return { state: run.state, effects: run.effects };
}

/** One event's work: the state as it changes, and the effects asked for on the way. */
class Run {
  state: AppState;
  readonly effects: Effect[] = [];

  constructor(state: AppState) { this.state = state; }

  private set(changes: Partial<AppState>): void { this.state = { ...this.state, ...changes }; }

  /** Sends a command with a new request ID, or with the one given (a message sent again), and returns the ID. */
  private send(command: ClientCommand, requestId?: string): string {
    const id = requestId ?? `${this.state.idPrefix}-${this.state.nextId}`;
    if (!requestId) this.set({ nextId: this.state.nextId + 1 });
    const { deviceId } = this.state;
    this.effects.push({ kind: 'send', data: encodeCommand({ requestId: id, ...(deviceId ? { deviceId } : {}), command }) });
    return id;
  }

  private get synced(): boolean { return this.state.link === 'synced' && this.state.socketOpen; }

  handle(event: AppEvent): void {
    switch (event.type) {
      case 'started':
        this.set({ link: 'connecting', avatarRequested: true });
        this.effects.push({ kind: 'connect' }, { kind: 'fetch-avatar' }, { kind: 'check-push' });
        return;
      case 'socket-opened':
        this.set({ socketOpen: true });
        this.sync(this.state.cursor ?? null);
        return;
      case 'socket-message':
        this.receive(event.text);
        return;
      case 'socket-closed':
        this.closed(event.code);
        return;
      case 'reconnect-due':
        if (this.state.socketOpen) this.sync(null);
        else this.connect();
        return;
      case 'reconnect-now':
        if (!this.state.socketOpen) this.connect();
        return;
      case 'avatar-loaded':
        this.set({ avatar: event.manifest, avatarRequested: false });
        return;
      case 'avatar-failed':
        this.set({ avatarRequested: false });
        return;
      case 'visibility':
        this.set({ visible: event.visible });
        return;
      case 'push-checked': {
        const { supported, subscription, error } = event;
        this.set({ push: { status: !supported ? 'unsupported' : subscription ? 'on' : 'off', ...(subscription ? { subscription } : {}),
          ...(error ? { error: pushWords(error) } : {}) } });
        this.registerPush();
        return;
      }
      case 'push-toggle':
        if (this.state.push.status === 'unsupported' || this.state.push.status === 'busy') return;
        this.set({ push: { status: 'busy' } });
        this.effects.push({ kind: event.on ? 'subscribe-push' : 'unsubscribe-push' });
        return;
      case 'send':
        this.sendMessage(event.text);
        return;
      case 'retry-send': {
        const item = this.state.outbox.find(outgoing => outgoing.requestId === event.requestId);
        if (!item) return;
        this.set({ outbox: this.state.outbox.map(outgoing => (outgoing === item ? { requestId: item.requestId, text: item.text, status: 'sending' } : outgoing)) });
        if (this.synced) this.send({ type: 'conversation.send', payload: { text: item.text } }, item.requestId);
        return;
      }
      case 'dismiss-send':
        this.set({ outbox: this.state.outbox.filter(outgoing => outgoing.requestId !== event.requestId) });
        return;
      case 'ack-notice':
        if (!this.synced || !this.unacknowledged().includes(event.notificationId)) return;
        this.set({ localReads: [...this.state.localReads, {
          requestId: this.send({ type: 'notification.ack', payload: { notificationId: event.notificationId } }), kind: 'ack', id: event.notificationId,
        }] });
        return;
      case 'approval-edit':
        this.flow(event.approvalId, () => ({ step: 'editing' }));
        return;
      case 'approval-choose':
        this.choose(event);
        return;
      case 'approval-confirm':
        this.confirm(event.approvalId);
        return;
      case 'approval-cancel':
        this.flow(event.approvalId, flow => (flow.step === 'confirming' && flow.editing ? { step: 'editing' } : { step: 'idle' }));
        return;
      case 'setting-submit': {
        const parsed = parseSettingInput(event.input);
        if (!parsed.ok) { this.entry(parsed.key, { error: parsed.message }); return; }
        if (!this.synced) { this.entry(parsed.key, { error: 'つながっていません。つながってから試してください。' }); return; }
        const { key, value } = parsed;
        this.entry(key, { pending: this.send({ type: 'settings.set', payload: { key, value } as never }) });
        return;
      }
      case 'setting-reset':
        if (!this.synced) { this.entry(event.key, { error: 'つながっていません。つながってから試してください。' }); return; }
        this.entry(event.key, { pending: this.send({ type: 'settings.reset', payload: { key: event.key } }) });
        return;
    }
  }

  // The socket and the stream.

  private connect(): void {
    this.set({ link: 'connecting' });
    this.effects.push({ kind: 'connect' });
  }

  private sync(resume: AppState['cursor'] | null): void {
    this.set({ link: 'syncing', syncRequest: this.send({ type: 'session.sync', payload: { resume: resume ?? null } }) });
  }

  private closed(code: number): void {
    this.set({ socketOpen: false, syncRequest: undefined });
    if (code === 1008) { this.set({ link: 'signed-out' }); this.effects.push({ kind: 'sign-in-again' }); return; }
    if (code === 4001) { this.set({ link: 'replaced' }); return; }
    this.waitThenReconnect();
  }

  private waitThenReconnect(): void {
    const delayMs = Math.min(MAX_WAIT_MS, 1000 * 2 ** this.state.attempts);
    this.set({ link: this.state.socketOpen ? this.state.link : 'waiting', attempts: this.state.attempts + 1 });
    this.effects.push({ kind: 'reconnect-later', delayMs });
  }

  private receive(text: string): void {
    const envelope = readEnvelope(text);
    if (!envelope) return;
    const placing = place(this.state.cursor, envelope);
    if (placing === 'skip') return;
    if (placing === 'resync') { this.sync(null); return; }
    if (placing === 'apply') this.set({ cursor: envelope.position });
    this.apply(envelope.event, envelope.requestId);
  }

  private apply(event: ServerEvent, requestId: string | undefined): void {
    switch (event.type) {
      case 'session.snapshot': this.snapshot(event.snapshot); return;
      case 'conversation.message': {
        const { message } = event;
        if (this.state.messages.some(shown => shown.messageId === message.messageId)) return;
        const changes: Partial<AppState> = { messages: [...this.state.messages, message] };
        if (message.kind === 'message' && message.eventId && !this.state.pending[message.eventId]) {
          changes.pending = { ...this.state.pending, [message.eventId]: 'queued' };
        }
        if (message.kind === 'reply') changes.unreadReplyCount = this.state.unreadReplyCount + 1;
        if (message.kind === 'notice' && !this.state.unacknowledged.includes(message.messageId)) {
          changes.unacknowledged = [...this.state.unacknowledged, message.messageId];
        }
        this.set(changes);
        return;
      }
      case 'avatar.expression': this.set({ expression: event.expression }); return;
      case 'conversation.thinking': this.set({ thinkingLine: event.line === '' ? undefined : event.line }); return;
      case 'conversation.event.completed': {
        const { [event.eventId]: _done, ...pending } = this.state.pending;
        this.set({ pending, ...(Object.keys(pending).length === 0 ? { thinkingLine: undefined } : {}) });
        return;
      }
      case 'conversation.read':
        this.set({ readThrough: event.readThroughMessageId, unreadReplyCount: event.unreadReplyCount });
        return;
      case 'notification.acked':
        this.set({ unacknowledged: this.state.unacknowledged.filter(id => id !== event.notificationId) });
        return;
      case 'approval.pending':
        if (this.state.approvals.some(shown => shown.approvalId === event.approval.approvalId)) return;
        this.set({ approvals: [...this.state.approvals, event.approval] });
        return;
      case 'approval.resolved': {
        const { resolution } = event;
        const closed = this.state.approvals.find(shown => shown.approvalId === resolution.approvalId);
        const { [resolution.approvalId]: _flow, ...flows } = this.state.flows;
        this.set({
          approvals: this.state.approvals.filter(shown => shown !== closed), flows,
          results: [resolutionWords(closed?.target.channel, resolution), ...this.state.results].slice(0, RESULTS_KEPT),
        });
        return;
      }
      case 'settings.changed': this.set({ settings: event.settings }); return;
      case 'session.renewed': case 'ignored': return;
      case 'command.accepted': this.accepted(event.accepted, requestId); return;
      case 'command.rejected': this.refused(event.code, requestId, codeWords(event.code)); return;
      case 'service.unavailable': this.unavailable(event.code, event.deviceId, requestId); return;
    }
  }

  private snapshot(snapshot: Snapshot): void {
    const wasUnsent = this.state.outbox.filter(item => item.status === 'sending');
    this.set({
      link: 'synced', attempts: 0, syncRequest: undefined, unavailable: undefined,
      messages: snapshot.messages, expression: snapshot.expression, thinkingLine: undefined,
      pending: Object.fromEntries(snapshot.pendingEvents.filter(item => item.state === 'queued' || item.state === 'processing')
        .map(item => [item.eventId, item.state])),
      readThrough: snapshot.readThroughMessageId, unreadReplyCount: snapshot.unreadReplyCount,
      unacknowledged: snapshot.unacknowledgedNotificationIds, localReads: [],
      approvals: snapshot.pendingApprovals, flows: keepFlows(this.state.flows, snapshot.pendingApprovals),
      ...(snapshot.settings ? { settings: snapshot.settings } : {}), settingEntries: {},
    });
    this.device(snapshot.deviceId);
    if (snapshot.avatarVersion && snapshot.avatarVersion !== this.state.avatar?.version && !this.state.avatarRequested) {
      this.set({ avatarRequested: true });
      this.effects.push({ kind: 'fetch-avatar' });
    }
    this.resendUnsent(wasUnsent);
    this.registerPush();
  }

  /** On every sync, as the iPhone does: the server keeps one subscription per device and drops it when it is gone. */
  private registerPush(): void {
    const { subscription } = this.state.push;
    if (this.synced && subscription) this.send({ type: 'push.register', payload: { subscription } });
  }

  /** After a sync, what was written while away goes; the server answers a request it has already the same. */
  private resendUnsent(items = this.state.outbox.filter(item => item.status === 'sending')): void {
    for (const item of items) this.send({ type: 'conversation.send', payload: { text: item.text } }, item.requestId);
  }

  private device(deviceId: string | undefined): void {
    if (!deviceId || deviceId === this.state.deviceId) return;
    this.set({ deviceId });
    this.effects.push({ kind: 'remember-device', deviceId });
  }

  private accepted(accepted: Accepted, requestId: string | undefined): void {
    if (requestId && requestId === this.state.syncRequest && accepted.mode === 'resume') {
      this.set({ link: 'synced', attempts: 0, syncRequest: undefined, unavailable: undefined });
      this.device(accepted.deviceId);
      this.resendUnsent();
      this.registerPush();
      return;
    }
    if (!requestId) return;
    const read = this.state.localReads.find(change => change.requestId === requestId);
    if (read) {
      this.set({ localReads: this.state.localReads.filter(change => change !== read) });
      if (accepted.readThroughMessageId) this.set({ readThrough: accepted.readThroughMessageId, unreadReplyCount: accepted.unreadReplyCount ?? this.state.unreadReplyCount });
      if (accepted.notificationId) this.set({ unacknowledged: this.state.unacknowledged.filter(id => id !== accepted.notificationId) });
      return;
    }
    if (this.state.outbox.some(item => item.requestId === requestId)) {
      const pending = { ...this.state.pending };
      if (accepted.eventId && (accepted.state === 'queued' || accepted.state === 'processing')) pending[accepted.eventId] ??= accepted.state;
      else if (accepted.eventId) delete pending[accepted.eventId];
      this.set({ outbox: this.state.outbox.filter(item => item.requestId !== requestId), pending });
      return;
    }
    const approvalId = this.flowOf(requestId);
    if (approvalId) {
      // The approval itself goes when `approval.resolved` comes; until then it stays as being sent.
      return;
    }
    const key = this.settingOf(requestId);
    if (key) {
      this.set({ settingEntries: { ...this.state.settingEntries, [key]: {} }, ...(accepted.settings ? { settings: accepted.settings } : {}) });
    }
  }

  private refused(code: string, requestId: string | undefined, words: string): void {
    if (!requestId) return;
    if (requestId === this.state.syncRequest) { this.set({ unavailable: code }); this.waitThenReconnect(); return; }
    const read = this.state.localReads.find(change => change.requestId === requestId);
    if (read) { this.set({ localReads: this.state.localReads.filter(change => change !== read) }); return; }
    if (this.state.outbox.some(item => item.requestId === requestId)) {
      this.set({ outbox: this.state.outbox.map(item => (item.requestId === requestId ? { ...item, status: 'failed', code } : item)) });
      return;
    }
    const approvalId = this.flowOf(requestId);
    if (approvalId) { this.set({ flows: { ...this.state.flows, [approvalId]: { step: 'idle', error: words } } }); return; }
    const key = this.settingOf(requestId);
    if (key) this.set({ settingEntries: { ...this.state.settingEntries, [key]: { error: words } } });
  }

  private unavailable(code: string, deviceId: string | undefined, requestId: string | undefined): void {
    if (requestId && requestId === this.state.syncRequest) {
      this.device(deviceId);
      this.set({ unavailable: code, syncRequest: undefined, link: 'syncing' });
      this.waitThenReconnect();
      return;
    }
    this.refused(code, requestId, unavailableWords(code));
  }

  // The chat.

  private sendMessage(text: string): void {
    if (text.trim() === '') return;
    const requestId = `${this.state.idPrefix}-${this.state.nextId}`;
    this.set({ nextId: this.state.nextId + 1, sentCount: this.state.sentCount + 1,
      outbox: [...this.state.outbox, { requestId, text, status: 'sending' }] });
    if (this.synced) this.send({ type: 'conversation.send', payload: { text } }, requestId);
  }

  private unacknowledged(): string[] {
    const checking = new Set(this.state.localReads.filter(change => change.kind === 'ack').map(change => change.id));
    return this.state.unacknowledged.filter(id => !checking.has(id));
  }

  /** While the chat is in sight, what has come is read, up to the last line. */
  readIfSeen(): void {
    const { screen, visible, messages } = this.state;
    if (screen !== 'chat' || !visible || !this.synced || messages.length === 0) return;
    if (!messages.slice(readIndex(this.state) + 1).some(message => message.kind === 'reply')) return;
    const through = messages.at(-1)!.messageId;
    this.set({ localReads: [...this.state.localReads, {
      requestId: this.send({ type: 'conversation.read', payload: { throughMessageId: through } }), kind: 'read', id: through,
    }] });
  }

  // The approvals.

  private flow(approvalId: string, next: (flow: ApprovalFlow) => ApprovalFlow): void {
    if (!this.state.approvals.some(approval => approval.approvalId === approvalId)) return;
    const flow = this.state.flows[approvalId] ?? { step: 'idle' };
    if (flow.step === 'sending') return;
    this.set({ flows: { ...this.state.flows, [approvalId]: next(flow) } });
  }

  private choose(event: Extract<AppEvent, { type: 'approval-choose' }>): void {
    const approval = this.state.approvals.find(shown => shown.approvalId === event.approvalId);
    if (!approval) return;
    const editing = (this.state.flows[event.approvalId]?.step ?? 'idle') === 'editing';
    if (event.decision === 'edit' && (event.text ?? '').trim() === '') {
      this.flow(event.approvalId, () => ({ step: 'editing', error: '送る本文を入れてください。' }));
      return;
    }
    // A post to the channel itself has no placement (the contract ignores one); nothing is sent for it.
    const placement = approval.target.replyTo && event.decision !== 'reject' ? event.placement : undefined;
    this.flow(event.approvalId, () => ({
      step: 'confirming', decision: event.decision, editing,
      ...(event.decision === 'edit' ? { text: event.text! } : {}), ...(placement ? { placement } : {}),
    }));
  }

  private confirm(approvalId: string): void {
    const approval = this.state.approvals.find(shown => shown.approvalId === approvalId);
    const flow = this.state.flows[approvalId];
    if (!approval || flow?.step !== 'confirming') return;
    if (!this.synced) { this.set({ flows: { ...this.state.flows, [approvalId]: { step: 'idle', error: 'つながっていません。つながってから決めてください。' } } }); return; }
    const requestId = this.send({ type: 'approval.decide', payload: {
      approvalId, revision: approval.revision, decision: flow.decision,
      ...(flow.text !== undefined ? { text: flow.text } : {}), ...(flow.placement ? { placement: flow.placement } : {}),
    } });
    this.set({ flows: { ...this.state.flows, [approvalId]: { step: 'sending', requestId } } });
  }

  private flowOf(requestId: string): string | undefined {
    return Object.entries(this.state.flows).find(([, flow]) => flow.step === 'sending' && flow.requestId === requestId)?.[0];
  }

  // The settings.

  private entry(key: SettingKey, entry: { pending?: string; error?: string }): void {
    this.set({ settingEntries: { ...this.state.settingEntries, [key]: entry } });
  }

  private settingOf(requestId: string): SettingKey | undefined {
    return (Object.entries(this.state.settingEntries) as [SettingKey, { pending?: string }][]).find(([, entry]) => entry.pending === requestId)?.[0];
  }
}

/** The flows of approvals still waiting, except those being sent, whose answer a new sync will not bring. */
function keepFlows(flows: AppState['flows'], approvals: Approval[]): AppState['flows'] {
  const waiting = new Set(approvals.map(approval => approval.approvalId));
  return Object.fromEntries(Object.entries(flows).filter(([id, flow]) => waiting.has(id) && flow.step !== 'sending'));
}

/**
 * Where reading has got to in the messages, counting this device's reads not answered yet; -1 before all of them. A
 * position not among the messages is older than them.
 */
export function readIndex(state: Pick<AppState, 'messages' | 'readThrough' | 'localReads'>): number {
  const positions = state.localReads.filter(change => change.kind === 'read').map(change => change.id);
  if (state.readThrough) positions.push(state.readThrough);
  return Math.max(-1, ...positions.map(id => state.messages.findLastIndex(message => message.messageId === id)));
}
