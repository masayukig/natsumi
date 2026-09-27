import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { LOOP_DEFAULTS, type LoopConfig } from '../src/server/config.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ALWAYS_FILE, FIXED_FILES } from '../src/server/memory-repository.ts';
import { sectionBody, ThinkingLoop, type LoopClientEvent, type LoopOptions, type SendOutcome } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { startFakeRunner } from './support/fake-runner.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

/** What a test may replace when it opens a loop: loop settings are overlaid on `LOOP_DEFAULTS`. */
type OpenOptions = Partial<Omit<LoopOptions, 'loop'>> & { loop?: Partial<LoopConfig> };

// Fictional memories only.
const PASSPHRASE = 'SYNTHETIC-HERON-208';
const HANDOFF = 'HANDOFF-MARKER-5530';
const EARLIER = 'EARLIER-DAY-TOKEN-77';
const ALWAYS_MARKER = 'ALWAYS-MEMORY-TOKEN-31';

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function setup({ schemaVersion }: { schemaVersion?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-memory-loop-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(join(data, 'memory'), { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(data, 'personality.md'), '# 性格・話し方\n落ち着いた話し方\n');
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, schemaVersion === undefined ? MIGRATIONS : MIGRATIONS.filter(migration => migration.version <= schemaVersion));
  const model = new ScriptedModel();
  const sessions: AgentSession[] = [];
  const opened: ThinkingLoop[] = [];
  let counter = 0;
  const memory = join(data, 'memory');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', memory, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();
  const runners: { close(): Promise<void> }[] = [];
  const f = {
    root, data, memory, sessionDirectory, db, model, sessions, git,
    /** A runner that really runs bash in the memory repository, for the path from run_shell to a committed file. */
    async runner(options: { responseLimitMs?: number } = {}) {
      const runner = await startFakeRunner({ dir: memory, ...options });
      runners.push(runner);
      return runner;
    },
    commits: () => Number(git('rev-list', '--count', 'HEAD')),
    /** Writes a memory file the way the model's shell would, in the middle of a turn. */
    writeMemory: (name: string, text: string) => writeFile(join(memory, name), text),
    async open({ loop: settings, ...options }: OpenOptions = {}) {
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, timeZone: 'Asia/Tokyo', eventModelCalls: 4, ...settings },
        configureSession: session => { session.agent.streamFunction = model.streamFunction; sessions.push(session); },
        ...options,
      });
      opened.push(loop);
      const events: LoopClientEvent[] = [];
      loop.subscribe(event => { events.push(event); });
      return { loop, events };
    },
    send(loop: ThinkingLoop, text: string) {
      const outcome = loop.send({ requestId: `request-${++counter}`, deviceId: 'device-1', text });
      assert.equal(outcome.kind, 'accepted', JSON.stringify(outcome));
      return outcome as Extract<SendOutcome, { kind: 'accepted' }>;
    },
    rows: () => f.db.prepare('SELECT * FROM conversations').all() as Record<string, unknown>[],
    rotations: () => f.db.prepare('SELECT * FROM session_rotations ORDER BY created_at, rotation_id').all() as Record<string, unknown>[],
    sessionFiles: async () => (await readdir(sessionDirectory)).filter(name => name.endsWith('.jsonl')).sort(),
    async cleanup() {
      for (const loop of opened) await loop.close();
      for (const runner of runners) await runner.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};
const lastUserText = (context: Context) => textOf(context.messages.filter(m => m.role === 'user').at(-1)!);
const eventLines = (text: string) => [...text.matchAll(/^\{.*\}$/gm)].map(match => JSON.parse(match[0]) as Record<string, string>);
const toolResults = (context: Context) => {
  const lastAssistant = context.messages.map(m => m.role).lastIndexOf('assistant');
  return context.messages.slice(lastAssistant + 1).filter(m => m.role === 'toolResult')
    .map(m => ({ text: textOf(m), isError: (m as { isError: boolean }).isError }));
};
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
const isFixed = (name: string) => (FIXED_FILES as readonly string[]).includes(name);
const isSummary = (context: Context) => (context.systemPrompt ?? '').includes('summarization');
const completed = (events: LoopClientEvent[], eventId: string) =>
  until(() => events.find(e => e.type === 'conversation.event.completed' && e.payload.eventId === eventId));
const replies = (events: LoopClientEvent[]) => events.filter(e => e.type === 'conversation.message' && e.payload.role === 'natsumi').map(e => e.payload.text);

/** A model that answers owner messages and nightly reviews the way the test describes, and summarizes for compaction. */
function behave(f: Awaited<ReturnType<typeof setup>>, handlers: {
  owner?: (event: Record<string, string>, context: Context) => ScriptedStep;
  review?: (event: Record<string, string>, context: Context) => ScriptedStep;
}) {
  f.model.auto = context => {
    if (isSummary(context)) return `要約: ${JSON.stringify(context.messages).includes(PASSPHRASE) ? PASSPHRASE : 'なし'}`;
    const [event] = eventLines(lastUserText(context));
    if (!event || context.messages.at(-1)?.role !== 'user') return { calls: [] };
    if (event.type === 'nightly_review') {
      return handlers.review?.(event, context) ?? { calls: [] };
    }
    return handlers.owner?.(event, context)
      ?? { calls: [call('reply_to_mac', { text: 'はい', expression: 'neutral' })] };
  };
}

