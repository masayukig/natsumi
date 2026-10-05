import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { AGENTS_REGISTRATION, MAX_SUMMARY_CHARS, replyPlaceOf } from '../src/server/agent-replies.ts';
import { LOOP_DEFAULTS, type A2AConfig } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SOURCES_DEFAULTS, Sources } from '../src/server/sources.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent } from '../src/server/thinking-loop.ts';
import { FakeAgent, type FakeFile } from './support/fake-agent.ts';
import { PNG } from './support/fake-slack.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

const HOUR = 3_600_000;

/**
 * natsumi asks an outside agent with `ask_agent` (ADR 0035, ADR 0036), and what it answers is put under
 * /sources/agents as files and reaches her as an attention of a `sources_updated` event (ADR 0069). The agent here is
 * a fake one speaking the real protocol; the model is scripted.
 */
async function setup(t: test.TestContext, options: { a2a?: Partial<A2AConfig> | false; place?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-agents-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(join(data, 'work'), { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  const tokenFile = join(root, 'a2a-token');
  await writeFile(tokenFile, 'fake-agent-token\n');
  const agent = await FakeAgent.start();
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const clock = { now: Date.parse('2026-09-24T03:00:00Z') };
  const a2a: A2AConfig | undefined = options.a2a === false ? undefined : {
    tokenFile, pollIntervalSeconds: 15, giveUpAfterHours: 24, agents: { wiki: { url: agent.url } }, ...options.a2a,
  };
  const sourcesDirectory = join(data, 'sources');
  const opened: ThinkingLoop[] = [];
  const f = {
    agent, model, clock, db, tokenFile, root, work: join(data, 'work'), replies: join(sourcesDirectory, 'agents'),
    async open() {
      const sources = new Sources({ db, directory: sourcesDirectory, gitDirectory: join(data, 'sources.git'), timeZone: 'Asia/Tokyo',
        awakeHours: LOOP_DEFAULTS.awakeHours, activity: SOURCES_DEFAULTS.activity, historyDays: 7, now: () => clock.now });
      sources.register(AGENTS_REGISTRATION);
      await sources.prepare();
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, eventModelCalls: 6 }, now: () => clock.now,
        configureSession: session => { session.agent.streamFunction = model.streamFunction; },
        ...(a2a ? { a2a } : {}), sources,
        ...(options.place === false ? {} : { agentReplies: replyPlaceOf(sources, sourcesDirectory) }),
      });
      sources.connect(() => { loop.raiseSourcesUpdated(); });
      opened.push(loop);
      const events: LoopClientEvent[] = [];
      loop.subscribe(event => { events.push(event); });
      return { loop, events };
    },
    /** The model answers each call with the next step, and stops without a tool once the steps run out. */
    script(...steps: ScriptedStep[]) {
      model.auto = () => steps.shift() ?? { text: '' };
    },
    /** A file of a reply, by the path the attention names it with. */
    read(path: string) { return readFile(join(sourcesDirectory, path.slice('/sources/'.length)), 'utf8'); },
    list(path: string) { return readdir(join(sourcesDirectory, path.slice('/sources/'.length))); },
  };
  t.after(async () => {
    for (const loop of opened) await loop.close();
    db.close();
    await agent.close();
    await rm(root, { recursive: true, force: true });
  });
  return f;
}

const ask = (agent: string, message: string, cont: boolean): ScriptedStep =>
  ({ calls: [{ name: 'ask_agent', arguments: { agent, message, continue: cont } }] });

const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};
/** Every tool result the model has been shown, in order. */
const toolResults = (model: ScriptedModel) => {
  const last = model.contexts.at(-1);
  return (last?.messages ?? []).filter(m => m.role === 'toolResult')
    .map(m => ({ text: textOf(m), isError: (m as { isError: boolean }).isError }));
};
/** The lines of one type the model has been handed, parsed. */
const lines = (model: ScriptedModel, type: string) => {
  const last = model.contexts.at(-1);
  return (last?.messages ?? []).filter(m => m.role === 'user').map(textOf)
    .flatMap(text => text.split('\n')).filter(line => line.includes(`"type":"${type}"`))
    .map(line => JSON.parse(line) as Record<string, unknown>);
};
interface ReplyAttention { source: string; kind: string; file: string; agent: string; state: string; summary: string; images?: number }
/** The attentions of the agents' replies the model has been handed, in order. */
const replies = (model: ScriptedModel): ReplyAttention[] => lines(model, 'sources_updated')
  .flatMap(line => (line.changed as { attention?: ReplyAttention[] }[]).flatMap(entry => entry.attention ?? []))
  .filter(attention => attention.kind === 'agent_reply');
