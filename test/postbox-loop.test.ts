import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { REPLY_EXTENSION_URI } from '../src/server/a2a-client.ts';
import { AGENTS_REGISTRATION, replyPlaceOf } from '../src/server/agent-replies.ts';
import { LOOP_DEFAULTS, type PostboxConfig } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { PostboxLedger } from '../src/server/postbox.ts';
import { SOURCES_DEFAULTS, Sources } from '../src/server/sources.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop } from '../src/server/thinking-loop.ts';
import { FakeAgent } from './support/fake-agent.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

/**
 * The postbox in the thinking loop (ADR 0076): a letter committed to memory's postbox/ is sent to a fake agent at its
 * time with no turn of hers, and what comes back is put under /sources/agents as `ask_agent`'s replies are, told as an
 * ordinary update unless the letter, a question or a third failure says otherwise.
 */

const tokyo = (local: string) => Date.parse(`${local.replace(' ', 'T')}:00+09:00`);

async function setup(t: test.TestContext, options: { postbox?: PostboxConfig; extensions?: string[] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-postbox-loop-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(join(data, 'work'), { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  const tokenFile = join(root, 'a2a-token');
  await writeFile(tokenFile, 'fake-agent-token\n');
  const agent = await FakeAgent.start(options.extensions ? { extensions: options.extensions } : {});
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const clock = { now: tokyo('2026-10-11 06:00') };
  const sourcesDirectory = join(data, 'sources');
  const memory = join(data, 'memory');
  const opened: ThinkingLoop[] = [];
  const f = {
    agent, model, clock, db, memory, replies: join(sourcesDirectory, 'agents'),
    ledger: new PostboxLedger(db, () => clock.now),
    async open() {
      const sources = new Sources({ db, directory: sourcesDirectory, gitDirectory: join(data, 'sources.git'), timeZone: 'Asia/Tokyo',
        awakeHours: LOOP_DEFAULTS.awakeHours, activity: SOURCES_DEFAULTS.activity, historyDays: 7, now: () => clock.now });
      sources.register(AGENTS_REGISTRATION);
      await sources.prepare();
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, eventModelCalls: 6, timeZone: 'Asia/Tokyo' }, now: () => clock.now,
        configureSession: session => { session.agent.streamFunction = model.streamFunction; },
        a2a: { tokenFile, pollIntervalSeconds: 15, giveUpAfterHours: 24, agents: { news: { url: agent.url } } },
        sources, agentReplies: replyPlaceOf(sources, sourcesDirectory), ...(options.postbox ? { postbox: options.postbox } : {}),
      });
      sources.connect(() => { loop.raiseSourcesUpdated(); });
      opened.push(loop);
      return loop;
    },
    /** The owner's commit over ssh: no check, and no turn of hers. */
    commit(name: string, text: string) {
      execFileSync('mkdir', ['-p', join(memory, 'postbox')]);
      execFileSync('sh', ['-c', 'cat > "$1"', 'sh', join(memory, 'postbox', `${name}.md`)], { input: text });
      execFileSync('git', ['-C', memory, '-c', 'user.name=owner', '-c', 'user.email=owner@example.invalid', 'add', '-A']);
      execFileSync('git', ['-C', memory, '-c', 'user.name=owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', 'letter']);
    },
    script(...steps: ScriptedStep[]) { model.auto = () => steps.shift() ?? { text: '' }; },
    /** The directories of the replies of the agent, as the server put them. */
    async directories() {
      try { return (await readdir(join(sourcesDirectory, 'agents', 'news'))).sort(); } catch { return []; }
    },
    read(path: string) { return readFile(join(sourcesDirectory, 'agents', 'news', path), 'utf8'); },
    attentions() { return Number((db.prepare('SELECT count(*) AS n FROM source_attention').get() as { n: number }).n); },
    letter(name: string) { return f.ledger.list().find(entry => entry.name === name); },
  };
  t.after(async () => {
    for (const loop of opened) await loop.close();
    db.close();
    await agent.close();
    await rm(root, { recursive: true, force: true });
  });
  return f;
}