test('run_shell writes memory and reads it back, and memories never ride in the system prompt', async () => {
  const f = await setup();
  try {
    const runner = await f.runner();
    const { loop, events } = await f.open({ loop: { workspaceSocket: runner.path } });
    const first = f.send(loop, `合言葉は ${PASSPHRASE}。覚えておいて`);
    const call1 = await f.model.next();
    // The tool is registered and described, and the memory tools of ADR 0009 are gone.
    assert.match(call1.context.systemPrompt ?? '', /run_shell/);
    assert.doesNotMatch(call1.context.systemPrompt ?? '', /remember|recall|read_memory/);
    call1.call('run_shell', { command: `printf '# 合言葉\\n\\n- 2026-09-19: 合言葉は ${PASSPHRASE}\\n' > 合言葉.md` });
    call1.finish();
    const call2 = await f.model.next();
    const [written] = toolResults(call2.context);
    assert.equal(written!.isError, false);
    assert.match(written!.text, /終了コード 0/);
    // Memory moved, and the result says so: nothing else would tell her it was kept (ADR 0019).
    assert.match(written!.text, /記憶の変更: 合言葉\.md（追加）/);
    call2.call('reply_to_mac', { text: '覚えました', expression: 'neutral' });
    call2.finish();
    (await f.model.next()).finish();
    await completed(events, first.eventId);
    assert.match(await readFile(join(f.memory, '合言葉.md'), 'utf8'), new RegExp(PASSPHRASE));
    // The turn committed it, so the next command has nothing to report.
    assert.equal(f.git('status', '--porcelain'), '');

    // A later question is answered from what the shell finds.
    await loop.close();
    const again = await f.open({ loop: { workspaceSocket: runner.path } });
    const asked = f.send(again.loop, '合言葉は何だっけ');
    const call3 = await f.model.next();
    assert.equal(call3.context.systemPrompt?.includes(PASSPHRASE), false);
    call3.call('run_shell', { command: 'grep -r 合言葉 . --include=*.md' });
    call3.finish();
    const call4 = await f.model.next();
    const [found] = toolResults(call4.context);
    assert.equal(found!.isError, false);
    assert.match(found!.text, new RegExp(PASSPHRASE));
    assert.doesNotMatch(found!.text, /記憶の変更/, 'reading memory is not changing it');
    call4.call('reply_to_mac', { text: PASSPHRASE, expression: 'neutral' });
    call4.finish();
    (await f.model.next()).finish();
    await completed(again.events, asked.eventId);
    for (const context of f.model.contexts) assert.equal((context.systemPrompt ?? '').includes(PASSPHRASE), false);
    // What the owner sees is only the conversation; the workspace stays inside.
    assert.equal(JSON.stringify(again.loop.snapshot()).includes('run_shell'), false);
  } finally { await f.cleanup(); }
});

test('the shell runs in the owner time zone, and a command too long never leaves the server', async () => {
  const f = await setup();
  try {
    const runner = await f.runner();
    const { loop, events } = await f.open({ loop: { workspaceSocket: runner.path } });
    const sent = f.send(loop, '今日の日付で書いておいて');
    const call1 = await f.model.next();
    call1.call('run_shell', { command: 'date +%Z' });
    call1.call('run_shell', { command: `echo ${'あ'.repeat(8000)}` });
    call1.finish();
    const call2 = await f.model.next();
    const [dated, refused] = toolResults(call2.context);
    assert.equal(dated!.isError, false);
    assert.match(dated!.text, /JST/);
    assert.deepEqual(runner.timeZones, ['Asia/Tokyo']);
    assert.equal(refused!.isError, true);
    assert.match(refused!.text, /8000/);
    assert.equal(runner.commands.length, 1, 'the long command never reached the runner');
    call2.finish();
    await completed(events, sent.eventId);
  } finally { await f.cleanup(); }
});

test('the first start makes the memory repository and moves personality.md into it', async () => {
  const f = await setup();
  try {
    await f.writeMemory('\u5408\u8a00\u8449.md', `# \u5408\u8a00\u8449\n\n- 2026-09-15: ${PASSPHRASE}\n`);
    const { loop } = await f.open();
    f.send(loop, '\u3053\u3093\u306b\u3061\u306f');
    const call1 = await f.model.next();

    // The personality is in the prompt, read from the repository; memory itself never is.
    assert.match(call1.context.systemPrompt ?? '', /\u843d\u3061\u7740\u3044\u305f\u8a71\u3057\u65b9/);
    assert.equal((call1.context.systemPrompt ?? '').includes(PASSPHRASE), false);
    call1.finish();
    await loop.idle();

    assert.equal(f.git('symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(f.commits(), 1);
    // What was already there rides into the first commit under its own name, beside the three fixed files.
    assert.deepEqual(f.git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort(),
      [...FIXED_FILES, '\u5408\u8a00\u8449.md'].sort());
    assert.deepEqual((await readdir(f.data)).sort(), ['memory']);
    assert.match(await readFile(join(f.memory, '\u5408\u8a00\u8449.md'), 'utf8'), new RegExp(PASSPHRASE));
  } finally { await f.cleanup(); }
});

test('a turn that changed memory ends in one commit; a turn that changed nothing ends in none', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const base = f.commits();

    const first = f.send(loop, `\u5408\u8a00\u8449\u306f ${PASSPHRASE}`);
    const call1 = await f.model.next();
    // Written the way the shell writes it, in the middle of the turn, which then goes on for another model call.
    await f.writeMemory('\u5408\u8a00\u8449.md', `# \u5408\u8a00\u8449\n\n- 2026-09-19: \u5408\u8a00\u8449\u306f ${PASSPHRASE}\n`);
    call1.call('set_mac_avatar_expression', { expression: 'happy' });
    call1.finish();
    const call2 = await f.model.next();
    call2.call('reply_to_mac', { text: '\u899a\u3048\u307e\u3057\u305f', expression: 'neutral' });
    call2.finish();
    (await f.model.next()).finish();
    await completed(events, first.eventId);

    // One commit for the turn, whatever it took to get there, with a message the server made.
    assert.equal(f.commits(), base + 1);
    assert.match(f.git('log', '-1', '--format=%s'), /^mac_message: .*\u5408\u8a00\u8449\.md/);
    assert.equal(f.git('status', '--porcelain'), '');

    const second = f.send(loop, '\u3042\u308a\u304c\u3068\u3046');
    const call3 = await f.model.next();
    call3.finish();
    await completed(events, second.eventId);
    assert.equal(f.commits(), base + 1);
  } finally { await f.cleanup(); }
});