/** The reply's directory, as the attention names its README. */
const dirOf = (reply: ReplyAttention) => reply.file.replace(/\/README\.md$/, '');

/** Hands the loop a mac message and lets the scripted turn run to its end. */
async function turn(f: Awaited<ReturnType<typeof setup>>, loop: ThinkingLoop, text = '頼みごとがあります') {
  const outcome = loop.send({ requestId: `request-${Math.random()}`, deviceId: 'device-1', text });
  assert.equal(outcome.kind, 'accepted');
  await loop.idle();
}

test('ask_agent sends the message to the named agent and only says the answer will come later, as an attention', async t => {
  const f = await setup(t);
  const { loop, events } = await f.open();
  f.script(ask('wiki', 'ねこの記事を要約して', false));
  await turn(f, loop);
  assert.equal(f.agent.received.length, 1);
  assert.equal(f.agent.received[0]!.text, 'ねこの記事を要約して');
  assert.equal(f.agent.received[0]!.contextId, '');
  const [result] = toolResults(f.model);
  assert.equal(result!.isError, false);
  assert.match(result!.text, /wiki/);
  assert.match(result!.text, /sources_updated/);
  assert.match(result!.text, /agent_reply/);
  // No ID reaches her (ADR 0024), and nothing of the exchange reaches the owner's conversation (ADR 0025).
  const task = f.agent.lastTask();
  assert.equal(result!.text.includes(task.id), false);
  assert.equal(result!.text.includes(task.contextId), false);
  assert.deepEqual(events.filter(e => e.type === 'conversation.message' && e.payload.role === 'natsumi'), []);
});

test('a finished task is put under /sources/agents and reaches her as an attention with its summary, and is not fetched again', async t => {
  const f = await setup(t);
  const { loop, events } = await f.open();
  f.script(ask('wiki', 'ねこの記事を要約して', false));
  await turn(f, loop);
  const calls = f.model.calls;
  await loop.pollAgents();
  await loop.idle();
  assert.equal(f.agent.polls.length, 1);
  assert.equal(f.model.calls, calls, 'a task still running raises nothing');

  f.agent.settle(f.agent.lastTask().id, 'completed', 'ねこは液体です。\n\n## 根拠\n\n容器に合わせて形を変えます。');
  f.script();
  await loop.pollAgents();
  await loop.idle();
  assert.ok(f.model.calls > calls);
  const [reply] = replies(f.model);
  assert.match(reply!.file, /^\/sources\/agents\/wiki\/20260924T030000Z-[0-9a-f]{4}\/README\.md$/);
  assert.deepEqual({ ...reply, file: undefined },
    { source: 'agents', kind: 'agent_reply', file: undefined, agent: 'wiki', state: 'completed', summary: 'ねこは液体です。' });
  // The body is in the files only: the event carries the summary and the place.
  const prompt = JSON.stringify(f.model.contexts.at(-1));
  assert.equal(prompt.includes('容器に合わせて形を変えます。'), false);
  assert.equal(prompt.includes(f.agent.lastTask().id), false);
  assert.equal(prompt.includes(f.agent.lastTask().contextId), false);
  assert.equal(lines(f.model, 'agent_reply').length, 0, 'no agent_reply event any more');
  assert.deepEqual((await f.list(dirOf(reply!))).sort(), ['01-はじめに.md', '02-根拠.md', 'README.md', 'result.json', 'sources.json']);
  assert.equal(await f.read(`${dirOf(reply!)}/02-根拠.md`), '# 根拠\n\n容器に合わせて形を変えます。\n');
  assert.match(await f.read(reply!.file), /02-根拠\.md/);
  assert.deepEqual(events.filter(e => e.type === 'conversation.message' && e.payload.role === 'natsumi'), []);

  await loop.pollAgents();
  assert.equal(f.agent.polls.length, 2, 'a settled task is not fetched again');
  assert.deepEqual({ ...f.db.prepare('SELECT count(*) AS n FROM agent_replies').get() }, { n: 0 });
});

