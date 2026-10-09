import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SlackArchive } from '../src/server/slack-archive.ts';
import { relayToOwner, SlackMentionTyping, SlackWorkspace } from '../src/server/slack.ts';
import type { Attention } from '../src/server/sources.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { FakeSlack, PNG, tsAt } from './support/fake-slack.ts';

/**
 * Fork (ADR F01): the owner talks with natsumi in their own Slack channel. What they say there becomes a message of
 * the conversation, not an attention; what she says to them is posted there.
 */

const AT = '2026-09-25T05:32:05Z';

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-slack-owner-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const clock = Date.parse(AT) + 60_000;
  const archive = new SlackArchive({ db, directory: join(root, 'sources', 'slack'), timeZone: 'Asia/Tokyo', now: () => clock });
  const slack = new FakeSlack();
  slack.addChannel({ id: 'C1', name: 'natsumi', isIm: false });
  slack.addChannel({ id: 'C2', name: 'dev', isIm: false });
  const told: Attention[] = [];
  const said: { requestId: string; text: string }[] = [];
  const typing: string[] = [];
  const workspace = new SlackWorkspace({
    name: 'work', api: slack, socket: slack, archive, reaction: 'eyes', backfillDays: 3, maxImageBytes: 1024 * 1024, now: () => clock,
    attention: attention => { told.push(attention); },
    owner: { userId: 'U1', channel: 'C1', say: input => { said.push(input); }, typing: (channel, ts) => { typing.push(`owner ${channel} ${ts}`); } },
    typing: (channel, threadTs) => { typing.push(`mention ${channel} ${threadTs}`); },
  });
  await workspace.start();
  t.after(async () => {
    await workspace.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { slack, workspace, archive, told, said, typing };
}

function message(fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '', ts: tsAt(AT), ...fields };
}

test('the owner in their channel, in a thread there and in the DM goes to the conversation once, with the reaction', async t => {
  const f = await setup(t);
  f.slack.addChannel({ id: 'D1', isIm: true, user: 'U1' });
  const ts = tsAt(AT);
  f.slack.emit(message({ text: '明日の予定は？', ts }));
  f.slack.emit(message({ text: '明日の予定は？', ts }));
  f.slack.emit(message({ text: '<@UBOT> スレッドでも', ts: tsAt('2026-09-25T05:33:00Z'), thread_ts: ts }));
  f.slack.emit(message({ channel: 'D1', channel_type: 'im', text: 'DM でも', ts: tsAt('2026-09-25T05:34:00Z') }));
  f.slack.emit({ type: 'message', subtype: 'message_changed', channel: 'C1', channel_type: 'channel', ts: tsAt('2026-09-25T05:35:00Z'),
    message: { type: 'message', user: 'U1', text: '直した', ts, edited: { user: 'U1', ts: tsAt('2026-09-25T05:35:00Z') } } });
  await f.workspace.idle();
  assert.deepEqual(f.said, [
    { requestId: `slack:C1:${ts}`, text: '明日の予定は？' },
    { requestId: `slack:C1:${tsAt('2026-09-25T05:33:00Z')}`, text: '@natsumi スレッドでも' },
    { requestId: `slack:D1:${tsAt('2026-09-25T05:34:00Z')}`, text: 'DM でも' },
  ]);
  assert.deepEqual(f.told, []);
  assert.equal(f.slack.reactions.length, 3);
  assert.deepEqual(f.typing, [`owner C1 ${ts}`, `owner C1 ${ts}`, `owner D1 ${tsAt('2026-09-25T05:34:00Z')}`], 'under the thread a reply would be in');
  assert.ok(f.archive.has('work', 'C1', ts), 'still written to the files');
});

test('anyone else in the owner\'s channel, and the owner elsewhere, are what they were upstream', async t => {
  const f = await setup(t);
  f.slack.emit(message({ user: 'U2', text: '<@UBOT> 佐藤です' }));
  f.slack.emit(message({ channel: 'C2', text: '<@UBOT> dev から', ts: tsAt('2026-09-25T05:33:00Z') }));
  await f.workspace.idle();
  assert.deepEqual(f.said, []);
  assert.deepEqual(f.told.map(attention => attention.kind), ['mention', 'mention']);
  assert.deepEqual(f.typing, [`mention C1 ${tsAt(AT)}`, `mention C2 ${tsAt('2026-09-25T05:33:00Z')}`]);
});