test('a file the check catches goes back, and the reason reaches the next turn once', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const first = f.send(loop, '\u307e\u3068\u3081\u3066');
    const call1 = await f.model.next();
    await f.writeMemory('\u4e88\u5b9a.md', '# \u4e88\u5b9a\n\n- 2026-09-19: \u6b6f\u533b\u8005\u306f\u91d1\u66dc\n');
    await f.writeMemory('\u3081\u3082.md', '# \u3081\u3082\n\n\u8fd9\u4e2a\u662f\u7b80\u4f53\u5b57\n');
    call1.finish();
    await completed(events, first.eventId);

    // The bad one is gone, the good one is committed.
    assert.deepEqual((await readdir(f.memory)).filter(name => name !== '.git' && !isFixed(name)).sort(), ['\u4e88\u5b9a.md']);
    assert.equal(f.git('status', '--porcelain'), '');

    const second = f.send(loop, '\u3069\u3046\u3060\u3063\u305f');
    const call2 = await f.model.next();
    const told = lastUserText(call2.context);
    assert.match(told, /\u3081\u3082\.md/);
    assert.match(told, /\u65e5\u672c\u8a9e\u4ee5\u5916/);
    call2.finish();
    await completed(events, second.eventId);

    // Told once, not again.
    const third = f.send(loop, '\u308f\u304b\u3063\u305f');
    const call3 = await f.model.next();
    assert.doesNotMatch(lastUserText(call3.context), /\u3081\u3082\.md/);
    call3.finish();
    await completed(events, third.eventId);
  } finally { await f.cleanup(); }
});

test('a turn stopped at the model-call limit still commits what memory holds', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open({ loop: { eventModelCalls: 1 } });
    const base = f.commits();
    const sent = f.send(loop, '\u9577\u3044\u4f5c\u696d');
    const call1 = await f.model.next();
    await f.writeMemory('\u9014\u4e2d.md', '# \u9014\u4e2d\n\n- 2026-09-19: \u66f8\u304d\u304b\u3051\n');
    // The turn is cut at the model-call limit, before she could stop on her own.
    call1.call('set_mac_avatar_expression', { expression: 'thinking' });
    call1.finish();
    assert.equal((await completed(events, sent.eventId)).payload.status, 'failed');
    assert.equal(f.commits(), base + 1);
    assert.match(await readFile(join(f.memory, '\u9014\u4e2d.md'), 'utf8'), /\u66f8\u304d\u304b\u3051/);
  } finally { await f.cleanup(); }
});

/**
 * The upgrade to schema 8, end to end (ADR 0020): a night recorded when the handoff lived only in SQLite, and the
 * first start afterwards, which has to put that text into handoff.md or begin the next session from nothing.
 */
test('the handoff SQLite held reaches handoff.md and the new session reads it from there', async () => {
  const f = await setup({ schemaVersion: 7 });
  try {
    f.db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
      .run('conversation-old', 'session-old', 'old.jsonl', '2026-03-01T00:00:00.000Z');
    f.db.prepare(`INSERT INTO loop_events (event_id, kind, state, created_at, updated_at)
      VALUES ('event-old', 'nightly-review', 'no-reply', ?, ?)`).run('2026-03-02T13:00:00.000Z', '2026-03-02T13:00:00.000Z');
    f.db.prepare(`INSERT INTO session_rotations (rotation_id, event_id, conversation_id, from_session_id, from_session_file,
      state, handoff, to_session_id, to_session_file, created_at, updated_at)
      VALUES ('rotation-old', 'event-old', 'conversation-old', 'session-older', 'older.jsonl', 'switched', ?, 'session-old', 'old.jsonl', ?, ?)`)
      .run(`${HANDOFF} \u660e\u65e5\u306f\u8cc7\u6599\u306e\u7d9a\u304d`, '2026-03-02T13:00:00.000Z', '2026-03-02T13:00:00.000Z');

    migrate(f.db, MIGRATIONS);
    // The Pi session those rows name was never written in this test, so they go once the upgrade has read them.
    // What the start below finds is a database that has been through schema 8 and a handoff waiting to be placed.
    f.db.exec("DELETE FROM session_rotations; DELETE FROM loop_events; DELETE FROM conversations;");

    // A repository somewhere else entirely: loop.memoryRepository names it, and the carried-over handoff lands there.
    const elsewhere = join(f.root, 'memory-elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const { loop, events } = await f.open({ loop: { memoryRepository: elsewhere } });
    assert.match(await readFile(join(elsewhere, 'handoff.md'), 'utf8'), new RegExp(HANDOFF));
    assert.deepEqual((await readdir(elsewhere)).filter(name => name !== '.git').sort(), [...FIXED_FILES].sort());
    // The data directory's own memory/ is untouched: nothing was put there.
    assert.deepEqual(await readdir(f.memory), []);

    // The instructions carry it, read from the file rather than from SQLite, which no longer holds it anywhere.
    behave(f, {});
    let context: Context | undefined;
    behave(f, { owner: (_event, seen) => { context = seen; return { calls: [] }; } });
    const morning = f.send(loop, '\u304a\u306f\u3088\u3046');
    await completed(events, morning.eventId);
    assert.match(context!.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM handoff_carryover').get()?.n, 0);
  } finally { await f.cleanup(); }
});

/** The switch records which commit of handoff.md the new session was given, and nothing of the text (ADR 0020). */
test('the nightly switch commits the handoff into memory and records that commit', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    behave(f, {
      review: () => ({ calls: [
        call('write_handoff_note', { text: `${HANDOFF} \u660e\u65e5\u306f\u8cc7\u6599\u306e\u7d9a\u304d` }),
      ] }),
    });
    const day = f.send(loop, '\u4eca\u65e5\u306e\u8a71');
    await completed(events, day.eventId);
    await loop.idle();
    const before = f.commits();

    assert.equal((await loop.rotate()).result, 'switched');

    // The note is the file, the night's commit carries it, and the row points at that commit.
    assert.match(await readFile(join(f.memory, 'handoff.md'), 'utf8'), new RegExp(HANDOFF));
    assert.equal(f.commits(), before + 1);
    assert.equal(f.git('status', '--porcelain'), '');
    const [rotation] = f.rotations();
    assert.equal(rotation!.state, 'switched');
    assert.equal(rotation!.handoff_commit, f.git('rev-parse', 'HEAD'));
    assert.match(f.git('show', `${rotation!.handoff_commit as string}:handoff.md`), new RegExp(HANDOFF));
    // The text is nowhere in SQLite: the row names a commit, and git holds the words.
    assert.equal(JSON.stringify(f.rotations()).includes(HANDOFF), false);
  } finally { await f.cleanup(); }
});