test('a question from the agent is answered with continue: true, on the same task; continue: false starts afresh', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('wiki', '記事を直して', false));
  await turn(f, loop);
  const first = f.agent.lastTask();
  f.agent.settle(first.id, 'input-required', 'どの記事ですか？');
  f.script(ask('wiki', 'index の方です', true));
  await loop.pollAgents();
  await loop.idle();
  assert.deepEqual(replies(f.model).map(r => [r.state, r.summary]), [['input_required', 'どの記事ですか？']]);
  assert.deepEqual([f.agent.received[1]!.contextId, f.agent.received[1]!.taskId], [first.contextId, first.id]);
  assert.equal(f.agent.tasks.size, 1, 'the answer goes on with the task that asked');
  // A task waiting for her is not fetched meanwhile.
  const polled = f.agent.polls.length;

  f.agent.settle(first.id, 'completed', '直しました。');
  f.script(ask('wiki', '別の話です', false));
  await loop.pollAgents();
  await loop.idle();
  assert.equal(f.agent.polls.length, polled + 1);
  assert.equal(f.agent.received[2]!.contextId, '', 'continue: false leaves the context for the agent to number');

  f.agent.settle(f.agent.lastTask().id, 'completed', '別の答え');
  f.script(ask('wiki', 'さっきの続き', true));
  await loop.pollAgents();
  await loop.idle();
  const second = f.agent.lastTask();
  assert.deepEqual([f.agent.received[3]!.contextId, f.agent.received[3]!.taskId], [second.contextId, '']);
  // Each answer is a reply of its own.
  assert.equal(new Set(replies(f.model).map(dirOf)).size, 3);
});

test('continue is refused with nothing to go on with, and while the last task is still running; nothing is sent', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('wiki', '続きです', true));
  await turn(f, loop);
  let [result] = toolResults(f.model);
  assert.equal(result!.isError, true);
  assert.match(result!.text, /continue/);
  assert.equal(f.agent.received.length, 0);

  f.script(ask('wiki', '最初', false), ask('wiki', 'まだ？', true));
  await turn(f, loop);
  result = toolResults(f.model).at(-1);
  assert.equal(result!.isError, true);
  assert.match(result!.text, /待って/);
  assert.doesNotMatch(result!.text, /agent_reply の出来事/);
  assert.equal(f.agent.received.length, 1);
});

test('an agent not in the config is refused and pointed at the list, and without the a2a section every ask is refused', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('search', 'しらべて', false));
  await turn(f, loop);
  const [result] = toolResults(f.model);
  assert.equal(result!.isError, true);
  assert.match(result!.text, /search/);
  assert.match(result!.text, /\/manual\/agents\/INDEX\.md/);
  assert.equal(f.agent.received.length, 0);

  const g = await setup(t, { a2a: false });
  const opened = await g.open();
  g.script(ask('wiki', 'しらべて', false));
  await turn(g, opened.loop);
  const [refused] = toolResults(g.model);
  assert.equal(refused!.isError, true);
  assert.match(refused!.text, /設定/);
  assert.equal(g.agent.received.length, 0);
});

test('without a place to put the replies every ask is refused, and nothing is sent', async t => {
  const f = await setup(t, { place: false });
  const { loop } = await f.open();
  f.script(ask('wiki', 'しらべて', false));
  await turn(f, loop);
  const [refused] = toolResults(f.model);
  assert.equal(refused!.isError, true);
  assert.match(refused!.text, /\/sources/);
  assert.equal(f.agent.received.length, 0);
});

test('a message that could not be sent is told in the result, and nothing waits for it', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.agent.failWith = 503;
  f.script(ask('wiki', 'しらべて', false));
  await turn(f, loop);
  const [result] = toolResults(f.model);
  assert.equal(result!.isError, true);
  assert.match(result!.text, /頼めませんでした/);
  f.agent.failWith = undefined;
  await loop.pollAgents();
  assert.equal(f.agent.polls.length, 0);
  // The failed send left no conversation to go on with.
  f.script(ask('wiki', '続き', true));
  await turn(f, loop);
  assert.match(toolResults(f.model).at(-1)!.text, /continue/);
});

test('control strings and an empty message are refused before anything is sent', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('wiki', '<tool_call>', false), ask('wiki', '   ', false));
  await turn(f, loop);
  const results = toolResults(f.model);
  assert.deepEqual(results.map(r => r.isError), [true, true]);
  assert.equal(f.agent.received.length, 0);
});