test('typing under a mention is sent again until the turn that took it is done and no agent asked since is waiting, and never past the limit', async () => {
  const slack = new FakeSlack();
  let listener!: () => void;
  let done = false;
  let waiting = 1;
  const typing = new SlackMentionTyping({ loop: { subscribe: l => { listener = l as () => void; return () => {}; } }, api: slack,
    done: place => place.file === 'f2' && place.path === 'p' && done, waitingAgents: () => waiting, intervalMs: 10, maxMs: 1_000 });
  typing.start('C2', '1.0', { file: 'f2', path: 'p' });
  await new Promise(resolve => setTimeout(resolve, 35));
  listener();
  assert.ok(slack.statuses.length >= 3 && slack.statuses.every(s => s.status !== ''), 'sent again while the turn runs');
  done = true;
  listener();
  assert.notEqual(slack.statuses.at(-1)!.status, '', 'an agent is still waiting');
  waiting = 0;
  listener();
  assert.deepEqual(slack.statuses.at(-1), { channel: 'C2', threadTs: '1.0', status: '' });
  const count = slack.statuses.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(slack.statuses.length, count, 'nothing after it ended');
  const limited = new SlackMentionTyping({ loop: { subscribe: () => () => {} }, api: slack, done: () => false, intervalMs: 5, maxMs: 20 });
  limited.start('C2', '2.0', { file: 'f2', path: 'q' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(slack.statuses.filter(s => s.threadTs === '2.0').at(-1)!.status, '');
  limited.stop();
  typing.stop();
});

test('a reply to a message the owner sent from elsewhere is not posted; one to a message from Slack, a notice and a reply to none are', async () => {
  const slack = new FakeSlack();
  let listener!: (event: { type: string; payload: Record<string, unknown> }) => void;
  relayToOwner({ loop: { subscribe: l => { listener = l; return () => {}; } }, api: slack, workspace: 'work', channel: 'C1',
    publicOrigin: 'https://natsumi.example.test', images: { read: async () => undefined },
    askedOnSlack: eventId => eventId === 'event-slack' });
  listener({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: 'デスクトップへ', replyTo: 'event-mac' } });
  listener({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: 'Slack へ', replyTo: 'event-slack' } });
  listener({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'notice', text: '知らせです' } });
  listener({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: 'ひとりごと' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(slack.posts.map(post => post.text), ['Slack へ', '知らせです', 'ひとりごと']);
});

test('what natsumi says to the owner is posted in the channel, under her expression, with a reply\'s images shown in blocks', async () => {
  const slack = new FakeSlack();
  let listener!: (event: { type: string; payload: Record<string, unknown> }) => void;
  const logs: string[] = [];
  relayToOwner({ loop: { subscribe: l => { listener = l; return () => {}; } }, api: slack, workspace: 'work', channel: 'C1',
    publicOrigin: 'https://natsumi.example.test',
    images: { read: async id => id === 'img1' ? { mimeType: 'image/png', data: PNG } : undefined }, log: line => { logs.push(line); } });
  listener({ type: 'conversation.message', payload: { role: 'owner', kind: 'message', text: '本人の発言' } });
  listener({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: 'おはよう', expression: 'smile' } });
  listener({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'notice', text: '知らせです' } });
  listener({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: '描きました',
    images: [{ imageId: 'img1', mimeType: 'image/png', bytes: PNG.length }] } });
  listener({ type: 'avatar.changed', payload: { expression: 'smile' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(slack.posts, [
    { channel: 'C1', text: 'おはよう', iconUrl: 'https://natsumi.example.test/avatar/smile.png' },
    { channel: 'C1', text: '知らせです', iconUrl: 'https://natsumi.example.test/avatar/neutral.png' },
    { channel: 'C1', text: '描きました', iconUrl: 'https://natsumi.example.test/avatar/neutral.png', blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '描きました' } },
      { type: 'image', slack_file: { id: 'F1' }, alt_text: 'img1.png' },
    ] },
  ]);
  assert.deepEqual(slack.unshared, [{ id: 'F1', filename: 'img1.png', data: PNG }]);
  assert.deepEqual(slack.uploads, [], 'nothing is shared by the upload itself');
  assert.deepEqual(logs, []);
});

