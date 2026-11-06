import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/server/conversation-store.ts';
import { INBOX_REGISTRATION, Inbox, InboxRefusal, MAX_INBOX_TEXT_BYTES, type InboxTask } from '../src/server/inbox.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SOURCES_DEFAULTS, Sources } from '../src/server/sources.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';

/**
 * What the agents ask natsumi over A2A (ADR 0089): one directory a task under `/sources/inbox/<sender>/`, written before
 * the task is handed back, told at once by an attention on a new request and on an answer to her question, and closed
 * by her own `reply_to_agent`. The server reminds her of an open task by rewriting its status.md in the awake hours,
 * fails it at its deadline, and turns away a request past a sender's limit of open tasks without writing a file.
 */

const TIME_ZONE = 'Asia/Tokyo';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 10:00:05 in Tokyo, 2026-10-31. */
const MORNING = Date.parse('2026-10-31T01:00:05Z');
const AT_MEAN = 1 - Math.exp(-1);
const LIMITS = { reminderIntervalHours: 3, deadlineHours: 24, maxOpenTasks: 3 };

async function setup(t: test.TestContext, limits: Partial<typeof LIMITS> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-inbox-')));
  let db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  let clock = MORNING;
  const now = () => clock;
  const directory = join(root, 'sources');
  let raised = 0;
  let messages = 0;
  const make = () => {
    const sources = new Sources({
      db, directory, gitDirectory: join(root, 'sources.git'), timeZone: TIME_ZONE, awakeHours: { start: '08:00', end: '23:00' },
      activity: SOURCES_DEFAULTS.activity, historyDays: SOURCES_DEFAULTS.historyDays, now, raise: () => { raised += 1; }, random: () => AT_MEAN,
    });
    sources.register(INBOX_REGISTRATION);
    const inbox = new Inbox({ db, directory: join(directory, 'inbox'), timeZone: TIME_ZONE, awakeHours: { start: '08:00', end: '23:00' },
      limits: { ...LIMITS, ...limits }, now, sources });
    return { sources, inbox };
  };
  let made = make();
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const send = (sender: string, text: string, to: { contextId?: string; taskId?: string } = {}) => {
    messages += 1;
    return made.inbox.receive(sender, { text, messageId: `message-${messages}`, ...to });
  };
  const read = (path: string) => readFile(join(root, path), 'utf8');
  const take = async () => {
    const eventId = new ConversationStore(db, now).insertEvent('sources-updated');
    const ready = await made.sources.take(eventId);
    return ready ? made.sources.eventLine(eventId, 'received') as Record<string, any> : undefined;
  };
  return {
    root, directory, send, read, take,
    get sources() { return made.sources; },
    get inbox() { return made.inbox; },
    raised: () => raised,
    advance: (ms: number) => { clock += ms; },
    /** As the server starts again: the same database and files, a new inbox and a new core. */
    async restart() {
      db.close();
      db = openStateDatabase(join(root, 'state.sqlite'));
      migrate(db, MIGRATIONS);
      made = make();
      await made.sources.prepare();
    },
  };
}

/** The task's directory as the server sees it: `/sources/...` is the workspace's name for `<root>/sources/...`. */
const local = (task: InboxTask) => task.path!.slice(1);

test('a new request is a directory of its own, written before the task is handed back, and an attention at once', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  const task = await f.send('claude', '明日の予定を教えて\n\n詳しく');
  assert.equal(task.state, 'working');
  assert.equal(task.sender, 'claude');
  assert.match(task.path!, /^\/sources\/inbox\/claude\/20261031T010005Z-[0-9a-f]{4}$/);
  assert.ok(task.contextId, 'a context is opened for it');
  assert.deepEqual((await readdir(join(f.root, local(task)))).sort(), ['01-claude.md', 'README.md', 'status.md']);
  const message = await f.read(`${local(task)}/01-claude.md`);
  assert.match(message, /明日の予定を教えて\n\n詳しく/);
  const readme = await f.read(`${local(task)}/README.md`);
  assert.match(readme, /claude/);
  assert.match(readme, /working/);
  assert.match(readme, /2026-11-01 10:00:05/, 'the deadline, a day after the message, in her time zone');
  assert.match(await f.read(`${local(task)}/status.md`), /working/);
  assert.equal(f.raised(), 1, 'told at once');

  const line = await f.take();
  assert.ok(line);
  const [changed] = line.changed;
  assert.equal(changed.dir, '/sources/inbox/claude');
  assert.deepEqual(changed.attention, [{ source: 'inbox', kind: 'agent_request', file: `${task.path}/01-claude.md`,
    from: 'claude', task: task.path!.slice('/sources/inbox/'.length), text: '明日の予定を教えて' }]);
});

