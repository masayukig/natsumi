import assert from 'node:assert/strict';
import test from 'node:test';
import { readAvatarManifest } from '../src/shared/protocol/avatar.ts';
import { encodeCommand, readEnvelope } from '../src/shared/protocol/envelope.ts';

/** The browser's reading of what the server says (docs/client-contract.md), and its writing of the commands. */

const envelope = (type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, epoch: 'epoch-1', streamId: 'stream-1', seq: 3, type, payload, ...extra });

const settings = {
  modelRoute: { value: 'plus', config: 'local', overridden: true, inUse: 'local',
    routes: [{ name: 'local', provider: 'p', model: 'm', ready: true }, { name: 'plus', provider: 'p', model: 'm', ready: true }] },
  turnFold: { value: 'off', config: 'off', overridden: false, inUse: 'off' },
  eventModelCalls: { value: 12, config: 8, overridden: true },
  eventTimeoutMinutes: { value: 10, config: 10, overridden: false },
  reviewModelCalls: { value: 40, config: 40, overridden: false },
  reviewTimeoutMinutes: { value: 30, config: 30, overridden: false },
  awakeHours: { value: { start: '07:00', end: '23:00' }, config: { start: '07:00', end: '23:00' }, overridden: false, timeZone: 'Asia/Tokyo' },
  pingIntervalMinutes: { value: false, config: 180, overridden: true },
  judgeLogprobs: { value: 'on', config: 'on', overridden: false, available: true },
  judgeJev: { value: 'on', config: 'off', overridden: true, available: true },
  judgeAdopted: { value: 'jev', config: 'logprobs', overridden: true },
  judgeLogprobsThresholds: { value: { owner: 0.5, return: 0.9 }, config: { owner: 0.5, return: 0.9 }, overridden: false },
  judgeJevThresholds: { value: { owner: 0.6, return: 0.95 }, config: { owner: 0.5, return: 0.9 }, overridden: true },
  curatorRoute: { value: null, config: 'local', overridden: true, night: 'plus', outside: ['plus'] },
  curatorModelCalls: { value: 60, config: 60, overridden: false },
  curatorTimeoutMinutes: { value: 45, config: 30, overridden: true },
};

test('a message is read with its place in the stream, its request and its fields', () => {
  const read = readEnvelope(envelope('conversation.message', {
    messageId: 'r1', role: 'natsumi', kind: 'reply', text: 'こんにちは', replyTo: 'e1', expression: 'happy',
    createdAt: '2026-01-01T00:00:00.000Z', images: [{ imageId: 'image-1', mimeType: 'image/png', bytes: 10, width: 4, height: 3 }],
  }, { requestId: 'q1' }));
  assert.deepEqual(read, {
    position: { epoch: 'epoch-1', streamId: 'stream-1', seq: 3 }, requestId: 'q1',
    event: { type: 'conversation.message', message: {
      messageId: 'r1', role: 'natsumi', kind: 'reply', text: 'こんにちは', replyTo: 'e1', expression: 'happy',
      createdAt: '2026-01-01T00:00:00.000Z', images: [{ imageId: 'image-1', mimeType: 'image/png', bytes: 10, width: 4, height: 3 }],
    } },
  });
});

test('a feeling it does not know is read as none, and so is one that is missing', () => {
  const read = readEnvelope(envelope('conversation.message', { messageId: 'r1', role: 'natsumi', kind: 'reply', text: 'x', createdAt: 't', expression: 'angry' }));
  assert.equal(read?.event.type, 'conversation.message');
  assert.ok(read?.event.type === 'conversation.message' && !('expression' in read.event.message));
});

test('the snapshot is read whole, the settings with it', () => {
  const read = readEnvelope(envelope('session.snapshot', {
    deviceId: 'device-1', messages: [], pendingEvents: [{ eventId: 'e1', messageId: 'm1', state: 'processing' }],
    avatar: { expression: 'thinking' }, readThroughMessageId: null, unreadReplyCount: 2, unacknowledgedNotificationIds: ['n1'],
    pendingApprovals: [], modelRoutes: {}, sessionExpiresAt: 't', avatarVersion: 'abc', settings,
  }));
  assert.deepEqual(read?.event, { type: 'session.snapshot', snapshot: {
    deviceId: 'device-1', messages: [], pendingEvents: [{ eventId: 'e1', messageId: 'm1', state: 'processing' }],
    expression: 'thinking', readThroughMessageId: null, unreadReplyCount: 2, unacknowledgedNotificationIds: ['n1'],
    pendingApprovals: [], avatarVersion: 'abc', settings,
  } });
});