test('the nightly switch reviews the day, starts a new session with the handoff, keeps the old file and the shown conversation', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    let reviewedWith: Context | undefined;
    behave(f, {
      review: (_event, context) => {
        reviewedWith = context;
        writeFileSync(join(f.memory, '一日の記録.md'), `# 一日の記録\n\n- 2026-09-19: ${EARLIER} を覚えた\n`);
        return { calls: [
          call('write_handoff_note', { text: `${HANDOFF} 明日は資料の続きを確認する` }),
        ] };
      },
    });
    const day = f.send(loop, `今日の話: ${EARLIER}`);
    await completed(events, day.eventId);
    await loop.idle();
    const shown = loop.snapshot().messages;
    const [oldFile] = await f.sessionFiles();
    const oldRow = f.rows()[0]!;

    const outcome = await loop.rotate();
    assert.equal(outcome.result, 'switched');
    // The review ran in the old session, which still had the day in its context.
    const [reviewEvent] = eventLines(lastUserText(reviewedWith!));
    assert.equal(reviewEvent!.type, 'nightly_review');
    assert.ok(JSON.stringify(reviewedWith!.messages).includes(EARLIER));

    const files = await f.sessionFiles();
    assert.equal(files.length, 2);
    assert.ok(files.includes(oldFile!));
    assert.ok((await readFile(join(f.sessionDirectory, oldFile!), 'utf8')).includes(EARLIER));
    const row = f.rows()[0]!;
    assert.equal(row.conversation_id, oldRow.conversation_id);
    assert.notEqual(row.pi_session_id, oldRow.pi_session_id);
    assert.notEqual(row.pi_session_file, oldFile);
    assert.match(await readFile(join(f.data, 'memory', '一日の記録.md'), 'utf8'), new RegExp(EARLIER));
    assert.deepEqual(loop.snapshot().messages, shown);
    // The owner saw natsumi sleeping, and nothing of the review.
    assert.ok(events.some(e => e.type === 'avatar.expression' && e.payload.expression === 'sleepy'));
    assert.equal(loop.snapshot().avatar.expression, 'neutral');
    assert.equal(JSON.stringify(events).includes(HANDOFF), false);

    // The next day starts in the new session: the handoff is in the instructions, the old context is not.
    let next: Context | undefined;
    behave(f, { owner: (_event, context) => { next = context; return { calls: [] }; } });
    const morning = f.send(loop, 'おはよう');
    await completed(events, morning.eventId);
    assert.match(next!.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.equal(JSON.stringify(next!.messages).includes(EARLIER), false);

    // A restart opens the new session with the same handoff.
    await loop.close();
    const restarted = await f.open();
    assert.equal(restarted.loop.unavailable, undefined);
    const later = f.send(restarted.loop, 'また来た');
    await completed(restarted.events, later.eventId);
    assert.match(next!.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.deepEqual(await f.sessionFiles(), files);
  } finally { await f.cleanup(); }
});

test('an owner message that arrives during the nightly switch waits and is handled in the new session', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    behave(f, {});
    const day = f.send(loop, `昼の話 ${EARLIER}`);
    await completed(events, day.eventId);
    await loop.idle();
    f.model.takeOver();

    const rotating = loop.rotate();
    const review = await f.model.next();
    const late = f.send(loop, '夜中にごめん、これ見て');
    assert.equal(late.state, 'queued');
    assert.deepEqual(loop.snapshot().pendingEvents.map(e => e.eventId), [late.eventId]);
    review.call('write_handoff_note', { text: `${HANDOFF} 引き継ぎ` });
    review.finish();
    (await f.model.next()).finish();

    const answer = await f.model.next();
    assert.match(lastUserText(answer.context), /夜中にごめん/);
    assert.match(answer.context.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.equal(JSON.stringify(answer.context.messages).includes(EARLIER), false);
    answer.call('reply_to_mac', { text: '見ました', expression: 'neutral' });
    answer.finish();
    (await f.model.next()).finish();
    assert.equal((await rotating).result, 'switched');
    assert.equal((await completed(events, late.eventId)).payload.status, 'replied');
    assert.deepEqual(replies(events), ['はい', '見ました']);
  } finally { await f.cleanup(); }
});

test('a review without a handoff note keeps the current session, and the tools refuse what does not belong to the event', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    behave(f, {});
    const day = f.send(loop, `昼の話 ${EARLIER}`);
    await completed(events, day.eventId);
    await loop.idle();
    const before = await f.sessionFiles();
    const row = f.rows()[0];

    f.model.takeOver();
    const rotating = loop.rotate();
    const review = await f.model.next();
    review.call('notify_owner', { text: '夜の報告', expression: 'neutral' });
    review.call('reply_to_mac', { text: '返事', expression: 'neutral' });
    review.finish();
    const review2 = await f.model.next();
    const refused = toolResults(review2.context);
    assert.deepEqual(refused.map(r => r.isError), [true, true]);
    // Neither speaks to the owner at night; what should reach tomorrow goes into the handoff (ADR 0032).
    for (const result of refused) assert.match(result.text, /夜の振り返りの間[\s\S]*write_handoff_note/);
    review2.finish();
    const outcome = await rotating;
    assert.deepEqual(outcome, { result: 'failed', reason: 'no-handoff' });
    assert.deepEqual(await f.sessionFiles(), before);
    assert.deepEqual(f.rows()[0], row);

    // The handoff tool is refused outside the review, and the day goes on in the same session.
    behave(f, {});
    let seen: Context | undefined;
    f.model.auto = context => {
      if (context.messages.at(-1)?.role !== 'user') return { calls: [] };
      seen = context;
      return { calls: [call('write_handoff_note', { text: '勝手な引き継ぎ' }),
        call('reply_to_mac', { text: '続けます', expression: 'neutral' })] };
    };
    const next = f.send(loop, 'まだ起きてる？');
    await completed(events, next.eventId);
    assert.ok(JSON.stringify(seen!.messages).includes(EARLIER));
    assert.equal(replies(events).at(-1), '続けます');
    assert.equal(outcome.result, 'failed');
    assert.equal(f.model.contexts.some(c => (c.systemPrompt ?? '').includes('勝手な引き継ぎ')), false);
  } finally { await f.cleanup(); }
});