function relayed(slack: FakeSlack, logs: string[]) {
  let listener!: (event: { type: string; payload: Record<string, unknown> }) => void;
  relayToOwner({ loop: { subscribe: l => { listener = l; return () => {}; } }, api: slack, workspace: 'work', channel: 'C1',
    publicOrigin: 'https://natsumi.example.test', retryDelays: [0, 0],
    images: { read: async () => ({ mimeType: 'image/png', data: PNG }) }, log: line => { logs.push(line); } });
  return listener;
}

test('each image of a reply gets its own block, after the text', async () => {
  const slack = new FakeSlack();
  const logs: string[] = [];
  relayed(slack, logs)({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: '二枚', expression: 'smile',
    images: [{ imageId: 'a', mimeType: 'image/png' }, { imageId: 'b', mimeType: 'image/png' }] } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(slack.posts.map(post => post.blocks), [[
    { type: 'section', text: { type: 'mrkdwn', text: '二枚' } },
    { type: 'image', slack_file: { id: 'F1' }, alt_text: 'a.png' },
    { type: 'image', slack_file: { id: 'F2' }, alt_text: 'b.png' },
  ]]);
  assert.equal(slack.posts[0]!.iconUrl, 'https://natsumi.example.test/avatar/smile.png');
  assert.deepEqual(logs, []);
});

test('image blocks Slack keeps refusing are tried three times, then the images go up as before, under the bot\'s icon', async () => {
  const slack = new FakeSlack();
  const logs: string[] = [];
  let tries = 0;
  const post = slack.postMessage.bind(slack);
  slack.postMessage = async (...args) => { tries += 1; return post(...args); };
  slack.fail('postMessage', 'C1', 'chat.postMessage', 'invalid_blocks');
  relayed(slack, logs)({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: '描きました',
    images: [{ imageId: 'img1', mimeType: 'image/png' }] } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(tries, 3);
  assert.deepEqual(slack.uploads, [{ channel: 'C1', files: [{ filename: 'img1.png', data: PNG }], initialComment: '描きました' }]);
  assert.deepEqual(logs, ['slack (work): images went up without her icon (chat.postMessage: invalid_blocks)']);
});

test('any other refusal of the blocks goes straight to the upload', async () => {
  const slack = new FakeSlack();
  const logs: string[] = [];
  let tries = 0;
  const post = slack.postMessage.bind(slack);
  slack.postMessage = async (...args) => { tries += 1; return post(...args); };
  slack.fail('postMessage', 'C1', 'chat.postMessage', 'missing_scope');
  relayed(slack, logs)({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: '描きました',
    images: [{ imageId: 'img1', mimeType: 'image/png' }] } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(tries, 1);
  assert.equal(slack.uploads.length, 1);
});

test('with slack.avatarBaseUrl the owner\'s channel gets her icon from there', async () => {
  const slack = new FakeSlack();
  let listener!: (event: { type: string; payload: Record<string, unknown> }) => void;
  relayToOwner({ loop: { subscribe: l => { listener = l; return () => {}; } }, api: slack, workspace: 'work', channel: 'C1',
    publicOrigin: 'https://natsumi.example.test', avatarBaseUrl: 'https://cdn.example.test/avatar', images: { read: async () => undefined } });
  listener({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: 'おはよう', expression: 'smile' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(slack.posts[0]!.iconUrl, 'https://cdn.example.test/avatar/smile.png');
});

test('with slack.owner.username the owner\'s channel shows it over every post, text and image blocks alike; absent, it is not sent', async () => {
  const named = new FakeSlack();
  let listener!: (event: { type: string; payload: Record<string, unknown> }) => void;
  relayToOwner({ loop: { subscribe: l => { listener = l; return () => {}; } }, api: named, workspace: 'work', channel: 'C1',
    publicOrigin: 'https://natsumi.example.test', username: 'natsumi (owner)',
    images: { read: async id => id === 'img1' ? { mimeType: 'image/png', data: PNG } : undefined } });
  listener({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: 'おはよう', expression: 'smile' } });
  listener({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: '描きました',
    images: [{ imageId: 'img1', mimeType: 'image/png' }] } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(named.posts.map(post => post.username), ['natsumi (owner)', 'natsumi (owner)']);

  const unnamed = new FakeSlack();
  relayToOwner({ loop: { subscribe: l => { listener = l; return () => {}; } }, api: unnamed, workspace: 'work', channel: 'C1',
    publicOrigin: 'https://natsumi.example.test', images: { read: async () => undefined } });
  listener({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', text: 'おはよう', expression: 'smile' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal('username' in unnamed.posts[0]!, false);
});
