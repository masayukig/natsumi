import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { LOOP_DEFAULTS } from '../src/server/config.ts';
import { LOOP_TOOL_NAMES, RUN_SHELL_TOOL_NAME } from '../src/server/loop-tools.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop } from '../src/server/thinking-loop.ts';
import { DECODABLE_PNG, PNG } from './support/fake-slack.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';

/**
 * What the loop makes of what natsumi reads (ADR 0039, ADR 0050): a `sources_updated` event whose line the sources make
 * as its turn begins, with the images of its attentions beside it; one waiting at most; none when nothing is there to
 * show. A ping is a quiet moment's cue and nothing more.
 */

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Sources that show what the test put in, once, and nothing after. */
class FakeSources {
  next: Record<string, unknown> | undefined;
  readonly taken: string[] = [];
  readonly lines = new Map<string, Record<string, unknown>>();
  async take(eventId: string) {
    this.taken.push(eventId);
    if (!this.next) return false;
    this.lines.set(eventId, this.next);
    this.next = undefined;
    return true;
  }
  eventLine(eventId: string, receivedAt: string) { return { type: 'sources_updated', received_at: receivedAt, ...this.lines.get(eventId) }; }
  async images() { return [{ type: 'image' as const, mimeType: 'image/png', data: DECODABLE_PNG.toString('base64') }]; }
}

/** A dove that takes every request. */
class FakeDove {
  readonly asked: string[] = [];
  ask(message: string) {
    this.asked.push(message);
    return { ok: true, text: 'ポッポさんが投稿の依頼を受け付けました。' };
  }
}

async function setup(t: test.TestContext, options: { shell?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-slack-loop-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(data);
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  model.auto = () => ({ text: '' });
  const sources = new FakeSources();
  const dove = new FakeDove();
  const loop = await ThinkingLoop.open({
    db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
    runtime: fixtureRuntime,
    loop: { ...LOOP_DEFAULTS, eventModelCalls: 4, ...(options.shell ? { workspaceSocket: join(root, 'no-runner.sock') } : {}) },
    configureSession: session => { session.agent.streamFunction = model.streamFunction; },
    sources,
    dove,
  });
  t.after(async () => {
    await loop.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, data, db, loop, model, sources, dove };
}

const userMessages = (context: Context) => context.messages.filter(message => message.role === 'user');
const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};

test('what the sources show is an event of its own, with the images of its attentions beside it', async t => {
  const f = await setup(t);
  f.sources.next = { changed: [{ dir: '/sources/slack/work/dev', files: ['/sources/slack/work/dev/2026-09-25.jsonl'], writes: 2,
    attention: [{ source: 'slack', kind: 'mention', file: '/sources/slack/work/dev/2026-09-25.jsonl', path: '.[4]' }] }] };
  assert.equal(f.loop.raiseSourcesUpdated(), true);
  const context = await until(() => f.model.contexts[0]);
  const prompt = userMessages(context).at(-1)!;
  assert.match(textOf(prompt), /"type":"sources_updated"/);
  assert.match(textOf(prompt), /"kind":"mention","file":"\/sources\/slack\/work\/dev\/2026-09-25\.jsonl","path":"\.\[4\]"/);
  const parts = (prompt as { content: { type: string; data?: string }[] }).content;
  assert.deepEqual(parts.filter(part => part.type === 'image').map(part => part.data), [DECODABLE_PNG.toString('base64')]);
  await f.loop.idle();
  const row = f.db.prepare(`SELECT kind, state FROM loop_events`).get() as { kind: string; state: string };
  assert.deepEqual({ ...row }, { kind: 'sources-updated', state: 'no-reply' });
});

test('one sources_updated waits at most: asking again while one is queued adds none', async t => {
  const f = await setup(t);
  f.model.takeOver();
  f.loop.send({ requestId: 'r1', deviceId: 'd1', text: 'こんにちは' });
  const first = await f.model.next();
  // While the owner's turn runs, the sources ask three times.
  f.sources.next = { changed: [{ dir: '/sources/slack/work/dev', files: [], writes: 1 }] };
  assert.equal(f.loop.raiseSourcesUpdated(), true);
  assert.equal(f.loop.raiseSourcesUpdated(), false);
  assert.equal(f.loop.raiseSourcesUpdated(), false);
  first.finish();
  const second = await f.model.next();
  assert.match(textOf(userMessages(second.context).at(-1)!), /sources_updated/);
  second.finish();
  await f.loop.idle();
  const rows = f.db.prepare(`SELECT COUNT(*) AS n FROM loop_events WHERE kind = 'sources-updated'`).get() as { n: number };
  assert.equal(rows.n, 1);
  // Once it has begun, the next ask queues a new one.
  f.model.auto = () => ({ text: '' });
  assert.equal(f.loop.raiseSourcesUpdated(), true);
  await f.loop.idle();
});

test('a sources_updated with nothing to show ends without a turn', async t => {
  const f = await setup(t);
  f.loop.raiseSourcesUpdated();
  await f.loop.idle();
  assert.equal(f.model.contexts.length, 0);
  assert.equal(f.sources.taken.length, 1);
  const row = f.db.prepare(`SELECT state FROM loop_events`).get() as { state: string };
  assert.equal(row.state, 'no-reply');
});

test('a ping carries no updates: it is only the quiet moment\'s cue', async t => {
  const f = await setup(t);
  f.sources.next = { changed: [] };
  assert.equal(f.loop.ping(), true);
  await f.loop.idle();
  const line = textOf(userMessages(f.model.contexts.at(-1)!).at(-1)!);
  assert.match(line, /"type":"ping"/);
  assert.doesNotMatch(line, /updates|sources/);
  assert.equal(f.sources.taken.length, 0);
});

test('view in the shell answers with the image, from the server, without the runner', async t => {
  const f = await setup(t, { shell: true });
  await mkdir(join(f.data, 'sources', 'slack'), { recursive: true });
  await writeFile(join(f.data, 'sources', 'slack', 'a.png'), PNG);
  f.model.takeOver();
  f.loop.ping();
  const first = await f.model.next();
  first.call('run_shell', { command: 'view /sources/slack/a.png' });
  first.finish();
  const second = await f.model.next();
  const result = second.context.messages.find(message => message.role === 'toolResult') as
    { content: { type: string; data?: string; text?: string }[]; isError?: boolean };
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.filter(part => part.type === 'image').map(part => part.data), [PNG.toString('base64')]);
  second.finish();
  await f.loop.idle();
});

test('natsumi has no tool that posts to Slack: a post is a request to the dove through ask_agent', async t => {
  const f = await setup(t);
  f.model.takeOver();
  f.loop.ping();
  const first = await f.model.next();
  for (const name of [...LOOP_TOOL_NAMES, RUN_SHELL_TOOL_NAME]) assert.doesNotMatch(name, /slack|post|chat|reaction|dove|poppo/i, name);
  first.call('ask_agent', { agent: 'poppo', message: '{"kind":"post","to":{"file":"/sources/slack/work/dev"},"text":"おはよう"}', continue: false });
  first.finish();
  const second = await f.model.next();
  const result = second.context.messages.find(message => message.role === 'toolResult') as { content: { text?: string }[]; isError?: boolean };
  assert.equal(result.isError, false);
  assert.match(result.content[0]!.text!, /ポッポさん/);
  assert.deepEqual(f.dove.asked, ['{"kind":"post","to":{"file":"/sources/slack/work/dev"},"text":"おはよう"}']);
  second.finish();
  await f.loop.idle();
});