test('a handoff note in non-Japanese script is refused and never reaches the next session\'s instructions', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    behave(f, {});
    const day = f.send(loop, `昼の話 ${EARLIER}`);
    await completed(events, day.eventId);
    await loop.idle();

    f.model.takeOver();
    const rotating = loop.rotate();
    const review = await f.model.next();
    review.call('write_handoff_note', { text: `${HANDOFF} 简洁にまとめる` });
    review.finish();
    const review2 = await f.model.next();
    const [refused] = toolResults(review2.context);
    assert.equal(refused!.isError, true);
    assert.match(refused!.text, /日本語以外/);
    review2.call('write_handoff_note', { text: `${HANDOFF} 簡潔にまとめる` });
    review2.finish();
    (await f.model.next()).finish();
    assert.equal((await rotating).result, 'switched');

    let next: Context | undefined;
    behave(f, { owner: (_event, context) => { next = context; return { calls: [] }; } });
    const morning = f.send(loop, 'おはよう');
    await completed(events, morning.eventId);
    assert.match(next!.systemPrompt ?? '', /簡潔にまとめる/);
    assert.equal((next!.systemPrompt ?? '').includes('简洁'), false);
  } finally { await f.cleanup(); }
});

test('a session with nothing in it is not switched', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    assert.deepEqual(await loop.rotate(), { result: 'skipped', reason: 'empty-session' });
    assert.equal(f.model.calls, 0);
    assert.equal((await f.sessionFiles()).length, 1);
  } finally { await f.cleanup(); }
});

