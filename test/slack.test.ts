import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SLACK_DEFAULTS } from '../src/server/config.ts';
import { parseReference } from '../src/server/dove-request.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SlackArchive } from '../src/server/slack-archive.ts';
import { SlackWorkspace } from '../src/server/slack.ts';
import type { Attention } from '../src/server/sources.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { FakeSlack, PNG, tsAt } from './support/fake-slack.ts';

/**
 * The receiving side of Slack (ADR 0012, ADR 0050): what the server writes for natsumi to read — one JSON line a
 * message — and which messages it tells the core are for her. Slack is a stand-in; nothing goes over the network.
 */

const TIME_ZONE = 'Asia/Tokyo';
/** 2026-09-25 14:32:05 in Tokyo. */
const AT = '2026-09-25T05:32:05Z';

type Line = Record<string, unknown> & { at: string; from: string; text?: string };

async function setup(t: test.TestContext, options: { backfillDays?: number; maxImageBytes?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-slack-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const directory = join(root, 'sources', 'slack');
  let clock = Date.parse(AT) + 60_000;
  const now = () => clock;
  const archive = new SlackArchive({ db, directory, timeZone: TIME_ZONE, now });
  const slack = new FakeSlack();
  slack.addChannel({ id: 'C1', name: 'dev', isIm: false });
  const told: Attention[] = [];
  const logs: string[] = [];
  const workspace = new SlackWorkspace({
    name: 'work', api: slack, socket: slack, archive, reaction: 'eyes', backfillDays: options.backfillDays ?? SLACK_DEFAULTS.backfillDays,
    maxImageBytes: options.maxImageBytes ?? 1024 * 1024, now, log: line => { logs.push(line); },
    attention: attention => { told.push(attention); },
  });
  await workspace.start();
  t.after(async () => {
    await workspace.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const read = (path: string) => readFile(join(directory, path), 'utf8');
  /** A day file as `jq -s` reads it: one value a line. */
  const lines = async (path: string) => (await read(path)).split('\n').filter(Boolean).map(line => JSON.parse(line) as Line);
  return { root, db, directory, archive, slack, workspace, told, logs, read, lines, tick: (ms: number) => { clock += ms; } };
}

/** A message event as Slack sends it over Socket Mode. */
function message(fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '', ts: tsAt(AT), ...fields };
}

/** The line a jq -s path such as `.[3]` names. */
function at(lines: Line[], path: string): Line {
  const index = /^\.\[(\d+)\]$/.exec(path);
  assert.ok(index, path);
  return lines[Number(index[1])]!;
}

test('a message in a channel is one JSON line in that day\'s file, with its local time and speaker', async t => {
  const f = await setup(t);
  f.slack.emit(message({ text: 'おはようございます\n今日は <#C9|design> で話します <https://example.test/doc|資料>' }));
  await f.workspace.idle();
  const [line, ...rest] = await f.lines('work/dev/2026-09-25.jsonl');
  assert.deepEqual(rest, []);
  assert.deepEqual(line, { at: '2026-09-25 14:32:05', from: '山田',
    text: 'おはようございます\n今日は #design で話します 資料（https://example.test/doc）' });
  assert.doesNotMatch(await f.read('work/dev/2026-09-25.jsonl'), /\d{10}\.\d{6}|C1|U1/, 'no Slack ID in the file');
  const index = await f.read('INDEX.md');
  assert.match(index, /work\/#dev/);
  assert.match(index, /2026-09-25 14:32:05/);
  assert.match(index, /\/sources\/slack\/work\/dev\/2026-09-25\.jsonl/);
});

test('a reply in a thread is a line of its own in the parent\'s file, naming the parent\'s line, in the order recorded', async t => {
  const f = await setup(t);
  const parent = tsAt(AT);
  f.slack.emit(message({ text: '別の発言が先', ts: tsAt('2026-09-25T05:00:00Z') }));
  f.slack.emit(message({ text: '親の発言', ts: parent }));
  f.slack.emit(message({ text: '次の発言', ts: tsAt('2026-09-25T05:40:00Z') }));
  // The next day in Tokyo: the reply still goes into the parent's file, at its end.
  f.slack.emit(message({ user: 'U2', text: '返信です', ts: tsAt('2026-09-25T15:10:00Z'), thread_ts: parent }));
  await f.workspace.idle();
  const lines = await f.lines('work/dev/2026-09-25.jsonl');
  assert.deepEqual(lines.map(line => line.text), ['別の発言が先', '親の発言', '次の発言', '返信です']);
  assert.deepEqual(lines[3], { at: '2026-09-26 00:10:00', from: '佐藤', reply_to: 1, text: '返信です' });
  await assert.rejects(f.read('work/dev/2026-09-26.jsonl'));
});

test('an edit rewrites the line in place, and a deletion leaves a line saying so: no line moves', async t => {
  const f = await setup(t);
  const ts = tsAt(AT);
  f.slack.emit(message({ text: '最初の文', ts }));
  f.slack.emit(message({ text: '消える文', ts: tsAt('2026-09-25T05:33:00Z') }));
  f.slack.emit(message({ text: '後の文', ts: tsAt('2026-09-25T05:34:00Z') }));
  await f.workspace.idle();
  f.slack.emit({ type: 'message', subtype: 'message_changed', channel: 'C1', channel_type: 'channel', ts: tsAt('2026-09-25T05:35:00Z'),
    message: { type: 'message', user: 'U1', text: '直した文', ts, edited: { user: 'U1', ts: tsAt('2026-09-25T05:35:00Z') } } });
  f.slack.emit({ type: 'message', subtype: 'message_deleted', channel: 'C1', channel_type: 'channel',
    ts: tsAt('2026-09-25T05:36:00Z'), deleted_ts: tsAt('2026-09-25T05:33:00Z') });
  await f.workspace.idle();
  const lines = await f.lines('work/dev/2026-09-25.jsonl');
  assert.deepEqual(lines, [
    { at: '2026-09-25 14:32:05', from: '山田', text: '直した文', edited: true },
    { at: '2026-09-25 14:33:00', from: '山田', deleted: true },
    { at: '2026-09-25 14:34:00', from: '山田', text: '後の文' },
  ]);
  assert.doesNotMatch(await f.read('work/dev/2026-09-25.jsonl'), /最初の文|消える文/);
});

test('an image is fetched into files/ beside the day\'s file; one too large or not an image is only noted', async t => {
  const f = await setup(t, { maxImageBytes: 1024 });
  f.slack.files.set('https://files.example.test/a.png', PNG);
  f.slack.files.set('https://files.example.test/big.png', Buffer.concat([PNG, Buffer.alloc(4096)]));
  f.slack.emit(message({ text: '画像です', files: [
    { id: 'F1', name: 'a.png', mimetype: 'image/png', size: PNG.length, url_private_download: 'https://files.example.test/a.png' },
    { id: 'F2', name: 'big.png', mimetype: 'image/png', size: 5000, url_private_download: 'https://files.example.test/big.png' },
    { id: 'F3', name: 'memo.txt', mimetype: 'text/plain', size: 100, url_private_download: 'https://files.example.test/memo.txt' },
  ] }));
  await f.workspace.idle();
  const [line] = await f.lines('work/dev/2026-09-25.jsonl');
  const images = line!.images as string[];
  assert.equal(images.length, 1);
  assert.match(images[0]!, /^\/sources\/slack\/work\/dev\/files\/\S+\.png$/);
  const saved = await readdir(join(f.directory, 'work', 'dev', 'files'));
  assert.equal(saved.length, 1);
  assert.deepEqual(await readFile(join(f.directory, images[0]!.replace('/sources/slack/', ''))), PNG);
  assert.deepEqual(line!.attachments, ['big.png', 'memo.txt']);
  assert.deepEqual(f.slack.downloads, ['https://files.example.test/a.png'], 'what is too large or not an image is not fetched');
});

test('a PDF is fetched beside the images and listed in pdfs, never told as an image; a fake or too large one is only noted', async t => {
  const f = await setup(t);
  const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  f.slack.files.set('https://files.example.test/a.pdf', PDF);
  f.slack.files.set('https://files.example.test/fake.pdf', Buffer.from('<html>not a pdf</html>'));
  // Slack's size is the poster's word too: the download itself stops at the limit.
  f.slack.files.set('https://files.example.test/lying.pdf', Buffer.concat([PDF, Buffer.alloc(20 * 1024 * 1024)]));
  const pdf = (name: string, size: number) =>
    ({ id: name, name, mimetype: 'application/pdf', size, url_private_download: `https://files.example.test/${name}` });
  f.slack.emit(message({ text: '<@UBOT> 資料です', files: [
    pdf('a.pdf', PDF.length), pdf('fake.pdf', 22), pdf('big.pdf', 20 * 1024 * 1024 + 1), pdf('lying.pdf', 100),
  ] }));
  await f.workspace.idle();
  const [line] = await f.lines('work/dev/2026-09-25.jsonl');
  const pdfs = line!.pdfs as string[];
  assert.equal(pdfs.length, 1);
  assert.match(pdfs[0]!, /^\/sources\/slack\/work\/dev\/files\/\S+\.pdf$/);
  assert.deepEqual(await readFile(join(f.directory, pdfs[0]!.replace('/sources/slack/', ''))), PDF);
  assert.equal(line!.images, undefined);
  assert.deepEqual(line!.attachments, ['fake.pdf', 'big.pdf', 'lying.pdf']);
  assert.deepEqual(await readdir(join(f.directory, 'work', 'dev', 'files')), [pdfs[0]!.split('/').pop()]);
  assert.ok(!f.slack.downloads.includes('https://files.example.test/big.pdf'), 'one said to be too large is not fetched');
  assert.equal(f.told.length, 1);
  assert.equal(f.told[0]!.images, undefined, 'a PDF is not given to the model as an image');
});

test('a mention is told to the core once, with the jq path of its line and its images, and gets the eyes reaction once', async t => {
  const f = await setup(t);
  f.slack.files.set('https://files.example.test/a.png', PNG);
  f.slack.emit(message({ user: 'U2', text: '前の発言', ts: tsAt('2026-09-25T05:30:00Z') }));
  const ts = tsAt(AT);
  const mention = message({ text: '<@UBOT> 明日の件どうなってる？', ts, files: [
    { id: 'F1', name: 'a.png', mimetype: 'image/png', size: PNG.length, url_private_download: 'https://files.example.test/a.png' }] });
  f.slack.emit(mention);
  f.slack.emit({ ...mention, type: 'app_mention' });
  f.slack.emit(mention);
  await f.workspace.idle();
  assert.equal(f.told.length, 1);
  const [told] = f.told;
  assert.equal(told!.source, 'slack');
  assert.equal(told!.kind, 'mention');
  assert.equal(told!.file, '/sources/slack/work/dev/2026-09-25.jsonl');
  assert.equal(told!.path, '.[1]');
  assert.equal(told!.images!.length, 1);
  assert.equal(at(await f.lines('work/dev/2026-09-25.jsonl'), told!.path).text, '@natsumi 明日の件どうなってる？');
  assert.deepEqual(f.slack.reactions, [{ channel: 'C1', ts, name: 'eyes' }]);
  assert.doesNotMatch(JSON.stringify(f.told), /\d{10}\.\d{6}|C1|U1|UBOT|F1/, 'no Slack ID in what is told');
});

test('a mention in a thread points at its own line, which names the thread\'s parent', async t => {
  const f = await setup(t);
  const parent = tsAt('2026-09-25T05:00:00Z');
  f.slack.emit(message({ text: 'スレッドの親', ts: parent }));
  f.slack.emit(message({ text: 'チャンネルの別の話', ts: tsAt('2026-09-25T05:10:00Z') }));
  f.slack.emit(message({ user: 'U2', text: '<@UBOT> どう思う？', ts: tsAt(AT), thread_ts: parent }));
  await f.workspace.idle();
  const lines = await f.lines('work/dev/2026-09-25.jsonl');
  const line = at(lines, f.told[0]!.path);
  assert.equal(line.text, '@natsumi どう思う？');
  assert.equal(lines[line.reply_to as number]!.text, 'スレッドの親');
});

test('a direct message is told as a dm, and written under the sender\'s name', async t => {
  const f = await setup(t);
  f.slack.addChannel({ id: 'D1', isIm: true, user: 'U2' });
  f.slack.emit(message({ channel: 'D1', channel_type: 'im', user: 'U2', text: 'ちょっと相談です' }));
  await f.workspace.idle();
  assert.deepEqual(f.told, [{ source: 'slack', kind: 'dm', file: '/sources/slack/work/@佐藤/2026-09-25.jsonl', path: '.[0]' }]);
  assert.deepEqual(await f.lines('work/@佐藤/2026-09-25.jsonl'), [{ at: '2026-09-25 14:32:05', from: '佐藤', text: 'ちょっと相談です' }]);
});

test('her name without a mention, her own posts and other bots are told nothing', async t => {
  const f = await setup(t);
  f.slack.emit(message({ text: 'natsumi さんに聞いてみよう', ts: tsAt(AT) }));
  f.slack.emit(message({ user: 'UBOT', bot_id: 'BBOT', text: '了解です', ts: tsAt('2026-09-25T05:33:00Z') }));
  f.slack.emit(message({ user: undefined, bot_id: 'B2', username: 'ci', subtype: 'bot_message', text: '<@UBOT> build failed',
    ts: tsAt('2026-09-25T05:34:00Z') }));
  await f.workspace.idle();
  assert.equal(f.told.length, 0);
  assert.deepEqual(f.slack.reactions, []);
  const lines = await f.lines('work/dev/2026-09-25.jsonl');
  assert.equal(lines[0]!.text, 'natsumi さんに聞いてみよう');
  assert.deepEqual(lines[1], { at: '2026-09-25 14:33:00', from: 'natsumi', mine: true, text: '了解です' });
  assert.equal(lines[2]!.from, 'ci');
  assert.equal(lines[2]!.mine, undefined);
});

test('a reply without a mention in a thread she spoke in is told once as a thread-reply, without the eyes reaction', async t => {
  const f = await setup(t);
  const parent = tsAt('2026-09-25T05:00:00Z');
  f.slack.emit(message({ user: 'U2', text: 'デプロイ手順どこだっけ', ts: parent }));
  f.slack.emit(message({ user: 'UBOT', bot_id: 'BBOT', text: 'README にあります', ts: tsAt('2026-09-25T05:01:00Z'), thread_ts: parent }));
  const reply = message({ user: 'U2', text: 'ありがとう、見てみる', ts: tsAt(AT), thread_ts: parent });
  f.slack.emit(reply);
  f.slack.emit(reply);
  // A thread she began counts too.
  const hers = tsAt('2026-09-25T05:40:00Z');
  f.slack.emit(message({ user: 'UBOT', bot_id: 'BBOT', text: '今日のまとめです', ts: hers }));
  f.slack.emit(message({ user: 'U2', text: '助かる', ts: tsAt('2026-09-25T05:41:00Z'), thread_ts: hers }));
  await f.workspace.idle();
  assert.deepEqual(f.told.map(told => told.kind), ['thread-reply', 'thread-reply']);
  const lines = await f.lines('work/dev/2026-09-25.jsonl');
  assert.equal(at(lines, f.told[0]!.path).text, 'ありがとう、見てみる');
  assert.equal(at(lines, f.told[1]!.path).text, '助かる');
  assert.equal(f.told[0]!.file, '/sources/slack/work/dev/2026-09-25.jsonl');
  // The eyes say a mention or a DM was received; a reply in her thread may be people talking among themselves.
  assert.deepEqual(f.slack.reactions, []);
});

test('a mention in her thread is told once, as a mention; a thread she never spoke in, her own replies and bots are told nothing', async t => {
  const f = await setup(t);
  const parent = tsAt('2026-09-25T05:00:00Z');
  f.slack.emit(message({ user: 'U2', text: '相談', ts: parent }));
  f.slack.emit(message({ user: 'UBOT', bot_id: 'BBOT', text: 'はい', ts: tsAt('2026-09-25T05:01:00Z'), thread_ts: parent }));
  f.slack.emit(message({ user: 'UBOT', bot_id: 'BBOT', text: '追記です', ts: tsAt('2026-09-25T05:02:00Z'), thread_ts: parent }));
  f.slack.emit(message({ user: undefined, bot_id: 'B2', username: 'ci', subtype: 'bot_message', text: 'build ok',
    ts: tsAt('2026-09-25T05:03:00Z'), thread_ts: parent }));
  f.slack.emit(message({ user: 'U2', text: '<@UBOT> これで合ってる？', ts: tsAt('2026-09-25T05:04:00Z'), thread_ts: parent }));
  const other = tsAt('2026-09-25T05:10:00Z');
  f.slack.emit(message({ user: 'U2', text: '別の話', ts: other }));
  f.slack.emit(message({ user: 'U1', text: 'そうだね', ts: tsAt('2026-09-25T05:11:00Z'), thread_ts: other }));
  await f.workspace.idle();
  assert.deepEqual(f.told.map(told => told.kind), ['mention']);
  assert.equal(f.slack.reactions.length, 1);
});

test('on connecting, what was missed is filled in from the last recorded message, threads included, and nothing is removed', async t => {
  const f = await setup(t, { backfillDays: 2 });
  f.slack.emit(message({ text: '記録済み', ts: tsAt(AT) }));
  await f.workspace.idle();
  const parent = tsAt('2026-09-25T05:40:00Z');
  f.slack.post('C1', { ts: parent, user: 'U2', text: '止まっている間の発言', files: [] });
  f.slack.post('C1', { ts: tsAt('2026-09-25T05:41:00Z'), threadTs: parent, user: 'U1', text: '止まっている間の返信', files: [] });
  f.slack.connect();
  await f.workspace.idle();
  assert.deepEqual(f.slack.historyCalls.at(-1), { channel: 'C1', oldest: tsAt(AT) });
  const lines = await f.lines('work/dev/2026-09-25.jsonl');
  assert.deepEqual(lines.map(line => line.text), ['記録済み', '止まっている間の発言', '止まっている間の返信']);
  assert.equal(lines[2]!.reply_to, 1);
});

test('a channel never recorded is filled in from the configured number of days back, and its mentions are not told', async t => {
  const f = await setup(t, { backfillDays: 2 });
  f.slack.addChannel({ id: 'C2', name: 'random', isIm: false });
  f.slack.post('C2', { ts: tsAt('2026-09-24T05:00:00Z'), user: 'U1', text: '<@UBOT> 昨日の呼びかけ', files: [] });
  f.slack.connect();
  await f.workspace.idle();
  const call = f.slack.historyCalls.find(c => c.channel === 'C2');
  assert.equal(call?.oldest, String((Date.parse(AT) + 60_000) / 1000 - 2 * 86400));
  assert.match(await f.read('work/random/2026-09-24.jsonl'), /昨日の呼びかけ/);
  assert.equal(f.told.length, 0, 'a first fill-in tells of no old mentions');
});

test('a mention missed while disconnected is told when it is filled in', async t => {
  const f = await setup(t);
  f.slack.emit(message({ text: '記録済み', ts: tsAt(AT) }));
  await f.workspace.idle();
  f.slack.post('C1', { ts: tsAt('2026-09-25T05:40:00Z'), user: 'U2', text: '<@UBOT> 止まっている間の呼びかけ', files: [] });
  f.slack.connect();
  await f.workspace.idle();
  assert.equal(f.told.length, 1);
  assert.equal(f.told[0]!.path, '.[1]');
  assert.equal(f.slack.reactions.length, 1);
});

test('a reply to a thread whose parent was never recorded fetches the parent into the file first', async t => {
  const f = await setup(t);
  const parent = tsAt('2026-09-20T05:00:00Z');
  f.slack.post('C1', { ts: parent, user: 'U2', text: '古い親', files: [] });
  f.slack.emit(message({ text: '<@UBOT> 古いスレッドへの返信', ts: tsAt(AT), thread_ts: parent }));
  await f.workspace.idle();
  const lines = await f.lines('work/dev/2026-09-20.jsonl');
  assert.deepEqual(lines.map(line => line.text), ['古い親', '@natsumi 古いスレッドへの返信']);
  assert.equal(lines[1]!.reply_to, 0);
  assert.equal(f.told[0]!.file, '/sources/slack/work/dev/2026-09-20.jsonl');
  assert.equal(f.told[0]!.path, '.[1]');
});

test('a reference written from a line\'s time and speaker finds that message, as the dove matches it', async t => {
  const f = await setup(t);
  f.slack.emit(message({ text: '返したい発言', ts: tsAt(AT) }));
  await f.workspace.idle();
  const [line] = await f.lines('work/dev/2026-09-25.jsonl');
  const reference = parseReference(`work/#dev ${line!.at} ${line!.from}`);
  assert.ok(typeof reference !== 'string', String(reference));
  const found = f.archive.resolve(reference);
  assert.ok(found.ok, JSON.stringify(found));
  assert.equal(found.target.message?.ts, tsAt(AT));
  assert.equal(found.target.message?.text, '返したい発言');
});

test('day files written in Markdown before are written again as JSON Lines from every row, and removed', async t => {
  const f = await setup(t);
  f.slack.emit(message({ text: '一つ目', ts: tsAt(AT) }));
  f.slack.emit(message({ user: 'U2', text: '返信', ts: tsAt('2026-09-25T05:40:00Z'), thread_ts: tsAt(AT) }));
  f.slack.emit(message({ text: '前の日', ts: tsAt('2026-09-24T05:00:00Z') }));
  await f.workspace.idle();
  // As an older server left them: Markdown days, and no JSON Lines.
  for (const day of ['2026-09-24', '2026-09-25']) {
    await unlink(join(f.directory, 'work', 'dev', `${day}.jsonl`));
    await writeFile(join(f.directory, 'work', 'dev', `${day}.md`), '# work/#dev\n');
  }
  const again = new SlackArchive({ db: f.db, directory: f.directory, timeZone: TIME_ZONE, now: () => Date.parse(AT) });
  await again.prepare();
  assert.deepEqual((await f.lines('work/dev/2026-09-25.jsonl')).map(line => line.text), ['一つ目', '返信']);
  assert.deepEqual((await f.lines('work/dev/2026-09-24.jsonl')).map(line => line.text), ['前の日']);
  assert.deepEqual((await readdir(join(f.directory, 'work', 'dev'))).sort(), ['2026-09-24.jsonl', '2026-09-25.jsonl']);
  assert.match(await f.read('INDEX.md'), /^# Slack$/m, 'the index stays Markdown');
});

test('the migration numbers the lines already recorded by time, and a mention event already made is not told again', () => {
  const db = openStateDatabase(':memory:');
  migrate(db, MIGRATIONS.filter(migration => migration.version < 21));
  db.prepare(`INSERT INTO slack_channels (workspace, channel_id, directory, label, is_im, created_at) VALUES ('work', 'C1', 'dev', '#dev', 0, 'x')`).run();
  const insert = db.prepare(`INSERT INTO slack_messages (workspace, channel_id, ts, thread_ts, speaker, own, text, files, edited, deleted, file_date,
    counted, created_at, updated_at) VALUES ('work', 'C1', ?, NULL, '山田', 0, ?, '[]', 0, 0, ?, 1, 'x', 'x')`);
  insert.run('300.0', '三', '2026-09-25');
  insert.run('100.0', '一', '2026-09-25');
  insert.run('200.0', '二', '2026-09-25');
  insert.run('50.0', '別の日', '2026-09-24');
  db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at) VALUES ('e1', 'slack-mention', NULL, 'queued', 'x', 'x')`).run();
  db.prepare(`INSERT INTO slack_mentions (event_id, workspace, channel_id, ts) VALUES ('e1', 'work', 'C1', '200.0')`).run();
  migrate(db, MIGRATIONS);
  const rows = db.prepare('SELECT text, line FROM slack_messages ORDER BY file_date, line').all() as { text: string; line: number }[];
  assert.deepEqual(rows.map(row => [row.text, row.line]), [['別の日', 0], ['一', 0], ['二', 1], ['三', 2]]);
  const archive = new SlackArchive({ db, directory: join(tmpdir(), 'unused'), timeZone: TIME_ZONE, now: () => 0 });
  assert.equal(archive.markForHer('work', 'C1', '200.0'), undefined);
  assert.equal(archive.markForHer('work', 'C1', '300.0')?.path, '.[2]');
  const event = db.prepare(`SELECT state FROM loop_events WHERE event_id = 'e1'`).get() as { state: string };
  assert.equal(event.state, 'no-reply');
  db.close();
});

/** No Slack ID of a channel, a person or a message, and no token, in a log line. */
function assertNoIds(logs: string[]) {
  for (const line of logs) {
    assert.doesNotMatch(line, /\b(?:[CDFGUW][A-Z0-9]*\d|UBOT)\b|\d{10}\.\d{6}|xox[a-z]-/, line);
  }
}

test('when one conversation\'s history is refused, the others are still filled in, and the log names the call and Slack\'s error', async t => {
  const f = await setup(t, { backfillDays: 2 });
  f.slack.addChannel({ id: 'D1', isIm: true, user: 'U2' });
  f.slack.addChannel({ id: 'C2', name: 'random', isIm: false });
  f.slack.post('C1', { ts: tsAt(AT), user: 'U1', text: 'dev の発言', files: [] });
  f.slack.post('D1', { ts: tsAt(AT), user: 'U2', text: 'DM の秘密の発言', files: [] });
  f.slack.post('C2', { ts: tsAt(AT), user: 'U1', text: 'random の発言', files: [] });
  f.slack.fail('history', 'D1', 'conversations.history', 'missing_scope', 'im:history');
  f.slack.connect();
  await f.workspace.idle();
  assert.match(await f.read('work/dev/2026-09-25.jsonl'), /dev の発言/);
  assert.match(await f.read('work/random/2026-09-25.jsonl'), /random の発言/);
  assert.ok(f.logs.includes('slack (work): filling in a conversation failed (conversations.history: missing_scope, needed im:history)'), f.logs.join('\n'));
  assert.ok(f.logs.includes('slack (work): filled in 2 message(s) from 2 conversation(s); 1 conversation(s) failed'), f.logs.join('\n'));
  assert.ok(!f.logs.some(line => line.includes('発言')), 'no text in the log');
  assertNoIds(f.logs);
});

test('when a thread cannot be fetched, its parent and the rest are still recorded', async t => {
  const f = await setup(t, { backfillDays: 2 });
  const parent = tsAt('2026-09-25T05:00:00Z');
  f.slack.post('C1', { ts: parent, user: 'U1', text: 'スレッドの親', files: [] });
  f.slack.post('C1', { ts: tsAt('2026-09-25T05:01:00Z'), threadTs: parent, user: 'U2', text: '取れない返信', files: [] });
  f.slack.post('C1', { ts: tsAt('2026-09-25T05:10:00Z'), user: 'U2', text: '次の発言', files: [] });
  f.slack.fail('replies', parent, 'conversations.replies', 'thread_not_found');
  f.slack.connect();
  await f.workspace.idle();
  const text = await f.read('work/dev/2026-09-25.jsonl');
  assert.match(text, /スレッドの親/);
  assert.match(text, /次の発言/);
  assert.ok(f.logs.includes('slack (work): a thread could not be fetched (conversations.replies: thread_not_found)'), f.logs.join('\n'));
  assert.ok(f.logs.includes('slack (work): filled in 2 message(s) from 1 conversation(s); 0 conversation(s) failed; 1 other failure(s)'), f.logs.join('\n'));
  assertNoIds(f.logs);
});

test('a speaker whose name cannot be looked up is recorded under a stand-in name, and the lookup is logged once per fill-in', async t => {
  const f = await setup(t, { backfillDays: 2 });
  f.slack.users.set('U3', '鈴木');
  f.slack.fail('userName', 'U3', 'users.info', 'user_not_found');
  f.slack.post('C1', { ts: tsAt(AT), user: 'U3', text: '一つ目', files: [] });
  f.slack.post('C1', { ts: tsAt('2026-09-25T05:33:00Z'), user: 'U3', text: '二つ目', files: [] });
  f.slack.connect();
  await f.workspace.idle();
  const text = await f.read('work/dev/2026-09-25.jsonl');
  assert.deepEqual(text.split('\n').filter(Boolean).map(line => (JSON.parse(line) as { from: string }).from), ['someone', 'someone']);
  const lines = f.logs.filter(line => line.includes('users.info'));
  assert.deepEqual(lines, ['slack (work): a name could not be looked up (users.info: user_not_found)']);
  assertNoIds(f.logs);
});

test('an image that cannot be fetched is only noted, and the message is recorded', async t => {
  const f = await setup(t);
  f.slack.fail('download', 'https://files.example.test/a.png', 'files.download', 'http_403');
  f.slack.emit(message({ text: '画像です', files: [
    { id: 'F1', name: 'a.png', mimetype: 'image/png', size: PNG.length, url_private_download: 'https://files.example.test/a.png' }] }));
  await f.workspace.idle();
  const text = await f.read('work/dev/2026-09-25.jsonl');
  assert.match(text, /画像です/);
  assert.deepEqual((JSON.parse(text) as { attachments: string[] }).attachments, ['a.png']);
  assert.ok(f.logs.includes('slack (work): an image could not be fetched (files.download: http_403)'), f.logs.join('\n'));
  assertNoIds(f.logs);
});

test('a live event that fails, or a reaction Slack refuses, is logged with the call and Slack\'s error', async t => {
  const f = await setup(t);
  f.slack.fail('conversation', 'C7', 'conversations.info', 'channel_not_found');
  f.slack.emit(message({ channel: 'C7', text: '知らないチャンネル' }));
  const ts = tsAt('2026-09-25T05:40:00Z');
  f.slack.fail('addReaction', ts, 'reactions.add', 'missing_scope', 'reactions:write');
  f.slack.emit(message({ text: '<@UBOT> 見て', ts }));
  await f.workspace.idle();
  assert.ok(f.logs.includes('slack (work): handling an event failed (conversations.info: channel_not_found)'), f.logs.join('\n'));
  assert.ok(f.logs.includes('slack (work): the reaction could not be added (reactions.add: missing_scope, needed reactions:write)'), f.logs.join('\n'));
  assert.equal(f.told.length, 1, 'the mention is still told');
  assertNoIds(f.logs);
});

/** A reaction event as Slack sends it over Socket Mode. */
function reaction(type: 'reaction_added' | 'reaction_removed', fields: { user: string; reaction: string; ts: string; channel?: string }) {
  return { type, user: fields.user, reaction: fields.reaction, item_user: 'U1',
    item: { type: 'message', channel: fields.channel ?? 'C1', ts: fields.ts }, event_ts: tsAt('2026-09-25T05:40:00Z') };
}

test('a reaction is written in the line of the message it is on, by name, and taking it off writes the day again', async t => {
  const f = await setup(t);
  const ts = tsAt(AT);
  const reply = tsAt('2026-09-25T05:33:00Z');
  f.slack.emit(message({ text: '明日リリースします', ts }));
  f.slack.emit(message({ user: 'U2', text: 'スレッドの返信', ts: reply, thread_ts: ts }));
  await f.workspace.idle();
  f.slack.emit(reaction('reaction_added', { user: 'U2', reaction: '+1', ts }));
  f.slack.emit(reaction('reaction_added', { user: 'U1', reaction: 'tada', ts }));
  f.slack.emit(reaction('reaction_added', { user: 'UBOT', reaction: '+1', ts }));
  f.slack.emit(reaction('reaction_added', { user: 'U1', reaction: 'eyes', ts: reply }));
  await f.workspace.idle();
  let lines = await f.lines('work/dev/2026-09-25.jsonl');
  assert.deepEqual(lines[0]!.reactions, [{ name: '+1', by: ['佐藤', 'natsumi'] }, { name: 'tada', by: ['山田'] }]);
  assert.deepEqual(lines[1]!.reactions, [{ name: 'eyes', by: ['山田'] }]);
  f.slack.emit(reaction('reaction_removed', { user: 'U2', reaction: '+1', ts }));
  f.slack.emit(reaction('reaction_removed', { user: 'U1', reaction: 'eyes', ts: reply }));
  await f.workspace.idle();
  lines = await f.lines('work/dev/2026-09-25.jsonl');
  assert.deepEqual(lines[0]!.reactions, [{ name: '+1', by: ['natsumi'] }, { name: 'tada', by: ['山田'] }]);
  assert.equal(lines[1]!.reactions, undefined);
  assert.doesNotMatch(await f.read('work/dev/2026-09-25.jsonl'), /\b(?:U1|U2|UBOT|C1)\b|\d{10}\.\d{6}/, 'no Slack ID in the file');
});

test('the same reaction event sent again changes nothing, and her own post says it is hers', async t => {
  const f = await setup(t);
  const ts = tsAt(AT);
  f.slack.emit(message({ user: 'UBOT', bot_id: 'BBOT', text: 'まとめました', ts }));
  await f.workspace.idle();
  const added = reaction('reaction_added', { user: 'U2', reaction: '+1', ts });
  f.slack.emit(added);
  f.slack.emit(added);
  await f.workspace.idle();
  const [line] = await f.lines('work/dev/2026-09-25.jsonl');
  assert.equal(line!.mine, true);
  assert.deepEqual(line!.reactions, [{ name: '+1', by: ['佐藤'] }]);
  assert.equal(f.told.length, 0, 'a reaction is a change in the file, not something for her');
});

test('a reaction on a message not recorded, or on something that is not a message, is let go', async t => {
  const f = await setup(t);
  f.slack.emit(reaction('reaction_added', { user: 'U1', reaction: '+1', ts: tsAt('2026-09-01T00:00:00Z') }));
  f.slack.emit(reaction('reaction_added', { channel: 'C9', user: 'U1', reaction: '+1', ts: tsAt(AT) }));
  f.slack.emit({ type: 'reaction_added', user: 'U1', reaction: '+1', item: { type: 'file', file: 'F1' }, event_ts: tsAt(AT) });
  await f.workspace.idle();
  assert.deepEqual(f.logs, []);
  await assert.rejects(f.read('work/dev/2026-09-01.jsonl'));
});

test('a fill-in takes in the reactions on what it fills in, with those Slack only counted said as a number', async t => {
  const f = await setup(t, { backfillDays: 2 });
  const parent = tsAt('2026-09-25T05:00:00Z');
  f.slack.post('C1', { ts: parent, user: 'UBOT', botId: 'BBOT', text: '止まっている間の自分の投稿', files: [],
    reactions: [{ name: '+1', users: ['U1', 'U2'], count: 2 }, { name: 'tada', users: ['U1'], count: 4 }] });
  f.slack.post('C1', { ts: tsAt('2026-09-25T05:01:00Z'), threadTs: parent, user: 'U2', text: '返信', files: [],
    reactions: [{ name: 'eyes', users: ['UBOT'], count: 1 }] });
  f.slack.connect();
  await f.workspace.idle();
  const lines = await f.lines('work/dev/2026-09-25.jsonl');
  assert.deepEqual(lines[0]!.reactions, [{ name: '+1', by: ['山田', '佐藤'] }, { name: 'tada', by: ['山田'], others: 3 }]);
  assert.deepEqual(lines[1]!.reactions, [{ name: 'eyes', by: ['natsumi'] }]);
});

test('a reaction taken off by someone Slack only counted comes off the number', async t => {
  const f = await setup(t, { backfillDays: 2 });
  const ts = tsAt(AT);
  f.slack.post('C1', { ts, user: 'U2', text: '人気の発言', files: [], reactions: [{ name: 'tada', users: ['U1'], count: 3 }] });
  f.slack.connect();
  await f.workspace.idle();
  f.slack.emit(reaction('reaction_removed', { user: 'U3', reaction: 'tada', ts }));
  await f.workspace.idle();
  assert.deepEqual((await f.lines('work/dev/2026-09-25.jsonl'))[0]!.reactions, [{ name: 'tada', by: ['山田'], others: 1 }]);
});

test('a reacting person whose name cannot be looked up is written under a stand-in name, and the log carries no ID', async t => {
  const f = await setup(t);
  const ts = tsAt(AT);
  f.slack.emit(message({ text: '発言', ts }));
  await f.workspace.idle();
  f.slack.fail('userName', 'U3', 'users.info', 'user_not_found');
  f.slack.emit(reaction('reaction_added', { user: 'U3', reaction: '+1', ts }));
  await f.workspace.idle();
  assert.deepEqual((await f.lines('work/dev/2026-09-25.jsonl'))[0]!.reactions, [{ name: '+1', by: ['someone'] }]);
  assert.ok(f.logs.includes('slack (work): a name could not be looked up (users.info: user_not_found)'), f.logs.join('\n'));
  assertNoIds(f.logs);
});

test('a deleted message keeps none of its reactions, and its replies still point at its line', async t => {
  const f = await setup(t);
  const ts = tsAt(AT);
  f.slack.emit(message({ user: 'UBOT', bot_id: 'BBOT', text: '消す投稿', ts }));
  f.slack.emit(message({ user: 'U2', text: '返信', ts: tsAt('2026-09-25T05:33:00Z'), thread_ts: ts }));
  f.slack.emit(reaction('reaction_added', { user: 'U1', reaction: '+1', ts }));
  await f.workspace.idle();
  f.slack.emit({ type: 'message', subtype: 'message_deleted', channel: 'C1', channel_type: 'channel',
    ts: tsAt('2026-09-25T05:36:00Z'), deleted_ts: ts });
  await f.workspace.idle();
  const lines = await f.lines('work/dev/2026-09-25.jsonl');
  assert.deepEqual(lines[0], { at: '2026-09-25 14:32:05', from: 'natsumi', mine: true, deleted: true });
  assert.equal(lines[1]!.reply_to, 0);
});