test('an approval keeps what the owner is shown of it', () => {
  const approval = {
    approvalId: 'a1', revision: 1, kind: 'slack-post', createdAt: 't0', expiresAt: 't1',
    target: { channel: 'work/#dev', placement: 'thread', replyTo: { speaker: '山田', at: '2026-09-25 14:32:05', text: '明日？' } },
    text: '大丈夫です。', expression: 'happy', images: [{ imageId: 'image-1', mimeType: 'image/png', bytes: 3 }],
    reason: { verdict: 'owner', issues: [{ name: 'promise', label: '約束', score: 0.5, flagged: true }] }, history: [{ text: '前の', issues: [] }],
  };
  assert.deepEqual(readEnvelope(envelope('approval.pending', approval))?.event, { type: 'approval.pending', approval });
});

test('an approval is placed in one of three places, and its odds keep the places named and drop what is not one (ADR 0062)', () => {
  const approval = (placement: string, probabilities?: Record<string, unknown>) => ({
    approvalId: 'a1', revision: 1, kind: 'slack-post', createdAt: 't0', expiresAt: 't1',
    target: { channel: 'work/#dev', placement, replyTo: { speaker: '山田', at: '2026-09-25 14:32:05', text: '明日？' } },
    text: '大丈夫です。', reason: { verdict: 'owner', issues: [], ...(probabilities ? { placement: { probabilities } } : {}) }, history: [],
  });
  const read = (value: unknown) => {
    const event = readEnvelope(envelope('approval.pending', value))?.event;
    return event?.type === 'approval.pending' ? event.approval : undefined;
  };
  for (const placement of ['thread', 'channel', 'broadcast']) assert.equal(read(approval(placement))?.target.placement, placement);
  assert.equal(read(approval('elsewhere')), undefined);
  assert.deepEqual(read(approval('broadcast', { thread: 0.1, channel: 0.2, broadcast: 0.7 }))?.reason.placement,
    { probabilities: { thread: 0.1, channel: 0.2, broadcast: 0.7 } });
  assert.deepEqual(read(approval('thread', { thread: 0.8, broadcast: 0.2, elsewhere: 0.5, channel: 'x' }))?.reason.placement,
    { probabilities: { thread: 0.8, broadcast: 0.2 } }, 'not every place need be there');
  assert.equal(read(approval('thread', { elsewhere: 1 }))?.reason.placement, undefined);
});

test('the answers to commands and the other events are read too', () => {
  const event = (type: string, payload: unknown) => readEnvelope(envelope(type, payload))?.event;
  assert.deepEqual(event('command.accepted', { messageId: 'm1', eventId: 'e1', state: 'queued' }),
    { type: 'command.accepted', accepted: { messageId: 'm1', eventId: 'e1', state: 'queued' } });
  assert.deepEqual(event('command.accepted', { settings }), { type: 'command.accepted', accepted: { settings } });
  assert.deepEqual(event('command.accepted', { deviceId: 'd', mode: 'resume', sessionExpiresAt: 't' }),
    { type: 'command.accepted', accepted: { deviceId: 'd', mode: 'resume' } });
  assert.deepEqual(event('command.rejected', { code: 'stale-revision' }), { type: 'command.rejected', code: 'stale-revision' });
  assert.deepEqual(event('service.unavailable', { code: 'stopping', deviceId: 'd' }), { type: 'service.unavailable', code: 'stopping', deviceId: 'd' });
  assert.deepEqual(event('avatar.expression', { expression: 'sad' }), { type: 'avatar.expression', expression: 'sad' });
  assert.deepEqual(event('conversation.thinking', { line: 'メモ' }), { type: 'conversation.thinking', line: 'メモ' });
  assert.deepEqual(event('conversation.event.completed', { eventId: 'e1', messageId: 'm1', status: 'replied' }),
    { type: 'conversation.event.completed', eventId: 'e1' });
  assert.deepEqual(event('conversation.read', { readThroughMessageId: 'r1', unreadReplyCount: 0 }),
    { type: 'conversation.read', readThroughMessageId: 'r1', unreadReplyCount: 0 });
  assert.deepEqual(event('notification.acked', { notificationId: 'n1', acknowledgedAt: 't' }), { type: 'notification.acked', notificationId: 'n1' });
  assert.deepEqual(event('approval.resolved', { approvalId: 'a1', revision: 1, state: 'edited', resolvedAt: 't', delivery: 'sent', sentText: '直した' }),
    { type: 'approval.resolved', resolution: { approvalId: 'a1', state: 'edited', delivery: 'sent', sentText: '直した' } });
  assert.deepEqual(event('settings.changed', { settings }), { type: 'settings.changed', settings });
});