const LETTER = (front = '') => `---\nto: news\ncron: "0 7 * * *"\n${front}---\n今朝のニュースから、自宅のサーバーの運用に関わるものを選んでください。\n`;
const BODY = '今朝のニュースから、自宅のサーバーの運用に関わるものを選んでください。';

const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};
/** The attentions of the agents' replies the model has been handed, in order. */
const replies = (model: ScriptedModel) => (model.contexts.at(-1)?.messages ?? []).filter(m => m.role === 'user').map(textOf)
  .flatMap(text => text.split('\n')).filter(line => line.includes('"type":"sources_updated"'))
  .map(line => JSON.parse(line) as { changed: { attention?: Record<string, unknown>[] }[] })
  .flatMap(line => line.changed.flatMap(entry => entry.attention ?? [])).filter(attention => attention.kind === 'agent_reply');

/** One run: the clock at its time, the postbox's look, and the agent's task as it was started. */
async function run(f: Awaited<ReturnType<typeof setup>>, loop: ThinkingLoop, at: number) {
  f.clock.now = at;
  await loop.tickPostbox();
  return f.agent.lastTask();
}

async function poll(f: Awaited<ReturnType<typeof setup>>, loop: ThinkingLoop) {
  await loop.pollAgents();
  await loop.idle();
}

test('an owner\'s letter is sent at its time with no turn of hers, and its reply is put with its request as an ordinary update', async t => {
  const f = await setup(t);
  const loop = await f.open();
  f.commit('morning-news', LETTER());
  await loop.tickPostbox();
  assert.equal(f.agent.received.length, 0, 'a letter read for the first time waits for its time');

  const task = await run(f, loop, tokyo('2026-10-11 07:00'));
  assert.equal(f.agent.received.length, 1);
  assert.equal(f.agent.received[0]!.text, BODY, 'the first run has no line about a last reply');
  assert.deepEqual(f.agent.received[0]!.metadata, { postbox: { name: 'morning-news' } });
  assert.equal(f.model.calls, 0, 'no model is called to send it');
  assert.deepEqual(await f.directories(), [], 'nothing is put before the reply comes');

  f.agent.settle(task.id, 'completed', '運用に関わるニュースが 1 件あります。\n\n## 証明書の期限\n\n更新の手順が変わりました。');
  await poll(f, loop);
  assert.equal(f.attentions(), 0, 'an ordinary update: no attention');
  assert.equal(f.model.calls, 0);
  const [directory] = await f.directories();
  assert.match(directory!, /^20261010T220000Z-[0-9a-f]{4}$/);
  const request = await f.read(`${directory}/request.md`);
  assert.match(request, /- postbox: morning-news/);
  assert.match(request, new RegExp(BODY));
  assert.match(await f.read(`${directory}/README.md`), /運用に関わるニュースが 1 件あります。/);
  assert.equal(f.letter('morning-news')!.lastResult, 'received');
  assert.equal(f.letter('morning-news')!.lastReplyPath, `/sources/agents/news/${directory}`, 'where the reply was put, as the workspace names it');

  await run(f, loop, tokyo('2026-10-12 07:00'));
  assert.equal(f.agent.received[1]!.text, `${BODY}\n\n前回の受け取り: 2026-10-11T07:00:00+09:00 (JST)`);
  assert.deepEqual(f.agent.received[1]!.metadata, { postbox: { name: 'morning-news', lastReceivedAt: '2026-10-11T07:00:00+09:00' } });
});

test('a letter with notify: attention is told at once, its attention naming the letter', async t => {
  const f = await setup(t);
  const loop = await f.open();
  f.commit('morning-news', LETTER('notify: attention\n'));
  await loop.tickPostbox();
  const task = await run(f, loop, tokyo('2026-10-11 07:00'));
  f.agent.settle(task.id, 'completed', '運用に関わるニュースが 1 件あります。');
  f.script();
  await poll(f, loop);
  const [reply] = replies(f.model);
  assert.equal(reply!.postbox, 'morning-news');
  assert.equal(reply!.state, 'completed');
  assert.equal(reply!.agent, 'news');
  assert.equal(reply!.request, BODY);
});