test('a request in the same context opens a new task that names the one before; a context she never gave is refused', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  const first = await f.send('claude', '一つ目');
  await f.inbox.reply('claude', 'はい', 'completed');
  const second = await f.send('claude', '二つ目', { contextId: first.contextId });
  assert.equal(second.contextId, first.contextId);
  assert.notEqual(second.path, first.path);
  assert.match(await f.read(`${local(second)}/README.md`), new RegExp(`${first.path}/`));
  await assert.rejects(f.send('claude', '知らない', { contextId: 'made-up' }), (error: InboxRefusal) => error.kind === 'unknown-context');
  await assert.rejects(f.send('pi', '他人の', { contextId: first.contextId }), (error: InboxRefusal) => error.kind === 'unknown-context',
    'another sender’s context is as one never given');
});

test('a message to an open task that is not waiting for an answer is refused, and so is one to a closed or unknown task', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  const task = await f.send('claude', '頼みます');
  await assert.rejects(f.send('claude', '追加で', { taskId: task.taskId }), (error: InboxRefusal) => error.kind === 'not-waiting');
  await assert.rejects(f.send('claude', 'だれ？', { taskId: 'no-such-task' }), (error: InboxRefusal) => error.kind === 'not-found');
  await assert.rejects(f.send('pi', '横から', { taskId: task.taskId }), (error: InboxRefusal) => error.kind === 'not-found',
    'another sender’s task is as one that is not there');
  await f.inbox.reply('claude', undefined, 'completed');
  await assert.rejects(f.send('claude', 'もう一度', { taskId: task.taskId }), (error: InboxRefusal) => error.kind === 'closed');
});

test('an empty message and one over 1 MiB are refused, and nothing is written', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  await assert.rejects(f.send('claude', '  \n'), (error: InboxRefusal) => error.kind === 'empty');
  await assert.rejects(f.send('claude', 'あ'.repeat(Math.floor(MAX_INBOX_TEXT_BYTES / 3) + 1)), (error: InboxRefusal) => error.kind === 'too-large');
  await assert.rejects(readdir(join(f.directory, 'inbox', 'claude')));
  assert.equal(f.raised(), 0);
});

test('a request past the sender’s open tasks is rejected at once, with no file and no attention, and kept for the dashboard', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  const open = [await f.send('claude', '一'), await f.send('claude', '二'), await f.send('claude', '三')];
  assert.equal(f.raised(), 3);
  const rejected = await f.send('claude', '四');
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.path, undefined);
  assert.match(rejected.reason!, /3/);
  assert.equal(f.raised(), 3, 'she is not woken');
  assert.equal((await readdir(join(f.directory, 'inbox', 'claude'))).length, 3);
  assert.equal(f.inbox.task('claude', rejected.taskId)?.state, 'rejected', 'the record stays');
  assert.equal((await f.send('pi', '別の送り手')).state, 'working', 'the limit is a sender’s own');
  // A question counts as open as well.
  await f.inbox.reply(open[0]!.path!.slice('/sources/inbox/'.length), 'どれのこと？', 'input-required');
  assert.equal((await f.send('claude', '五')).state, 'rejected');
  await f.inbox.reply(open[1]!.path!.slice('/sources/inbox/'.length), '済みました', 'completed');
  assert.equal((await f.send('claude', '六')).state, 'working', 'one closed makes room');
});

