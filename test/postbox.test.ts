import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { parseCron } from '../src/server/cron.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import {
  checkLetter, cronGapMinutes, inPostbox, Postbox, PostboxLedger, receivedLine, receivedStamp, type CommittedLetterFile, type PostboxSend,
} from '../src/server/postbox.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';

/**
 * The postbox (ADR 0076): letters committed to memory's `postbox/`, checked as natsumi's writes are, and sent by the
 * server on their cron with no turn of hers. These are the parts on their own: the check, the line about the last
 * reply, and the clock that sends each run once. The sending over A2A and the replies are in postbox-loop.test.ts.
 */

const TZ = 'Asia/Tokyo';
const tokyo = (local: string) => Date.parse(`${local.replace(' ', 'T')}:00+09:00`);
const RULES = { agents: ['news', 'mail'], minIntervalMinutes: 15, timeZone: TZ };
const letter = (front: string, body = '今朝のニュースから、気になるものを選んでください。') => `---\n${front}\n---\n${body}\n`;

test('a letter is a file directly in postbox/, named by its file, with to, cron and a body', () => {
  const checked = checkLetter('postbox/morning-news.md', letter('to: news\ncron: "0 7 * * *"\nnotify: attention'), { ...RULES, now: tokyo('2026-10-11 06:00') });
  assert.ok(checked.ok, checked.ok ? '' : checked.reason);
  assert.equal(checked.letter.name, 'morning-news');
  assert.equal(checked.letter.to, 'news');
  assert.equal(checked.letter.cron.text, '0 7 * * *');
  assert.equal(checked.letter.notify, 'attention');
  assert.equal(checked.letter.paused, false);
  assert.equal(checked.letter.body, '今朝のニュースから、気になるものを選んでください。');

  const quiet = checkLetter('postbox/mail.md', letter('to: mail\ncron: "30 7 * * 1-5"\npaused: true'), { ...RULES, now: tokyo('2026-10-11 06:00') });
  assert.ok(quiet.ok);
  assert.equal(quiet.letter.notify, 'update');
  assert.equal(quiet.letter.paused, true);
  assert.ok(inPostbox('postbox/mail.md'));
  assert.ok(inPostbox('postbox'));
  assert.ok(!inPostbox('postboxes/mail.md'));
});

test('a letter that cannot be sent as written is caught, with the reason in one sentence', () => {
  const now = tokyo('2026-10-11 06:00');
  const cases: [string, string, RegExp][] = [
    ['postbox/news.md', 'to: news\ncron: "0 7 * * *"\n本文だけ', /frontmatter/],
    ['postbox/news.md', letter('to: news\ncron: [0 7'), /YAML/],
    ['postbox/news.md', letter('to: news\ncron: */15 * * * *'), /YAML/],
    ['postbox/news.md', letter('to: news\ncron: "0 7 * * *"\nnotfy: attention'), /知らない項目.*notfy/],
    ['postbox/news.md', letter('cron: "0 7 * * *"'), /to/],
    ['postbox/news.md', letter('to: weather\ncron: "0 7 * * *"'), /weather/],
    ['postbox/news.md', letter('to: news'), /cron/],
    ['postbox/news.md', letter('to: news\ncron: "0 25 * * *"'), /cron/],
    ['postbox/news.md', letter('to: news\ncron: "0 0 31 2 *"'), /当てはまる時刻/],
    ['postbox/news.md', letter('to: news\ncron: "*/5 * * * *"'), /5 分.*15 分/],
    ['postbox/news.md', letter('to: news\ncron: "0,10 7 * * *"'), /10 分.*15 分/],
    ['postbox/news.md', letter('to: news\ncron: "0 7 * * *"\npaused: "yes"'), /paused/],
    ['postbox/news.md', letter('to: news\ncron: "0 7 * * *"\nnotify: loud'), /notify/],
    ['postbox/news.md', letter('to: news\ncron: "0 7 * * *"', '  '), /本文/],
    ['postbox/News Letter.md', letter('to: news\ncron: "0 7 * * *"'), /ファイル名/],
    ['postbox/daily/news.md', letter('to: news\ncron: "0 7 * * *"'), /直下/],
    ['postbox/news.txt', letter('to: news\ncron: "0 7 * * *"'), /\.md/],
    ['postbox', letter('to: news\ncron: "0 7 * * *"'), /直下/],
  ];
  for (const [path, text, reason] of cases) {
    const checked = checkLetter(path, text, { ...RULES, now });
    assert.ok(!checked.ok, `${path}: ${text} should be caught`);
    assert.match(checked.reason, reason, `${path}: ${text}`);
  }
  // The floor is the config's.
  assert.ok(checkLetter('postbox/news.md', letter('to: news\ncron: "*/5 * * * *"'), { ...RULES, minIntervalMinutes: 5, now }).ok);
});