test('an empty reply is told to nobody and leaves no directory, and still counts as one that went well', async t => {
  const f = await setup(t, { extensions: [REPLY_EXTENSION_URI] });
  const loop = await f.open();
  f.commit('morning-news', LETTER('notify: attention\n'));
  await loop.tickPostbox();
  const task = await run(f, loop, tokyo('2026-10-11 07:00'));
  f.agent.settle(task.id, 'completed', '新しいものはありません。', { data: { summary: '新しいものはありません。', sections: [], sources: [] } });
  await poll(f, loop);
  assert.deepEqual(await f.directories(), []);
  assert.equal(f.attentions(), 0);
  assert.equal(f.model.calls, 0);
  assert.equal(f.letter('morning-news')!.lastResult, 'empty');
  assert.equal(f.letter('morning-news')!.lastReplyPath, undefined, 'an empty reply puts no directory to name');

  await run(f, loop, tokyo('2026-10-12 07:00'));
  assert.match(f.agent.received[1]!.text, /前回の受け取り: 2026-10-11T07:00:00\+09:00 \(JST\)$/);
});

test('failures are ordinary updates and do not move the last reply; the third in a row, a give-up among them, is told at once', async t => {
  const f = await setup(t);
  const loop = await f.open();
  f.commit('morning-news', LETTER());
  await loop.tickPostbox();
  let task = await run(f, loop, tokyo('2026-10-11 07:00'));
  f.agent.settle(task.id, 'failed', 'ニュースを取れませんでした。');
  await poll(f, loop);
  assert.equal(f.attentions(), 0);
  assert.equal(f.letter('morning-news')!.failures, 1);

  // Left unanswered past the wait limit: a give-up, counted with the failures.
  task = await run(f, loop, tokyo('2026-10-12 07:00'));
  assert.equal(f.agent.received[1]!.text, BODY, 'a run that failed does not move the last reply');
  f.clock.now = tokyo('2026-10-13 07:00');
  await poll(f, loop);
  assert.equal(f.attentions(), 0);
  assert.equal(f.letter('morning-news')!.failures, 2);
  assert.equal(f.letter('morning-news')!.lastResult, 'gave-up');

  task = await run(f, loop, tokyo('2026-10-13 07:00'));
  f.agent.settle(task.id, 'failed', 'まだ取れません。');
  f.script();
  await poll(f, loop);
  const [told] = replies(f.model);
  assert.deepEqual([told!.state, told!.postbox], ['failed', 'morning-news']);
  assert.equal(f.letter('morning-news')!.failures, 3);
  assert.equal((await f.directories()).length, 3, 'each failure is put, to be read');
  assert.equal(f.letter('morning-news')!.lastReplyPath, `/sources/agents/news/${(await f.directories()).at(-1)}`, 'the last one put');
});

test('a letter that cannot reach its agent is put as a failure at once, and counted', async t => {
  const f = await setup(t);
  const loop = await f.open();
  f.commit('morning-news', LETTER());
  await loop.tickPostbox();
  f.agent.failWith = 503;
  f.clock.now = tokyo('2026-10-11 07:00');
  await loop.tickPostbox();
  const [directory] = await f.directories();
  assert.ok(directory);
  assert.match(await f.read(`${directory}/README.md`), /failed/);
  assert.match(await f.read(`${directory}/request.md`), /postbox: morning-news/);
  assert.equal(f.letter('morning-news')!.lastReplyPath, `/sources/agents/news/${directory}`);
  assert.equal(f.attentions(), 0);
  assert.equal(f.letter('morning-news')!.failures, 1);
});