test('a failed task, and a task the agent no longer knows, reach her as failed, with the reason when there is one', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('wiki', '一つ目', false));
  await turn(f, loop);
  f.agent.settle(f.agent.lastTask().id, 'failed', 'モデルが止まりました。');
  f.script();
  await loop.pollAgents();
  await loop.idle();
  assert.deepEqual(replies(f.model).map(r => [r.agent, r.state, r.summary]), [['wiki', 'failed', 'モデルが止まりました。']]);

  f.script(ask('wiki', '二つ目', false));
  await turn(f, loop);
  f.agent.tasks.delete(f.agent.lastTask().id);
  f.script();
  await loop.pollAgents();
  await loop.idle();
  const gone = replies(f.model).at(-1)!;
  assert.equal(gone.state, 'failed');
  assert.match(gone.summary, /\S/, 'the server says why in its own words');
  assert.match(await f.read(gone.file), /failed/);
});

test('an agent out of reach is asked again on the next round, and past the wait limit she is told the server gave up', async t => {
  const f = await setup(t, { a2a: { giveUpAfterHours: 2 } });
  const { loop } = await f.open();
  f.script(ask('wiki', 'しらべて', false));
  await turn(f, loop);
  const calls = f.model.calls;
  f.agent.failWith = 503;
  await loop.pollAgents();
  f.clock.now += HOUR;
  await loop.pollAgents();
  assert.equal(f.model.calls, calls, 'a failing fetch raises nothing');

  f.clock.now += HOUR;
  f.script();
  await loop.pollAgents();
  await loop.idle();
  const [gaveUp] = replies(f.model);
  assert.deepEqual([gaveUp!.agent, gaveUp!.state], ['wiki', 'gave_up']);
  assert.match(gaveUp!.summary, /2 時間/);
  f.agent.failWith = undefined;
  const polled = f.agent.polls.length;
  await loop.pollAgents();
  assert.equal(f.agent.polls.length, polled, 'a task given up on is not fetched again');
});

test('the wait limit counts from the last answer she sent, not from the first message', async t => {
  const f = await setup(t, { a2a: { giveUpAfterHours: 2 } });
  const { loop } = await f.open();
  f.script(ask('wiki', '記事を直して', false));
  await turn(f, loop);
  f.clock.now += HOUR + HOUR / 2;
  f.agent.settle(f.agent.lastTask().id, 'input-required', 'どの記事ですか？');
  f.script(ask('wiki', 'index の方です', true));
  await loop.pollAgents();
  await loop.idle();
  f.clock.now += HOUR;
  await loop.pollAgents();
  assert.equal(replies(f.model).length, 1, 'only the question so far; the answer sent an hour ago is still inside the limit');
  f.clock.now += HOUR;
  f.script();
  await loop.pollAgents();
  await loop.idle();
  assert.equal(replies(f.model).at(-1)!.state, 'gave_up');
});

test('a task waiting when the server stops is fetched again after the restart', async t => {
  const f = await setup(t);
  const first = await f.open();
  f.script(ask('wiki', 'しらべて', false));
  await turn(f, first.loop);
  await first.loop.close();

  const { loop } = await f.open();
  f.agent.settle(f.agent.lastTask().id, 'completed', '再起動のあとでも届きます。');
  f.script();
  await loop.pollAgents();
  await loop.idle();
  assert.deepEqual(replies(f.model).map(r => r.summary), ['再起動のあとでも届きます。']);
  // The conversation is remembered across the restart too.
  f.script(ask('wiki', '続き', true));
  await turn(f, loop);
  assert.equal(f.agent.received.at(-1)!.contextId, f.agent.lastTask().contextId);
});

test('an agent_reply event recorded before the replies moved to /sources is still handed over once, as it was', async t => {
  const f = await setup(t);
  f.db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
    VALUES ('event-old', 'agent-reply', NULL, 'queued', '2026-09-24T02:00:00.000Z', '2026-09-24T02:00:00.000Z')`).run();
  f.db.prepare(`INSERT INTO agent_replies (event_id, agent, status, text, files, created_at)
    VALUES ('event-old', 'wiki', 'completed', '前からの返事です。', '', '2026-09-24T02:00:00.000Z')`).run();
  f.script();
  const { loop } = await f.open();
  await loop.idle();
  assert.deepEqual(lines(f.model, 'agent_reply').map(line => [line.agent, line.status, line.text]), [['wiki', 'completed', '前からの返事です。']]);
});

test('a long answer is kept whole in its sections, and only its cut summary reaches her', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('wiki', 'ぜんぶ教えて', false));
  await turn(f, loop);
  const long = 'あ'.repeat(20_000);
  f.agent.settle(f.agent.lastTask().id, 'completed', long);
  f.script();
  await loop.pollAgents();
  await loop.idle();
  const [reply] = replies(f.model);
  assert.equal([...reply!.summary].length, MAX_SUMMARY_CHARS);
  assert.equal(await f.read(`${dirOf(reply!)}/01-本文.md`), `# 本文\n\n${long}\n`);
  assert.ok(JSON.stringify(f.model.contexts.at(-1)).length < 20_000);
});