test('the gap of a cron is the shortest between two runs, the turn of a day included', () => {
  const gap = (text: string) => {
    const parsed = parseCron(text);
    assert.ok(parsed.ok);
    return cronGapMinutes(parsed.cron, TZ, tokyo('2026-10-11 06:00'));
  };
  assert.equal(gap('0 7 * * *'), 24 * 60);
  assert.equal(gap('*/15 * * * *'), 15);
  assert.equal(gap('0,40 7 * * *'), 40);
  assert.equal(gap('55 23 * * *'), 24 * 60);
  assert.equal(gap('0,55 0,23 * * *'), 5);
  assert.equal(gap('0 9 * * 1'), 7 * 24 * 60);
});

test('the last reply is written in the owner\'s time zone to the second, with the zone\'s short name or its IANA name', () => {
  const at = Date.parse('2026-10-10T22:00:00.789Z');
  assert.deepEqual(receivedStamp(at, 'Asia/Tokyo'), { iso: '2026-10-11T07:00:00+09:00', zone: 'JST' });
  assert.equal(receivedLine(at, 'Asia/Tokyo'), '前回の受け取り: 2026-10-11T07:00:00+09:00 (JST)');
  assert.deepEqual(receivedStamp(at, 'UTC'), { iso: '2026-10-10T22:00:00+00:00', zone: 'UTC' });
  assert.deepEqual(receivedStamp(at, 'America/New_York'), { iso: '2026-10-10T18:00:00-04:00', zone: 'EDT' });
  assert.deepEqual(receivedStamp(at, 'Asia/Kolkata'), { iso: '2026-10-11T03:30:00+05:30', zone: 'Asia/Kolkata' });
});

/** A ledger and a clock over a fresh database, with the postbox's repository and sender stood in for. */
async function setup(t: test.TestContext, options: { enabled?: boolean; agents?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-postbox-'));
  const db: DatabaseSync = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const clock = { now: tokyo('2026-10-11 06:00') };
  const repository = {
    head: 'c1',
    files: [] as CommittedLetterFile[],
    reads: 0,
    async headCommit() { return this.head; },
    async committedPostbox() { this.reads += 1; return this.files; },
  };
  const ledger = new PostboxLedger(db, () => clock.now);
  const sent: PostboxSend[] = [];
  let task = 0;
  const sender = {
    /** Stands in for AgentRequests: a waiting task for the letter, as a send that went through leaves one. */
    async sendPostbox(input: PostboxSend) {
      sent.push(input);
      task += 1;
      db.prepare(`INSERT INTO agent_tasks (agent, task_id, context_id, state, sent_at, created_at, updated_at, postbox, postbox_sent_at)
        VALUES (?, ?, 'ctx', 'waiting', ?, ?, ?, ?, ?)`).run(input.agent, `task-${task}`, new Date(input.at).toISOString(),
        new Date(input.at).toISOString(), new Date(input.at).toISOString(), input.name, new Date(input.at).toISOString());
      ledger.record(input.name, 'waiting', input.at, input.at);
    },
  };
  const postbox = new Postbox({ db, now: () => clock.now, timeZone: TZ, enabled: options.enabled ?? true,
    rules: () => ({ ...RULES, agents: options.agents ?? RULES.agents }), repository, sender, ledger });
  const settle = (state: 'completed' | 'failed') => {
    db.prepare(`UPDATE agent_tasks SET state = ? WHERE state = 'waiting'`).run(state);
  };
  return { db, clock, repository, ledger, postbox, sent, settle };
}

const file = (name: string, text: string): CommittedLetterFile => ({ path: `postbox/${name}.md`, text });

test('a letter is sent once at its time, with no turn of hers; the next run waits for its own time', async t => {
  const f = await setup(t);
  f.repository.files = [file('morning-news', letter('to: news\ncron: "0 7 * * *"'))];
  await f.postbox.tick();
  assert.equal(f.sent.length, 0, 'a letter read for the first time waits for its next run');

  f.clock.now = tokyo('2026-10-11 07:00');
  await f.postbox.tick();
  await f.postbox.tick();
  assert.equal(f.sent.length, 1, 'one run is sent once however many ticks pass');
  assert.equal(f.sent[0]!.name, 'morning-news');
  assert.equal(f.sent[0]!.agent, 'news');
  assert.equal(f.sent[0]!.body, '今朝のニュースから、気になるものを選んでください。');
  assert.equal(f.sent[0]!.lastReceivedAt, undefined, 'the first run has no last reply');
  assert.equal(f.sent[0]!.notify, 'update');

  f.settle('completed');
  f.ledger.record('morning-news', 'received', tokyo('2026-10-11 07:01'), tokyo('2026-10-11 07:00'));
  f.clock.now = tokyo('2026-10-12 07:00');
  await f.postbox.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1]!.lastReceivedAt, tokyo('2026-10-11 07:00'), 'the time the run that went well was sent');
});