test('a reply by the sender’s name closes its one open task, written as her own file, with no attention', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  const task = await f.send('claude', '調べて');
  const outcome = await f.inbox.reply('claude', '調べました。\n\n答えは 42 です。', 'completed');
  assert.equal(outcome.ok, true, outcome.text);
  assert.match(outcome.text, new RegExp(`${task.path}/02-me.md`));
  const closed = f.inbox.task('claude', task.taskId)!;
  assert.equal(closed.state, 'completed');
  assert.deepEqual(closed.messages.map(message => [message.author, message.text]), [['sender', '調べて'], ['me', '調べました。\n\n答えは 42 です。']]);
  assert.match(await f.read(`${local(task)}/02-me.md`), /答えは 42 です。/);
  assert.match(await f.read(`${local(task)}/README.md`), /completed/);
  assert.match(await f.read(`${local(task)}/status.md`), /completed/);
  assert.equal(f.raised(), 1, 'her own reply is no attention');
  const again = await f.inbox.reply(`claude/${task.path!.split('/').at(-1)}`, 'もう一度', 'completed');
  assert.equal(again.ok, false, 'a closed task takes no reply');
  assert.equal((await f.inbox.reply('claude', 'まだある？', 'completed')).ok, false, 'no open task is left');
});

test('a completed reply needs no words, and a question does', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  const task = await f.send('claude', '覚えておいて');
  const question = await f.inbox.reply('claude', '  ', 'input-required');
  assert.equal(question.ok, false);
  assert.equal(f.inbox.task('claude', task.taskId)!.state, 'working', 'nothing changed');
  assert.equal((await f.inbox.reply('claude', undefined, 'completed')).ok, true);
  assert.deepEqual((await readdir(join(f.root, local(task)))).sort(), ['01-claude.md', 'README.md', 'status.md'], 'no file of hers');
  assert.equal(f.inbox.task('claude', task.taskId)!.state, 'completed');
});

test('a sender with two open tasks is answered by the directory, and her name alone is refused with the directories', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  const first = await f.send('claude', '一つ目');
  const second = await f.send('claude', '二つ目');
  const name = (task: InboxTask) => task.path!.slice('/sources/inbox/'.length);
  const refused = await f.inbox.reply('claude', 'どっち？', 'completed');
  assert.equal(refused.ok, false);
  assert.ok(refused.text.includes(name(first)) && refused.text.includes(name(second)), refused.text);
  assert.equal(f.inbox.task('claude', first.taskId)!.state, 'working');
  assert.equal(f.inbox.task('claude', second.taskId)!.state, 'working');
  assert.equal((await f.inbox.reply(name(second), '二つ目の答え', 'completed')).ok, true);
  assert.equal(f.inbox.task('claude', second.taskId)!.state, 'completed');
  assert.equal((await f.inbox.reply('claude', '一つ目の答え', 'completed')).ok, true, 'one is left, so the name is enough');
  assert.equal(f.inbox.task('claude', first.taskId)!.state, 'completed');
  for (const to of ['nobody', 'claude/20261031T010005Z-zzzz', '../claude', 'claude/../pi']) {
    assert.equal((await f.inbox.reply(to, '誰？', 'completed')).ok, false, to);
  }
});

test('her question waits for the sender, whose answer is an attention at its file and puts the task back to work', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  const task = await f.send('claude', '会議を入れて');
  const asked = await f.inbox.reply('claude', '何時からにしますか？', 'input-required');
  assert.equal(asked.ok, true, asked.text);
  assert.equal(f.inbox.task('claude', task.taskId)!.state, 'input-required');
  assert.match(await f.read(`${local(task)}/02-me.md`), /何時からにしますか？/);
  await f.take();
  const answered = await f.send('claude', '15 時から', { taskId: task.taskId, contextId: task.contextId });
  assert.equal(answered.state, 'working');
  assert.equal(answered.taskId, task.taskId);
  assert.match(await f.read(`${local(task)}/03-claude.md`), /15 時から/);
  assert.equal(f.raised(), 2);
  const line = await f.take();
  assert.deepEqual(line?.changed[0].attention, [{ source: 'inbox', kind: 'agent_answer', file: `${task.path}/03-claude.md`,
    from: 'claude', task: task.path!.slice('/sources/inbox/'.length), text: '15 時から' }]);
  await assert.rejects(f.send('claude', '別の context', { taskId: task.taskId, contextId: 'other' }),
    (error: InboxRefusal) => error.kind === 'unknown-context');
});