test('an agent that answers at once with a message reaches her as a finished reply', async t => {
  const f = await setup(t);
  await f.agent.close();
  const agent = await FakeAgent.start({ replyWithMessage: 'すぐ答えます。' });
  t.after(() => agent.close());
  const g = await setup(t, { a2a: { agents: { wiki: { url: agent.url } } } });
  const { loop } = await g.open();
  g.script(ask('wiki', 'やあ', false));
  await turn(g, loop);
  await loop.idle();
  assert.deepEqual(replies(g.model).map(r => [r.state, r.summary]), [['completed', 'すぐ答えます。']]);
  assert.equal(agent.received.length, 1);
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);

/** Asks, lets the agent finish with `files` beside its text, and hands her the reply. */
async function finishWithFiles(f: Awaited<ReturnType<typeof setup>>, loop: ThinkingLoop, files: FakeFile[]) {
  f.script(ask('wiki', 'スクリーンショットを撮って', false));
  await turn(f, loop);
  f.agent.settle(f.agent.lastTask().id, 'completed', '撮りました。', { files });
  f.script();
  await loop.pollAgents();
  await loop.idle();
  const reply = replies(f.model).at(-1);
  assert.ok(reply, 'no reply reached her');
  return { reply, dir: dirOf(reply), readme: await f.read(reply.file) };
}

// The contract with fraction-agents: an image comes back as a FilePart, and the server brings it into the reply.
test('an image an agent hands back is put in the reply\'s images/, kept as a copy, and listed in the README with its description', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  const { reply, dir, readme } = await finishWithFiles(f, loop, [
    { name: 'screenshot-1.png', mimeType: 'image/png', description: 'example.com のトップページ', data: PNG },
    { name: 'photo.png', mimeType: 'image/png', description: '写真', data: JPEG },
  ]);
  assert.equal(reply.summary, '撮りました。');
  assert.equal(reply.state, 'completed');
  assert.equal(reply.images, 2);
  // Named by the agent's name for it; the extension follows the bytes.
  assert.deepEqual((await f.list(`${dir}/images`)).sort(), ['photo.jpg', 'screenshot-1.png']);
  assert.deepEqual(await readFile(join(f.replies, dir.slice('/sources/agents/'.length), 'images', 'screenshot-1.png')), PNG);
  assert.match(readme, /images\/screenshot-1\.png: example\.com のトップページ/);
  assert.match(readme, /images\/photo\.jpg: 写真/);
  assert.deepEqual(f.agent.fileRequests.map(r => r.authorization), ['Bearer fake-agent-token', 'Bearer fake-agent-token']);
  // The server keeps its own copy, as it does of every image she hands it (ADR 0044).
  const rows = f.db.prepare('SELECT source, mime_type, bytes FROM images ORDER BY source DESC').all().map(row => ({ ...row }));
  assert.deepEqual(rows, [
    { source: `${dir}/images/screenshot-1.png`, mime_type: 'image/png', bytes: PNG.length },
    { source: `${dir}/images/photo.jpg`, mime_type: 'image/jpeg', bytes: JPEG.length },
  ]);
  // Nothing is put in /work any more.
  assert.deepEqual(await readdir(f.work), []);
});

test('a name that is not safe as a file name is made safe, and two images of one name do not overwrite each other', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  const { dir } = await finishWithFiles(f, loop, [
    { name: '../../secret/shot.png', mimeType: 'image/png', data: PNG },
    { name: 'shot.png', mimeType: 'image/png', data: PNG },
    { name: 'スクショ', mimeType: 'image/png', data: PNG },
  ]);
  assert.deepEqual((await f.list(`${dir}/images`)).sort(), ['image-3.png', 'shot-2.png', 'shot.png']);
});