test('a stop during the switch never silently starts a new conversation: it resumes from the handoff or stays on the old session', async () => {
  const f = await setup();
  try {
    // Stopped before the handoff was written: the old session stays and the next night can try again.
    const first = await f.open();
    behave(f, {});
    const day = f.send(first.loop, `昼の話 ${EARLIER}`);
    await completed(first.events, day.eventId);
    await first.loop.idle();
    const [oldFile] = await f.sessionFiles();
    f.model.takeOver();
    const interrupted = first.loop.rotate();
    await f.model.next();
    await first.loop.close();
    assert.deepEqual(await interrupted, { result: 'failed', reason: 'stopped' });
    assert.deepEqual(await f.sessionFiles(), [oldFile]);

    const second = await f.open();
    assert.equal(second.loop.unavailable, undefined);
    assert.equal(f.rows()[0]!.pi_session_file, oldFile);
    let context: Context | undefined;
    behave(f, { owner: (_event, seen) => { context = seen; return { calls: [] }; } });
    const check = f.send(second.loop, '続き');
    await completed(second.events, check.eventId);
    assert.ok(JSON.stringify(context!.messages).includes(EARLIER));

    // Stopped after the handoff was written: the next start finishes the switch with that handoff.
    f.model.takeOver();
    const again = second.loop.rotate();
    const review = await f.model.next();
    review.call('write_handoff_note', { text: `${HANDOFF} 途中で止まった夜` });
    review.finish();
    await f.model.next();
    await second.loop.close();
    assert.deepEqual(await again, { result: 'failed', reason: 'stopped' });

    const third = await f.open();
    assert.equal(third.loop.unavailable, undefined);
    const files = await f.sessionFiles();
    assert.equal(files.length, 2);
    assert.ok(files.includes(oldFile!));
    assert.notEqual(f.rows()[0]!.pi_session_file, oldFile);
    behave(f, { owner: (_event, seen) => { context = seen; return { calls: [] }; } });
    const morning = f.send(third.loop, 'おはよう');
    await completed(third.events, morning.eventId);
    assert.match(context!.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.equal(JSON.stringify(context!.messages).includes(EARLIER), false);
    assert.deepEqual(third.loop.snapshot().messages.map(m => m.text), [`昼の話 ${EARLIER}`, 'はい', '続き', 'おはよう']);
  } finally { await f.cleanup(); }
});

test('run_shell is offered only with a runner socket, and an unreachable runner does not stop the loop', async () => {
  const f = await setup();
  try {
    // Without a socket the tool is not registered, and the instructions say memory is out of reach.
    const plain = await f.open();
    const first = f.send(plain.loop, '鍵の番号を探して');
    const call1 = await f.model.next();
    assert.doesNotMatch(call1.context.systemPrompt ?? '', /run_shell/);
    assert.match(call1.context.systemPrompt ?? '', /作業環境につながっていない/);
    call1.call('run_shell', { command: 'rg 鍵 /memory' });
    call1.finish();
    const call2 = await f.model.next();
    const [unregistered] = toolResults(call2.context);
    assert.equal(unregistered!.isError, true);
    assert.doesNotMatch(unregistered!.text, /接続できません/);
    call2.finish();
    await completed(plain.events, first.eventId);
    await plain.loop.close();

    // With a socket nobody listens on, the tool answers with the reason and the turn goes on.
    const shelled = await f.open({ loop: { workspaceSocket: join(f.root, 'missing.sock') } });
    const asked = f.send(shelled.loop, 'もう一度探して');
    const call3 = await f.model.next();
    assert.match(call3.context.systemPrompt ?? '', /run_shell/);
    call3.call('run_shell', { command: 'rg 鍵 /memory' });
    call3.finish();
    const call4 = await f.model.next();
    const [unreachable] = toolResults(call4.context);
    assert.equal(unreachable!.isError, true);
    assert.match(unreachable!.text, /接続できません/);
    call4.call('reply_to_mac', { text: 'いまは探せませんでした', expression: 'neutral' });
    call4.finish();
    (await f.model.next()).finish();
    assert.equal((await completed(shelled.events, asked.eventId)).payload.status, 'replied');
  } finally { await f.cleanup(); }
});

/**
 * The size of the persistent places is told on the input side of a turn, never in the instructions: what changes
 * every turn must stay off the prefix cache (ADR 0019).
 */
test('past the size warning the next turn is told, with the breakdown, and no sooner than every ten minutes', async () => {
  const f = await setup();
  try {
    let clock = Date.parse('2026-09-19T10:00:00+09:00');
    await mkdir(join(f.data, 'work'), { recursive: true });
    await writeFile(join(f.data, 'work', 'big.csv'), 'x'.repeat(60_000));
    const { loop, events } = await f.open({ loop: { workspaceSizeWarnBytes: 20_000 }, now: () => clock });
    behave(f, {});

    // The turn that measures is not the turn that is told: the line waits for the next prompt.
    const first = f.send(loop, 'まとめて');
    await completed(events, first.eventId);
    await loop.idle();
    const second = f.send(loop, 'ありがとう');
    await completed(events, second.eventId);
    const told = f.model.contexts.map(lastUserText).find(text => /永続する書き場所/.test(text));
    assert.ok(told, 'the notice reached a prompt');
    assert.match(told!, /\/work/);
    assert.match(told!, /\/memory/);
    assert.match(told!, /\/home\/natsumi/);
    // It never rides in the instructions, where it would break the prefix cache.
    for (const context of f.model.contexts) assert.doesNotMatch(context.systemPrompt ?? '', /永続する書き場所/);

    // Told once. The places are not walked again until ten minutes have gone by.
    const third = f.send(loop, 'わかった');
    await completed(events, third.eventId);
    assert.doesNotMatch(lastUserText(f.model.contexts.at(-1)!), /永続する書き場所/);

    clock += 10 * 60_000;
    const fourth = f.send(loop, 'その後は');
    await completed(events, fourth.eventId);
    await loop.idle();
    const fifth = f.send(loop, 'まだ大きい');
    await completed(events, fifth.eventId);
    assert.match(lastUserText(f.model.contexts.at(-1)!), /永続する書き場所/);
  } finally { await f.cleanup(); }
});

test('past the context limit the loop compacts between turns and the conversation goes on, also after a restart', async () => {
  const f = await setup();
  try {
    const options = { loop: { compactionThreshold: 1_500, compactionKeepRecent: 400 } };
    const { loop, events } = await f.open(options);
    behave(f, {});
    const long = 'あ'.repeat(1_500);
    const first = f.send(loop, `合言葉は ${PASSPHRASE} ${long}`);
    await completed(events, first.eventId);
    for (let i = 0; i < 4; i++) await completed(events, f.send(loop, `話 ${i} ${long}`).eventId);
    await loop.idle();

    const summaries = f.model.contexts.filter(isSummary);
    assert.ok(summaries.length >= 1, 'compacted');
    // The summary is asked for with natsumi's own instructions, and in no turn's middle.
    assert.match(textOf(summaries[0]!.messages.at(-1)!), /本人/);
    const file = String(f.rows()[0]!.pi_session_file);
    const entries = (await readFile(join(f.sessionDirectory, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line).type);
    assert.ok(entries.includes('compaction'));
    const compactedAt = loop.dashboardState().lastCompactionAt;
    assert.ok(compactedAt, 'the dashboard shows when the session was last compacted (ADR 0049)');

    let context: Context | undefined;
    behave(f, { owner: (_event, seen) => { context = seen; return { calls: [call('reply_to_mac', { text: '続きです', expression: 'neutral' })] }; } });
    const after = f.send(loop, 'まだ続く？');
    assert.equal((await completed(events, after.eventId)).payload.status, 'replied');
    assert.match(textOf(context!.messages[0]!), new RegExp(`要約: ${PASSPHRASE}`));
    assert.equal(loop.snapshot().messages.filter(m => m.role === 'owner').length, 6);

    await loop.close();
    const restarted = await f.open(options);
    assert.equal(restarted.loop.dashboardState().lastCompactionAt, compactedAt, 'and still knows it after a restart');
    const last = f.send(restarted.loop, '再起動後');
    assert.equal((await completed(restarted.events, last.eventId)).payload.status, 'replied');
    assert.match(textOf(context!.messages[0]!), /要約/);
    assert.deepEqual(await f.sessionFiles(), [file]);
  } finally { await f.cleanup(); }
});

test('a failed compaction says why in the log, without the conversation, and waits for the context to grow before trying again', async () => {
  const f = await setup();
  try {
    const logs: string[] = [];
    // Pi counts the system prompt and the tools in the context too (about 1,500 tokens here), so the limit sits above
    // them: the first compaction comes after some turns, when there is a conversation to summarize.
    const { loop, events } = await f.open({ loop: { compactionThreshold: 3_000, compactionKeepRecent: 400 }, log: line => { logs.push(line); } });
    behave(f, {});
    const answer = f.model.auto!;
    // The summary runs out of tokens while it is still thinking, the way it did on a slow local model.
    f.model.auto = context => isSummary(context) ? { thinking: '考えている途中', finish: 'length' } : answer(context);
    const long = 'あ'.repeat(1_500);
    await completed(events, f.send(loop, `合言葉は ${PASSPHRASE} ${long}`).eventId);
    for (let i = 0; i < 4 && !logs.some(line => line.includes('compaction')); i++) {
      await completed(events, f.send(loop, `話 ${i} ${long}`).eventId);
      await loop.idle();
    }

    const failures = logs.filter(line => line.startsWith('thinking loop: compaction failed'));
    assert.equal(failures.length, 1, logs.join('\n'));
    assert.match(failures[0]!, /token cap/);
    assert.equal(failures[0]!.includes('\n'), false);
    for (const line of logs) assert.equal(line.includes(PASSPHRASE) || line.includes('あああ'), false, line);

    // The failure costs a whole summary call, so a short turn after it does not ask again.
    const summaries = f.model.contexts.filter(isSummary).length;
    await completed(events, f.send(loop, 'みじかい話').eventId);
    await loop.idle();
    assert.equal(f.model.contexts.filter(isSummary).length, summaries);
  } finally { await f.cleanup(); }
});

test('the nightly review gets forty model calls by default, and a turn cut at its call limit says so in the log', async () => {
  const f = await setup();
  try {
    const logs: string[] = [];
    const { loop, events } = await f.open({ log: line => { logs.push(line); } });
    // Unlike `behave`, this answers every call of a turn, not only the first: the review keeps working until it is done or cut.
    let reviewCalls = 0;
    let finishAt: number | undefined = 39;
    const keepWorking = (context: Context): ScriptedStep => {
      const [event] = eventLines(lastUserText(context));
      if (event?.type !== 'nightly_review') return { calls: [call('set_mac_avatar_expression', { expression: 'thinking' })] };
      reviewCalls += 1;
      // Work on every call but the last two, the handoff on the one before the last, and stop without a tool on the
      // last (ADR 0024): the old limit of sixteen would have cut this short.
      if (finishAt !== undefined && reviewCalls > finishAt) return {};
      if (reviewCalls !== finishAt) return { calls: [call('set_mac_avatar_expression', { expression: 'sleepy' })] };
      return { calls: [call('write_handoff_note', { text: `${HANDOFF} 長い夜` })] };
    };
    behave(f, {});
    const day = f.send(loop, '今日の話');
    await completed(events, day.eventId);
    await loop.idle();
    f.model.auto = keepWorking;
    assert.equal((await loop.rotate()).result, 'switched');
    assert.equal(reviewCalls, 40);
    assert.equal(logs.some(line => line.includes('limit')), false, logs.join('\n'));
    await loop.close();

    // A tighter limit from the config cuts the review, and the log names the turn, the limit and the count.
    const second = await f.open({ loop: { reviewModelCalls: 3 }, log: line => { logs.push(line); } });
    reviewCalls = 0;
    finishAt = undefined;
    const stuck = f.send(second.loop, '止まらない昼');
    assert.equal((await completed(second.events, stuck.eventId)).payload.status, 'failed');
    assert.ok(logs.includes('thinking loop: the events turn was stopped at the model-call limit (4 calls)'), logs.join('\n'));
    await second.loop.idle();
    assert.deepEqual(await second.loop.rotate(), { result: 'failed', reason: 'model-call-limit' });
    assert.equal(reviewCalls, 3);
    assert.ok(logs.includes('thinking loop: the review turn was stopped at the model-call limit (3 calls)'), logs.join('\n'));
  } finally { await f.cleanup(); }
});

test('the review turn has thirty minutes where an ordinary turn has ten, and a turn cut by time says so in the log', async t => {
  const f = await setup();
  try {
    const logs: string[] = [];
    const { loop, events } = await f.open({ log: line => { logs.push(line); } });
    behave(f, {});
    const day = f.send(loop, `昼の話 ${EARLIER}`);
    await completed(events, day.eventId);
    await loop.idle();
    const settledEvent = (eventId: string) => events.find(e => e.type === 'conversation.event.completed' && e.payload.eventId === eventId);
    const flush = () => new Promise(resolve => setImmediate(resolve));

    // From here only setTimeout is faked: the model answers when the test says, and the clock moves when the test ticks.
    f.model.takeOver();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const rotating = loop.rotate();
    const review = await f.model.next();
    // Ten minutes in, an ordinary turn would be over. The review goes on, and finishes.
    t.mock.timers.tick(10 * 60_000);
    review.call('write_handoff_note', { text: `${HANDOFF} 遅い夜` });
    review.finish();
    (await f.model.next()).finish();
    assert.equal((await rotating).result, 'switched');
    assert.equal(logs.some(line => line.includes('time limit')), false, logs.join('\n'));

    // An ordinary turn in the new session is cut at ten minutes, not a moment sooner.
    const stuck = f.send(loop, '返事のない昼');
    const reply = await f.model.next();
    t.mock.timers.tick(10 * 60_000 - 1);
    await flush();
    assert.equal(settledEvent(stuck.eventId), undefined);
    t.mock.timers.tick(1);
    await loop.idle();
    assert.deepEqual([settledEvent(stuck.eventId)?.payload.status, settledEvent(stuck.eventId)?.payload.reason], ['failed', 'timeout']);
    assert.ok(logs.includes('thinking loop: the events turn was stopped by the time limit (600 seconds)'), logs.join('\n'));
    reply.finish();

    // The review is cut at thirty minutes, not a moment sooner.
    const rotatingAgain = loop.rotate();
    let settled = false;
    void rotatingAgain.then(() => { settled = true; });
    await f.model.next();
    t.mock.timers.tick(30 * 60_000 - 1);
    await flush();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    assert.deepEqual(await rotatingAgain, { result: 'failed', reason: 'timeout' });
    assert.ok(logs.includes('thinking loop: the review turn was stopped by the time limit (1800 seconds)'), logs.join('\n'));
  } finally {
    t.mock.timers.reset();
    await f.cleanup();
  }
});

/**
 * The always-memory (ADR 0018, ADR 0020): `always.md` goes into the instructions of every new session, as it
 * stands. The length is looked at when it is written, never when it is read, so what the owner put there by hand
 * arrives whole even when it is past the limit.
 */
test('always.md rides in the instructions as it stands, and an empty one adds no section', async () => {
  const promptFor = async (always: string) => {
    const f = await setup();
    try {
      // Written before the first start, so the repository takes it in rather than seeding the template.
      await f.writeMemory(ALWAYS_FILE, always);
      const { loop, events } = await f.open();
      const sent = f.send(loop, 'おはよう');
      const call1 = await f.model.next();
      call1.finish();
      await completed(events, sent.eventId);
      return call1.context.systemPrompt ?? '';
    } finally { await f.cleanup(); }
  };

  const always = `# 常時記憶\n\n- 呼び方は「${ALWAYS_MARKER}」\n`;
  const prompt = await promptFor(always);
  assert.match(prompt, new RegExp(ALWAYS_MARKER));
  // The server writes the section's heading, so the file's own opening heading is not repeated under it.
  assert.equal(prompt.match(/^# 常時記憶$/gm)?.length, 1, prompt);
  // Ahead of it stands what changes less often, behind it what changes every night.
  assert.ok(prompt.indexOf('落ち着いた話し方') < prompt.indexOf(ALWAYS_MARKER), prompt);
  assert.ok(prompt.indexOf(ALWAYS_MARKER) < prompt.indexOf('# 前の思考の記録からの引き継ぎ'), prompt);

  // Nothing to say, nothing in the prompt: an empty file leaves the section out, as an empty personality does.
  assert.doesNotMatch(await promptFor('   \n'), /常時記憶/);
  // A file that is nothing but its heading says nothing either.
  assert.doesNotMatch(await promptFor('# 常時記憶\n'), /常時記憶/);

  // Far past `alwaysMemoryMaxChars`, and still whole: only the writing side looks at the length (ADR 0020).
  const long = `# 常時記憶\n\n${'あ'.repeat(4000)}\n- 末尾は ${ALWAYS_MARKER}\n`;
  assert.ok([...long].length > LOOP_DEFAULTS.alwaysMemoryMaxChars * 2);
  assert.ok((await promptFor(long)).includes(sectionBody(long)));
});

test('an always.md written past its limit is not committed, and the reason reaches the new session', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open({ loop: { alwaysMemoryMaxChars: 200 } });
    const kept = await readFile(join(f.memory, ALWAYS_FILE), 'utf8');
    behave(f, {
      review: () => {
        // The night rewrites the always-memory past its limit, and tidies a memory file that is fine.
        writeFileSync(join(f.memory, ALWAYS_FILE), `# 常時記憶\n\n${'あ'.repeat(300)}\n`);
        writeFileSync(join(f.memory, '一日の記録.md'), `# 一日の記録\n\n- 2026-09-19: ${EARLIER}\n`);
        return { calls: [
          call('write_handoff_note', { text: `${HANDOFF} 明日の朝に常時記憶を短く書き直す` }),
        ] };
      },
    });
    const day = f.send(loop, '今日の話');
    await completed(events, day.eventId);
    await loop.idle();
    assert.equal((await loop.rotate()).result, 'switched');

    // Put back as it was, while the rest of the night was committed.
    assert.equal(await readFile(join(f.memory, ALWAYS_FILE), 'utf8'), kept);
    assert.match(await readFile(join(f.memory, '一日の記録.md'), 'utf8'), new RegExp(EARLIER));
    assert.equal(f.git('status', '--porcelain'), '');

    // A review has no next turn, so the reason rides in the new session's instructions.
    let next: Context | undefined;
    behave(f, { owner: (_event, context) => { next = context; return { calls: [] }; } });
    const morning = f.send(loop, 'おはよう');
    await completed(events, morning.eventId);
    assert.match(next!.systemPrompt ?? '', /always\.md/);
    assert.match(next!.systemPrompt ?? '', /200/);
  } finally { await f.cleanup(); }
});

/** What the night changed, in natsumi's own words, as that night's commit message (ADR 0018, ADR 0020). */
test('write_change_note becomes the nightly commit message, and a note that fails the check is rewritten', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    behave(f, {});
    const day = f.send(loop, `昼の話 ${EARLIER}`);
    await completed(events, day.eventId);
    await loop.idle();

    f.model.takeOver();
    const rotating = loop.rotate();
    const review = await f.model.next();
    writeFileSync(join(f.memory, '一日の記録.md'), `# 一日の記録\n\n- 2026-09-19: ${EARLIER}\n`);
    // The same checks as anything that reaches the owner: non-Japanese script is refused and may be written again.
    review.call('write_change_note', { text: '今日の记录をまとめた' });
    review.finish();
    const review2 = await f.model.next();
    const [refused] = toolResults(review2.context);
    assert.equal(refused!.isError, true);
    assert.match(refused!.text, /日本語以外/);
    review2.call('write_change_note', { text: '一日の記録を書き足した\n\n昼の話を 1 行にまとめた。' });
    review2.call('write_handoff_note', { text: `${HANDOFF} 引き継ぎ` });
    review2.finish();
    (await f.model.next()).finish();
    assert.equal((await rotating).result, 'switched');

    assert.equal(f.git('log', '-1', '--format=%s'), '一日の記録を書き足した');
    assert.match(f.git('log', '-1', '--format=%B'), /昼の話を 1 行にまとめた。/);
  } finally { await f.cleanup(); }
});