test('a question is told at once whatever the letter says; her answer with continue goes on, and its reply moves the last reply', async t => {
  const f = await setup(t);
  const loop = await f.open();
  f.commit('morning-news', LETTER());
  await loop.tickPostbox();
  const task = await run(f, loop, tokyo('2026-10-11 07:00'));
  f.agent.settle(task.id, 'input-required', '国内のものだけでよいですか？');
  f.script({ calls: [{ name: 'ask_agent', arguments: { agent: 'news', message: '国内のものだけでよいです', continue: true } }] });
  await poll(f, loop);
  const [question] = replies(f.model);
  assert.deepEqual([question!.state, question!.postbox], ['input_required', 'morning-news']);
  assert.deepEqual([f.agent.received[1]!.contextId, f.agent.received[1]!.taskId], [task.contextId, task.id], 'her answer goes on with the run');
  assert.equal(f.letter('morning-news')!.lastResult, 'input-required');
  // Her answer is put in a directory of its own at the same time, so the run's is told by its request.
  const runs = [];
  for (const name of await f.directories()) if ((await f.read(`${name}/request.md`)).includes('postbox: morning-news')) runs.push(name);
  const [asked] = runs;
  assert.equal(runs.length, 1);
  assert.equal(f.letter('morning-news')!.lastReplyPath, `/sources/agents/news/${asked}`, 'the question was put, to be read');

  f.clock.now = tokyo('2026-10-11 07:30');
  f.agent.settle(task.id, 'completed', '国内のニュースが 1 件あります。');
  f.script();
  await poll(f, loop);
  const answered = replies(f.model).at(-1)!;
  assert.deepEqual([answered.state, answered.postbox], ['completed', 'morning-news'], 'the reply to her answer is hers, told at once');
  assert.equal(f.letter('morning-news')!.lastResult, 'received');
  assert.equal(f.letter('morning-news')!.lastReceivedAt, tokyo('2026-10-11 07:00'), 'the run\'s time, not the answer\'s');
  const answeredIn = (await f.directories()).filter(name => name !== asked);
  assert.equal(answeredIn.length, 1, 'her answer has a directory of its own');
  assert.equal(f.letter('morning-news')!.lastReplyPath, `/sources/agents/news/${answeredIn[0]}`, 'the reply to her answer is the last one put');
});

test('her letter that would not be sent goes back at the end of the turn with the reason; a good one is read at once', async t => {
  const f = await setup(t);
  const loop = await f.open();
  await mkdir(join(f.memory, 'postbox'), { recursive: true });
  await writeFile(join(f.memory, 'postbox', 'inbox.md'), LETTER().replace('0 7 * * *', '*/5 * * * *'));
  f.script();
  loop.send({ requestId: 'request-1', deviceId: 'device-1', text: '定期便を置いておいて' });
  await loop.idle();
  await assert.rejects(stat(join(f.memory, 'postbox', 'inbox.md')), 'put back: a new file is removed');
  loop.send({ requestId: 'request-2', deviceId: 'device-1', text: 'どうだった？' });
  await loop.idle();
  const prompt = JSON.stringify(f.model.contexts.at(-1));
  assert.match(prompt, /postbox\/inbox\.md: cron \\"\*\/5 \* \* \* \*\\" の回の間隔が 5 分で、下限の 15 分より短いです/);

  await writeFile(join(f.memory, 'postbox', 'morning-news.md'), LETTER());
  loop.send({ requestId: 'request-3', deviceId: 'device-1', text: '今度は毎朝で' });
  await loop.idle();
  assert.ok(f.letter('morning-news'), 'read as the turn committed it, before any look of the clock');
  assert.equal(f.letter('morning-news')!.nextAt, tokyo('2026-10-11 07:00'));
});

test('an owner\'s letter that fails the check is passed over and told to her in her next turn; the others are sent', async t => {
  const f = await setup(t);
  const loop = await f.open();
  f.commit('noisy', LETTER().replace('0 7 * * *', '*/5 * * * *'));
  f.commit('morning-news', LETTER());
  await loop.tickPostbox();
  f.script();
  loop.send({ requestId: 'request-1', deviceId: 'device-1', text: 'おはよう' });
  await loop.idle();
  assert.match(JSON.stringify(f.model.contexts.at(-1)), /postbox\/noisy\.md: .*5 分/);
  await run(f, loop, tokyo('2026-10-11 07:00'));
  assert.deepEqual(f.agent.received.map(received => received.metadata), [{ postbox: { name: 'morning-news' } }]);
  assert.match(f.letter('noisy')!.problem!, /5 分/);
});

test('postbox.enabled: false sends no letter', async t => {
  const f = await setup(t, { postbox: { enabled: false, minIntervalMinutes: 15 } });
  const loop = await f.open();
  f.commit('morning-news', LETTER());
  await loop.tickPostbox();
  f.clock.now = tokyo('2026-10-11 07:00');
  await loop.tickPostbox();
  assert.equal(f.agent.received.length, 0);
});