test('an image elsewhere than the agent is not fetched, and the README says it was not taken', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  const port = new URL(f.agent.url).port;
  const { reply, readme } = await finishWithFiles(f, loop, [
    { name: 'a.png', mimeType: 'image/png', data: PNG },
    { name: 'b.png', mimeType: 'image/png', uri: `http://localhost:${port}/artifacts/b` },
  ]);
  assert.equal(reply.summary, '撮りました。');
  assert.equal(reply.images, 1);
  assert.match(readme, /b\.png: 相手とは別の場所を指していたので、取りませんでした。/);
  assert.equal(f.agent.fileRequests.length, 1);
});

test('an image the agent refuses or no longer has is told as not taken, and the text still reaches her', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.agent.fileFailWith = 401;
  let { reply, readme } = await finishWithFiles(f, loop, [{ name: 'a.png', mimeType: 'image/png', data: PNG }]);
  assert.equal(reply.summary, '撮りました。');
  assert.equal(reply.images, undefined);
  assert.match(readme, /a\.png: 画像を取れませんでした（相手に断られました、401）。/);

  f.agent.fileFailWith = undefined;
  ({ readme } = await finishWithFiles(f, loop, [{ name: 'b.png', mimeType: 'image/png', uri: f.agent.fileUrl('gone') }]));
  assert.match(readme, /b\.png: 画像を取れませんでした（相手のところにありません、404。期限が過ぎたのかもしれません）。/);

  f.agent.fileFailWith = 503;
  ({ readme } = await finishWithFiles(f, loop, [{ name: 'c.png', mimeType: 'image/png', data: PNG }]));
  assert.match(readme, /c\.png: 画像を取れませんでした（相手につながりませんでした）。/);
});

test('an image over the size limit, one that is not an image by its bytes, and those past eight are not taken', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
  const files: FakeFile[] = [
    { name: 'big.png', mimeType: 'image/png', data: big },
    { name: 'page.png', mimeType: 'image/png', data: Buffer.from('<html>not an image</html>') },
    ...Array.from({ length: 9 }, (_, i) => ({ name: `shot-${i + 1}.png`, mimeType: 'image/png', data: PNG })),
  ];
  const { reply, dir, readme } = await finishWithFiles(f, loop, files);
  // Eight are looked at, in order; the two refused among them leave six taken.
  assert.equal(reply.images, 6);
  assert.deepEqual((await f.list(`${dir}/images`)).sort(),
    ['shot-1.png', 'shot-2.png', 'shot-3.png', 'shot-4.png', 'shot-5.png', 'shot-6.png']);
  assert.match(readme, /big\.png: 画像を取れませんでした（10 MB を超えていました）。/);
  assert.match(readme, /page\.png: 画像を取れませんでした（PNG・JPEG・WebP のどれでもありませんでした。中身で見分けます）。/);
  for (const name of ['shot-7.png', 'shot-8.png', 'shot-9.png']) assert.match(readme, new RegExp(`${name.replace('.', '\\.')}: 1 回の返事から取る画像は 8 枚までです。`));
  assert.equal(f.agent.fileRequests.some(r => f.agent.fileRequests.indexOf(r) >= 8), false, 'those past eight are not fetched');
});

test('a reply of text only has no images and says nothing of them', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  const { reply, dir, readme } = await finishWithFiles(f, loop, []);
  assert.deepEqual(Object.keys(reply).sort(), ['agent', 'file', 'kind', 'source', 'state', 'summary']);
  assert.equal((await f.list(dir)).includes('images'), false);
  assert.doesNotMatch(readme, /## 画像/);
  assert.deepEqual(f.agent.fileRequests, []);
});

test('an image an agent handed back can be shown to the owner with reply_to_mac, from where the server put it', async t => {
  const f = await setup(t);
  const { loop, events } = await f.open();
  const { dir } = await finishWithFiles(f, loop, [{ name: 'shot.png', mimeType: 'image/png', description: 'トップページ', data: PNG }]);
  f.script({ calls: [{ name: 'reply_to_mac', arguments: { text: '撮れました', expression: 'neutral', images: [`${dir}/images/shot.png`] } }] });
  await turn(f, loop, '見せて');
  assert.equal(toolResults(f.model).at(-1)!.isError, false, toolResults(f.model).at(-1)!.text);
  const shown = events.filter(e => e.type === 'conversation.message' && e.payload.role === 'natsumi')
    .map(e => (e.payload as { images?: unknown[] }).images ?? []);
  assert.equal(shown.at(-1)!.length, 1);
});