test('a restart sends no run twice, and runs missed while stopped become one', async t => {
  const f = await setup(t);
  f.repository.files = [file('morning-news', letter('to: news\ncron: "0 7 * * *"'))];
  await f.postbox.tick();
  f.clock.now = tokyo('2026-10-11 07:00');
  await f.postbox.tick();
  assert.equal(f.sent.length, 1);
  f.settle('completed');

  // Another process over the same database, at the same minute.
  const again = new Postbox({ db: f.db, now: () => f.clock.now, timeZone: TZ, enabled: true, rules: () => RULES, repository: f.repository,
    sender: { sendPostbox: async input => { f.sent.push(input); } }, ledger: new PostboxLedger(f.db, () => f.clock.now) });
  await again.tick();
  assert.equal(f.sent.length, 1, 'the run was claimed before it was sent');

  // Three days stopped: the runs missed are sent as one, on the first look.
  f.clock.now = tokyo('2026-10-14 12:00');
  await again.tick();
  await again.tick();
  assert.equal(f.sent.length, 2);
  f.clock.now = tokyo('2026-10-15 06:59');
  await again.tick();
  assert.equal(f.sent.length, 2);
});

test('a run that comes while the last one\'s reply is awaited is passed over, and the record says why', async t => {
  const f = await setup(t);
  f.repository.files = [file('inbox', letter('to: mail\ncron: "*/15 * * * *"'))];
  await f.postbox.tick();
  f.clock.now = tokyo('2026-10-11 06:15');
  await f.postbox.tick();
  assert.equal(f.sent.length, 1);
  f.clock.now = tokyo('2026-10-11 06:30');
  await f.postbox.tick();
  assert.equal(f.sent.length, 1, 'never two requests of one letter at once');
  const row = f.ledger.list().find(entry => entry.name === 'inbox')!;
  assert.equal(row.lastResult, 'skipped');
  assert.match(row.note ?? '', /返事を待って/);
  assert.equal(row.nextAt, tokyo('2026-10-11 06:45'));

  f.settle('completed');
  f.clock.now = tokyo('2026-10-11 06:45');
  await f.postbox.tick();
  assert.equal(f.sent.length, 2);
});

test('a paused letter and a postbox switched off send nothing', async t => {
  const f = await setup(t);
  f.repository.files = [file('news', letter('to: news\ncron: "0 7 * * *"\npaused: true'))];
  await f.postbox.tick();
  f.clock.now = tokyo('2026-10-11 07:00');
  await f.postbox.tick();
  assert.equal(f.sent.length, 0);

  const off = await setup(t, { enabled: false });
  off.repository.files = [file('news', letter('to: news\ncron: "0 7 * * *"'))];
  await off.postbox.tick();
  off.clock.now = tokyo('2026-10-11 07:00');
  await off.postbox.tick();
  assert.equal(off.sent.length, 0, 'postbox.enabled: false stops every letter');
  assert.equal(off.ledger.list().length, 1, 'the letters are still read, for the dashboard');
});

