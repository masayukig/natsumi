import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SlackArchive } from '../src/server/slack-archive.ts';
import { relayToOwner, SlackWorkspace } from '../src/server/slack.ts';
import type { Attention } from '../src/server/sources.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { FakeSlack, PNG, tsAt } from './support/fake-slack.ts';

/**
 * Fork (ADR 0056): the owner talks with natsumi in their own Slack channel. What they say there becomes a message of
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
  const workspace = new SlackWorkspace({
    name: 'work', api: slack, socket: slack, archive, reaction: 'eyes', backfillDays: 3, maxImageBytes: 1024 * 1024, now: () => clock,
    attention: attention => { told.push(attention); },
    owner: { userId: 'U1', channel: 'C1', say: input => { said.push(input); } },
  });
  await workspace.start();
  t.after(async () => {
    await workspace.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { slack, workspace, archive, told, said };
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
  assert.ok(f.archive.has('work', 'C1', ts), 'still written to the files');
});

test('anyone else in the owner\'s channel, and the owner elsewhere, are what they were upstream', async t => {
  const f = await setup(t);
  f.slack.emit(message({ user: 'U2', text: '<@UBOT> 佐藤です' }));
  f.slack.emit(message({ channel: 'C2', text: '<@UBOT> dev から', ts: tsAt('2026-09-25T05:33:00Z') }));
  await f.workspace.idle();
  assert.deepEqual(f.said, []);
  assert.deepEqual(f.told.map(attention => attention.kind), ['mention', 'mention']);
});

test('what natsumi says to the owner is posted in the channel, under her expression, with a reply\'s images uploaded', async t => {
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
  ]);
  assert.deepEqual(slack.uploads, [{ channel: 'C1', files: [{ filename: 'img1.png', data: PNG }], initialComment: '描きました' }]);
  assert.deepEqual(logs, []);
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
