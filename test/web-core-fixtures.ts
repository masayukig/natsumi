import type { Approval, ShownMessage } from '../src/shared/protocol/conversation.ts';
import type { SettingsView } from '../src/shared/protocol/settings.ts';
import type { AppEvent } from '../src/web/core/events.ts';
import type { Effect } from '../src/web/core/effects.ts';
import { initialState, mediate } from '../src/web/core/mediator.ts';
import type { AppState, Screen } from '../src/web/core/state.ts';

/** What the tests of the browser's core share: the server's words as envelopes, and a mediator driven through events. */

let seq = 0;
export const EPOCH = 'epoch-1';
export const STREAM = 'stream-1';

/** An event from the server, as the socket hands it over. */
export function server(type: string, payload: unknown, options: { seq?: number; requestId?: string; epoch?: string } = {}): AppEvent {
  if (options.seq !== undefined) seq = options.seq; else if (type !== 'conversation.thinking' && type !== 'session.renewed') seq += 1;
  return { type: 'socket-message', text: JSON.stringify({ v: 1, epoch: options.epoch ?? EPOCH, streamId: STREAM, seq, type, payload,
    ...(options.requestId ? { requestId: options.requestId } : {}) }) };
}

export const settingsView = (overrides: Partial<SettingsView> = {}): SettingsView => ({
  modelRoute: { value: 'local', config: 'local', overridden: false, inUse: 'local', routes: [
    { name: 'local', provider: 'natsumi-compatible', model: 'example-model', ready: true },
    { name: 'plus', provider: 'openai-codex', model: 'example-plus-model', ready: true },
    { name: 'spare', provider: 'natsumi-spare', model: 'example-spare-model', ready: false },
  ] },
  turnFold: { value: 'off', config: 'off', overridden: false, inUse: 'off' },
  eventModelCalls: { value: 8, config: 8, overridden: false },
  eventTimeoutMinutes: { value: 10, config: 10, overridden: false },
  reviewModelCalls: { value: 40, config: 40, overridden: false },
  reviewTimeoutMinutes: { value: 30, config: 30, overridden: false },
  awakeHours: { value: { start: '07:00', end: '23:00' }, config: { start: '07:00', end: '23:00' }, overridden: false, timeZone: 'Asia/Tokyo' },
  pingIntervalMinutes: { value: 180, config: 180, overridden: false },
  judgeLogprobs: { value: 'on', config: 'on', overridden: false, available: true },
  judgeJev: { value: 'off', config: 'off', overridden: false, available: false },
  judgeAdopted: { value: 'logprobs', config: 'logprobs', overridden: false },
  judgeLogprobsThresholds: { value: { owner: 0.5, return: 0.9 }, config: { owner: 0.5, return: 0.9 }, overridden: false },
  judgeJevThresholds: { value: { owner: 0.6, return: 0.95 }, config: { owner: 0.5, return: 0.9 }, overridden: true },
  curatorRoute: { value: null, config: null, overridden: false, night: 'local', outside: ['plus'] },
  curatorModelCalls: { value: 60, config: 60, overridden: false },
  curatorTimeoutMinutes: { value: 30, config: 30, overridden: false },
  ...overrides,
});

export const owner = (id: string, text: string, eventId = `event-${id}`): ShownMessage =>
  ({ messageId: id, role: 'owner', kind: 'message', text, createdAt: '2026-09-29T01:00:00.000Z', eventId });
export const reply = (id: string, text: string, extra: Partial<ShownMessage> = {}): ShownMessage =>
  ({ messageId: id, role: 'natsumi', kind: 'reply', text, createdAt: '2026-09-29T01:01:00.000Z', expression: 'happy', ...extra });
export const notice = (id: string, text: string): ShownMessage =>
  ({ messageId: id, role: 'natsumi', kind: 'notice', text, createdAt: '2026-09-29T01:02:00.000Z', expression: 'neutral' });

export const approval = (id: string, extra: Partial<Approval> = {}): Approval => ({
  approvalId: id, revision: 1, kind: 'slack-post', createdAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-10-06T00:00:00.000Z',
  target: { channel: 'work/#dev', placement: 'thread', replyTo: { speaker: '山田', at: '2026-09-25 14:32:05', text: '明日は？' } },
  text: '明日は 10 時からなら大丈夫です。',
  reason: { verdict: 'owner', issues: [{ name: 'promise-for-owner', label: '本人に代わる約束・期限', score: 0.8, flagged: true },
    { name: 'not-in-thread', label: 'スレッドに無い情報', score: 0.1 }] },
  history: [], ...extra,
});

export function snapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: 'device-1', messages: [owner('m1', 'おはよう'), reply('r1', 'おはよう。', { replyTo: 'event-m1' })],
    pendingEvents: [], avatar: { expression: 'happy' }, readThroughMessageId: 'r1', unreadReplyCount: 0,
    unacknowledgedNotificationIds: [], pendingApprovals: [], modelRoutes: {}, sessionExpiresAt: 't', avatarVersion: 'v1',
    settings: settingsView(), ...extra,
  };
}

/** A mediator driven through events, keeping the state and every effect it asked for. */
export class Driver {
  state: AppState;
  effects: Effect[] = [];

  constructor(options: { screen?: Screen; deviceId?: string } = {}) {
    seq = 0;
    this.state = initialState({ screen: options.screen ?? 'chat', idPrefix: 'q', ...(options.deviceId ? { deviceId: options.deviceId } : {}) });
  }

  dispatch(...events: AppEvent[]): Effect[] {
    const taken: Effect[] = [];
    for (const event of events) {
      const result = mediate(this.state, event);
      this.state = result.state;
      taken.push(...result.effects);
    }
    this.effects.push(...taken);
    return taken;
  }

  /** The commands the effects sent, as the server would read them. */
  static sent(effects: Effect[]): { requestId: string; deviceId?: string; type: string; payload: Record<string, unknown> }[] {
    return effects.flatMap(effect => (effect.kind === 'send' ? [JSON.parse(effect.data)] : []));
  }

  /** Started, connected and synced with the snapshot given. */
  synced(extra: Record<string, unknown> = {}): this {
    this.dispatch({ type: 'started' }, { type: 'socket-opened' });
    const sync = Driver.sent(this.effects).find(command => command.type === 'session.sync')!;
    this.dispatch(server('session.snapshot', snapshot(extra), { seq: 1, requestId: sync.requestId }));
    return this;
  }
}
