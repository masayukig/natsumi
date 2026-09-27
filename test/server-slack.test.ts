import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../src/server/server.ts';
import { FakeSlack, referenceFromAttention, tsAt } from './support/fake-slack.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';
import { CLIENT_SECRET, serverConfig } from './support/server-fixture.ts';

async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function launch(t: test.TestContext, slack: Record<string, unknown> | undefined, prepare?: (fake: FakeSlack) => void) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-server-slack-')));
  const data = join(root, 'data');
  await mkdir(data);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ ...serverConfig(root), ...(slack ? { slack } : {}) }));
  const model = new ScriptedModel();
  model.auto = () => ({ text: '' });
  const fake = new FakeSlack();
  fake.addChannel({ id: 'C1', name: 'dev', isIm: false });
  prepare?.(fake);
  const tokens: { botToken: string; appToken: string }[] = [];
  const logs: string[] = [];
  const server = await startServer({
    config, dataDir: data, cwd: '/', home: join(root, 'home'),
    env: { NATSUMI_GITHUB_CLIENT_SECRET: CLIENT_SECRET, SLACK_BOT: 'fixture-bot-token', SLACK_APP: 'fixture-app-token' },
    log: line => { logs.push(line); },
    pi: { runtime: fixtureRuntime, configureSession: session => { session.agent.streamFunction = model.streamFunction; } },
    slack: { connector: given => { tokens.push(given); return { api: fake, socket: fake }; } },
  });
  t.after(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { root, data, model, fake, tokens, logs, server };
}

test('with a slack section, each workspace connects with its own tokens and a mention reaches natsumi as an attention', async t => {
  const f = await launch(t, { workspaces: { work: { botTokenEnv: 'SLACK_BOT', appTokenEnv: 'SLACK_APP' } } });
  assert.deepEqual(f.tokens, [{ botToken: 'fixture-bot-token', appToken: 'fixture-app-token' }]);
  await until(() => f.fake.started === 1);
  f.fake.emit({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '<@UBOT> こんにちは', ts: tsAt('2026-09-25T05:32:05Z') });
  const context = await until(() => f.model.contexts.find(candidate => JSON.stringify(candidate.messages).includes('sources_updated')));
  const prompt = JSON.stringify(context.messages.at(-1));
  // The fixture's time zone is UTC.
  assert.equal(referenceFromAttention(prompt, f.data), 'work/#dev 2026-09-25 05:32:05 山田');
  assert.match(prompt, /\\"kind\\":\\"mention\\"/);
  assert.doesNotMatch(prompt, /こんにちは/, 'the text is read from the file, not carried');
  assert.match(await readFile(join(f.data, 'sources', 'slack', 'INDEX.md'), 'utf8'), /work\/#dev/);
  // The history is kept outside /sources, which the workspace sees.
  assert.ok((await stat(join(f.data, 'sources.git', 'HEAD'))).isFile());
  await assert.rejects(stat(join(f.data, 'sources', '.git')));
  assert.ok(!f.logs.some(line => line.includes('fixture-bot-token') || line.includes('こんにちは')), 'no token or text in the log');
});

test('each workspace\'s custom emoji are read at the start, and a workspace without emoji:read logs one line (ADR 0042)', async t => {
  const f = await launch(t, { workspaces: { work: { botTokenEnv: 'SLACK_BOT', appTokenEnv: 'SLACK_APP' } } });
  await until(() => f.fake.emojiCalls === 1);
  const g = await launch(t, { workspaces: { work: { botTokenEnv: 'SLACK_BOT', appTokenEnv: 'SLACK_APP' } } }, fake => {
    fake.fail('customEmoji', '', 'emoji.list', 'missing_scope', 'emoji:read');
  });
  await until(() => g.logs.includes('slack (work): the custom emoji could not be read (emoji.list: missing_scope, needed emoji:read)'));
  assert.equal(g.fake.emojiCalls, 1);
});

test('an old slack.mentionContext or slack.updates is logged as no longer read, and does not stop the start', async t => {
  const f = await launch(t, { workspaces: { work: { botTokenEnv: 'SLACK_BOT', appTokenEnv: 'SLACK_APP' } }, mentionContext: { messages: 3 },
    updates: false });
  assert.ok(f.logs.includes('config: slack.mentionContext is no longer read (ADR 0050); it can be deleted'), f.logs.join('\n'));
  assert.ok(f.logs.includes('config: slack.updates is no longer read (ADR 0050); it can be deleted'), f.logs.join('\n'));
});

test('without a slack section nothing connects, and /sources is still made', async t => {
  const f = await launch(t, undefined);
  assert.deepEqual(f.tokens, []);
  assert.equal(f.fake.started, 0);
  assert.equal(f.fake.emojiCalls, 0);
  assert.ok((await stat(join(f.data, 'sources'))).isDirectory());
});