test('a night with no change note still switches, and the day is told why the note has no place', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    behave(f, {
      review: () => {
        writeFileSync(join(f.memory, '一日の記録.md'), `# 一日の記録\n\n- 2026-09-19: ${EARLIER}\n`);
        return { calls: [
          call('write_handoff_note', { text: `${HANDOFF} 説明は書かなかった夜` }),
        ] };
      },
    });
    const day = f.send(loop, '今日の話');
    await completed(events, day.eventId);
    await loop.idle();

    // No note, and the night is not failed for it: the server makes the message instead.
    assert.equal((await loop.rotate()).result, 'switched');
    assert.match(f.git('log', '-1', '--format=%s'), /^nightly_review: .*一日の記録\.md/);

    // In the day the tool is refused with its reason, and the turn goes on: the day's message is the server's.
    f.model.takeOver();
    const morning = f.send(loop, 'おはよう');
    const turn1 = await f.model.next();
    writeFileSync(join(f.memory, '予定.md'), '# 予定\n\n- 2026-09-20: 歯医者は金曜\n');
    turn1.call('write_change_note', { text: '昼の説明' });
    turn1.finish();
    const turn2 = await f.model.next();
    const [refusal] = toolResults(turn2.context);
    assert.equal(refusal!.isError, true);
    assert.match(refusal!.text, /nightly_review/);
    turn2.call('reply_to_mac', { text: '続けます', expression: 'neutral' });
    turn2.finish();
    (await f.model.next()).finish();
    await completed(events, morning.eventId);
    assert.equal(replies(events).at(-1), '続けます');
    assert.match(f.git('log', '-1', '--format=%s'), /^mac_message: .*予定\.md/);
  } finally { await f.cleanup(); }
});