test('an event it does not know, or one whose payload is not the contract’s, still takes its place in the stream', () => {
  assert.deepEqual(readEnvelope(envelope('model.routes', {})), { position: { epoch: 'epoch-1', streamId: 'stream-1', seq: 3 }, event: { type: 'ignored' } });
  assert.deepEqual(readEnvelope(envelope('conversation.message', { text: 1 }))?.event, { type: 'ignored' });
  assert.deepEqual(readEnvelope(envelope('settings.changed', { settings: { ...settings, turnFold: { value: 'sometimes' } } }))?.event, { type: 'ignored' });
  const { night: _night, ...withoutNight } = settings.curatorRoute;
  assert.deepEqual(readEnvelope(envelope('settings.changed', { settings: { ...settings, curatorRoute: withoutNight } }))?.event, { type: 'ignored' },
    'the curator\'s route says where the next night runs');
  assert.deepEqual(readEnvelope(envelope('settings.changed', { settings: { ...settings, curatorRoute: { ...settings.curatorRoute, outside: 'plus' } } }))?.event,
    { type: 'ignored' }, 'and which routes are outside services');
  const { available: _available, ...withoutAvailable } = settings.judgeJev;
  assert.deepEqual(readEnvelope(envelope('settings.changed', { settings: { ...settings, judgeJev: withoutAvailable } }))?.event, { type: 'ignored' },
    'a judge is listed with whether it can be turned on');
});

test('what is not an envelope at all is not read', () => {
  for (const text of ['not json', '[]', '{"v":2,"epoch":"e","streamId":"s","seq":1,"type":"x","payload":{}}',
    '{"v":1,"streamId":"s","seq":1,"type":"x","payload":{}}', '{"v":1,"epoch":"e","streamId":"s","seq":-1,"type":"x","payload":{}}']) {
    assert.equal(readEnvelope(text), undefined, text);
  }
});

test('a command is written as the contract’s envelope, with the device when there is one', () => {
  assert.deepEqual(JSON.parse(encodeCommand({ requestId: 'q1', deviceId: 'd1', command: { type: 'conversation.send', payload: { text: 'やあ' } } })),
    { v: 1, requestId: 'q1', deviceId: 'd1', type: 'conversation.send', payload: { text: 'やあ' } });
  assert.deepEqual(JSON.parse(encodeCommand({ requestId: 'q2', command: { type: 'session.sync', payload: { resume: null } } })),
    { v: 1, requestId: 'q2', type: 'session.sync', payload: { resume: null } });
});

test('the avatar’s list gives its version, its name and the files it has', () => {
  assert.deepEqual(readAvatarManifest({ version: 'v1', id: 'natsumi', name: 'なつみ',
    files: [{ path: 'avatar.json', bytes: 1, sha256: 'x' }, { path: 'icons/happy.webp', bytes: 1, sha256: 'y' }] }),
  { version: 'v1', name: 'なつみ', files: ['avatar.json', 'icons/happy.webp'] });
  assert.equal(readAvatarManifest({ version: 'v1', files: [] }), undefined);
  assert.equal(readAvatarManifest('nope'), undefined);
});