test('an open task is reminded by its status.md on the interval, never out of the awake hours nor while it asks', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  const task = await f.send('claude', '急がないけど');
  const status = () => f.read(`${local(task)}/status.md`);
  f.advance(2 * HOUR);
  await f.inbox.tick();
  assert.match(await status(), /催促: 0 回/);
  f.advance(HOUR); // 13:00
  await f.inbox.tick();
  assert.match(await status(), /催促: 1 回/);
  await f.inbox.tick();
  assert.match(await status(), /催促: 1 回/, 'once an interval');
  f.advance(10 * HOUR + 30 * MINUTE); // 23:30, out of the awake hours
  await f.inbox.tick();
  assert.match(await status(), /催促: 1 回/, 'not at night');
  f.advance(9 * HOUR); // 08:30 the next morning
  await f.inbox.tick();
  assert.match(await status(), /催促: 2 回/, 'the night’s reminders come as one in the morning');
  assert.equal(f.raised(), 1, 'a reminder is no attention');
  assert.equal(f.inbox.task('claude', task.taskId)!.state, 'working');

  const g = await setup(t);
  await g.sources.prepare();
  const asking = await g.send('claude', '会議');
  await g.inbox.reply('claude', 'いつ？', 'input-required');
  g.advance(4 * HOUR);
  await g.inbox.tick();
  assert.match(await g.read(`${local(asking)}/status.md`), /催促: 0 回/, 'her question waits for the sender, not for her');
});

test('a task past its deadline from the sender’s last message fails, at night too and while it asks', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  const task = await f.send('claude', '期限つき');
  f.advance(23 * HOUR);
  await f.inbox.tick();
  assert.equal(f.inbox.task('claude', task.taskId)!.state, 'working');
  f.advance(HOUR); // 10:00:05 the next day
  await f.inbox.tick();
  const failed = f.inbox.task('claude', task.taskId)!;
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason!, /24 時間/);
  assert.match(await f.read(`${local(task)}/status.md`), /failed/);
  assert.match(await f.read(`${local(task)}/README.md`), /failed/);
  assert.equal((await f.inbox.reply('claude', '遅れました', 'completed')).ok, false);

  const g = await setup(t);
  await g.sources.prepare();
  const asking = await g.send('claude', '会議');
  g.advance(20 * HOUR);
  await g.inbox.reply('claude', 'いつ？', 'input-required');
  g.advance(4 * HOUR); // 10:00:05 the next day, out of nothing but the deadline
  await g.inbox.tick();
  assert.equal(g.inbox.task('claude', asking.taskId)!.state, 'failed', 'the time she waited for an answer counts');

  const h = await setup(t);
  await h.sources.prepare();
  const late = await h.send('claude', '夜');
  h.advance(14 * HOUR); // 00:00:05
  const answered = await h.inbox.reply('claude', 'いつ？', 'input-required');
  assert.ok(answered.ok);
  h.advance(HOUR);
  await h.send('claude', '明日', { taskId: late.taskId });
  h.advance(23 * HOUR + 30 * MINUTE); // 00:30 the day after, at night
  await h.inbox.tick();
  assert.equal(h.inbox.task('claude', late.taskId)!.state, 'working', 'counted from the answer');
  h.advance(HOUR);
  await h.inbox.tick();
  assert.equal(h.inbox.task('claude', late.taskId)!.state, 'failed', 'and failed at night');
});

test('the open tasks stay across a restart, and are answered as before', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  const task = await f.send('claude', '再起動をまたぐ');
  await f.restart();
  assert.equal(f.inbox.task('claude', task.taskId)!.state, 'working');
  const outcome = await f.inbox.reply('claude', 'まだ覚えています', 'completed');
  assert.equal(outcome.ok, true, outcome.text);
  assert.equal(f.inbox.task('claude', task.taskId)!.state, 'completed');
});

test('a request whose directory cannot be written is refused, and leaves no task behind', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  await mkdir(join(f.directory, 'inbox'), { recursive: true });
  await writeFile(join(f.directory, 'inbox', 'claude'), 'not a directory');
  await assert.rejects(f.send('claude', '書けない'), (error: Error) => !(error instanceof InboxRefusal));
  assert.equal(f.raised(), 0);
  await rm(join(f.directory, 'inbox', 'claude'));
  const task = await f.send('claude', '書ける');
  assert.equal(task.state, 'working');
  assert.equal((await f.inbox.reply('claude', 'はい', 'completed')).ok, true, 'the one refused is no open task');
});