// ADR 0024: the review ends like any other turn, when natsumi stops without a tool.
test('the nightly review ends without finish_event and still writes the handoff and the change note', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    behave(f, {});
    const day = f.send(loop, `昼の話 ${EARLIER}`);
    await completed(events, day.eventId);
    await loop.idle();

    f.model.takeOver();
    const rotating = loop.rotate();
    const review = await f.model.next();
    const [reviewEvent] = eventLines(lastUserText(review.context));
    assert.equal(reviewEvent!.type, 'nightly_review');
    assert.equal('event_id' in reviewEvent!, false);
    assert.doesNotMatch(String(reviewEvent!.instructions), /finish_event/);
    writeFileSync(join(f.memory, '一日の記録.md'), `# 一日の記録\n\n- 2026-09-19: ${EARLIER}\n`);
    review.call('write_change_note', { text: '一日の記録を書き足した' });
    review.call('write_handoff_note', { text: `${HANDOFF} 夜の引き継ぎ` });
    review.finish();
    const last = await f.model.next();
    assert.deepEqual(toolResults(last.context).map(r => r.isError), [false, false]);
    last.finish();
    assert.equal((await rotating).result, 'switched');
    assert.equal(f.model.calls >= 2, true);
    assert.equal(f.git('log', '-1', '--format=%s'), '一日の記録を書き足した');
    assert.match(await readFile(join(f.memory, 'handoff.md'), 'utf8'), new RegExp(`${HANDOFF} 夜の引き継ぎ`));
  } finally { await f.cleanup(); }
});