test('HEAD is read again when its commit changes: at once when told, and on the minute\'s look otherwise', async t => {
  const f = await setup(t);
  await f.postbox.tick();
  assert.equal(f.repository.reads, 1, 'read on the first look, as the server starts');
  f.clock.now += 10_000;
  await f.postbox.tick();
  assert.equal(f.repository.reads, 1, 'the same commit is not read again');

  // The owner commits over ssh: seen on the next minute's look.
  f.repository.head = 'c2';
  f.repository.files = [file('news', letter('to: news\ncron: "0 7 * * *"'))];
  f.clock.now += 10_000;
  await f.postbox.tick();
  assert.equal(f.ledger.list().length, 0, 'the head is looked at once a minute');
  f.clock.now += 60_000;
  await f.postbox.tick();
  assert.deepEqual(f.ledger.list().map(entry => entry.name), ['news']);

  // Her turn committed: read at once.
  f.repository.head = 'c3';
  f.repository.files = [];
  await f.postbox.reload();
  assert.equal(f.ledger.list().length, 0, 'a letter removed is forgotten, its last reply with it');
});

test('a letter of the owner\'s that fails the check is passed over, told to her once, and shown with its reason', async t => {
  const f = await setup(t);
  f.repository.files = [
    file('news', letter('to: news\ncron: "*/5 * * * *"')),
    file('mail', letter('to: mail\ncron: "0 7 * * *"')),
    { path: 'postbox/link.md', problem: 'symlink は記憶に置けません' },
  ];
  await f.postbox.tick();
  const notice = f.postbox.takeNotice();
  assert.match(notice, /postbox\/news\.md: .*5 分/);
  assert.match(notice, /postbox\/link\.md: symlink/);
  assert.doesNotMatch(notice, /postbox\/mail\.md/);
  assert.equal(f.postbox.takeNotice(), '', 'taken once');

  f.repository.head = 'c2';
  await f.postbox.reload();
  assert.equal(f.postbox.takeNotice(), '', 'the same problem is not told again');

  f.clock.now = tokyo('2026-10-11 07:00');
  await f.postbox.tick();
  assert.deepEqual(f.sent.map(sent => sent.name), ['mail'], 'the others are still sent');
  const news = f.ledger.list().find(entry => entry.name === 'news')!;
  assert.match(news.problem ?? '', /5 分/);
  assert.equal(news.nextAt, undefined);
});

test('an agent taken out of the config makes its letters fail the check when they are read', async t => {
  const f = await setup(t, { agents: ['mail'] });
  f.repository.files = [file('news', letter('to: news\ncron: "0 7 * * *"'))];
  await f.postbox.tick();
  assert.match(f.postbox.takeNotice(), /news/);
  f.clock.now = tokyo('2026-10-11 07:00');
  await f.postbox.tick();
  assert.equal(f.sent.length, 0);
});

test('the ledger keeps the last reply, and counts the failures in a row until one goes well', async t => {
  const f = await setup(t);
  f.repository.files = [file('news', letter('to: news\ncron: "0 7 * * *"'))];
  await f.postbox.tick();
  const at = tokyo('2026-10-11 07:00');
  f.ledger.record('news', 'received', at + 60_000, at);
  assert.equal(f.ledger.lastReceived('news'), at);
  f.ledger.record('news', 'failed', at + 60_000, at + 86_400_000);
  f.ledger.record('news', 'gave-up', at + 60_000, at + 2 * 86_400_000);
  assert.equal(f.ledger.failures('news'), 2);
  assert.equal(f.ledger.lastReceived('news'), at, 'a run that failed does not move it');
  f.ledger.record('news', 'empty', at + 60_000, at + 3 * 86_400_000);
  assert.equal(f.ledger.failures('news'), 0);
  assert.equal(f.ledger.lastReceived('news'), at + 3 * 86_400_000, 'an empty reply went well too');
  // An answer to an older question never moves it back.
  f.ledger.record('news', 'received', at + 60_000, at + 86_400_000);
  assert.equal(f.ledger.lastReceived('news'), at + 3 * 86_400_000);
});
