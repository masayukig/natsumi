import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { LOOP_DEFAULTS, type LoopConfig } from '../src/server/config.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type SendOutcome } from '../src/server/thinking-loop.ts';
import { CUT_SHORT_NOTICE_INTERVAL_MS, CutShortNotices, cutShortText, waitedOnKinds } from '../src/server/turn-notice.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';

/** Fork (ADR F05): a turn someone waits on that is cut short is told to the owner by the server, once. */

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-turn-notice-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(data);
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(data, 'personality.md'), '# 性格・話し方\n落ち着いた話し方\n');
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  let loop: ThinkingLoop | undefined;
  const events: LoopClientEvent[] = [];
  let counter = 0;
  return {
    model, events,
    async open(settings: Partial<LoopConfig>) {
      loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, ...settings }, tellCutShort: true,
        configureSession: session => { session.agent.streamFunction = model.streamFunction; },
      });
      loop.subscribe(event => { events.push(event); });
      return loop;
    },
    async send(text: string) {
      const outcome = loop!.send({ requestId: `request-${++counter}`, deviceId: 'device-1', text });
      assert.equal(outcome.kind, 'accepted');
      await loop!.idle();
      return outcome as Extract<SendOutcome, { kind: 'accepted' }>;
    },
    notices: () => events.filter(e => e.type === 'conversation.message' && e.payload.kind === 'notice').map(e => e.payload.text),
    async cleanup() {
      await loop?.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const keepCalling = () => ({ calls: [{ name: 'set_mac_avatar_expression', arguments: { expression: 'thinking' } }] });

test('a turn cut at the model-call limit tells the owner once, as a notice; a turn that ends on its own tells nothing', async () => {
  const f = await setup();
  try {
    const loop = await f.open({ eventModelCalls: 3 });
    f.model.auto = context => context.messages.at(-1)?.role === 'user'
      ? { calls: [{ name: 'reply_to_mac', arguments: { text: 'はい', expression: 'neutral' } }] } : { calls: [] };
    await f.send('ふつうの話');
    assert.deepEqual(f.notices(), []);

    f.model.auto = keepCalling;
    await f.send('PDF を読んで');
    assert.deepEqual(f.notices(), ['マスターのメッセージへの対応が途中で打ち切られました（考える回数の上限 3 回）。返事が届いていなければ、もう一度話しかけてください。']);
    // Recorded like her own notices, so a client that comes later sees it too.
    assert.equal(loop.snapshot().messages.filter(m => m.kind === 'notice').length, 1);

    // The next cut within the interval stays in the log only.
    await f.send('もう一度');
    assert.equal(f.notices().length, 1);
  } finally { await f.cleanup(); }
});

test('a nightly review cut at its limit tells the owner nothing', async () => {
  const f = await setup();
  try {
    const loop = await f.open({ reviewModelCalls: 2 });
    f.model.auto = context => context.messages.at(-1)?.role === 'user'
      ? { calls: [{ name: 'reply_to_mac', arguments: { text: 'はい', expression: 'neutral' } }] } : { calls: [] };
    await f.send('昼の話');
    f.model.auto = keepCalling;
    assert.equal((await loop.rotate()).result, 'failed');
    assert.deepEqual(f.notices(), []);
  } finally { await f.cleanup(); }
});

test('the notice names the limit and what was waited on, and only events someone waits on count', () => {
  const base = { maxCalls: 8, timeoutMinutes: 10 };
  assert.equal(cutShortText({ ...base, failure: 'timeout', kinds: ['slack-mention', 'mac-message'] }),
    'Slack のメンションとマスターのメッセージへの対応が途中で打ち切られました（時間の上限 10 分）。返事が届いていなければ、もう一度話しかけてください。');
  assert.match(cutShortText({ ...base, failure: 'model-error', kinds: ['agent-reply'] })!, /^エージェントからの返事への対応が途中で止まりました/);
  assert.equal(cutShortText({ ...base, failure: 'model-call-limit', kinds: ['self-check', 'ping', 'sources-updated'] }), undefined);
  assert.equal(cutShortText({ ...base, failure: 'stopped', kinds: ['mac-message'] }), undefined);

  const notices = new CutShortNotices();
  const turn = { ...base, failure: 'model-call-limit', kinds: ['mac-message' as const] };
  assert.ok(notices.take(turn, 0));
  assert.equal(notices.take(turn, CUT_SHORT_NOTICE_INTERVAL_MS - 1), undefined);
  assert.ok(notices.take(turn, CUT_SHORT_NOTICE_INTERVAL_MS));
});

test('a sources update that carries a Slack mention counts as one waited on; one without does not', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-turn-notice-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  t.after(() => db.close());
  migrate(db, MIGRATIONS);
  for (const id of ['with', 'without']) {
    db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
      VALUES (?, 'sources-updated', NULL, 'no-reply', '2026-10-03T00:45:00.000Z', '2026-10-03T00:45:00.000Z')`).run(id);
  }
  db.prepare(`INSERT INTO source_attention (source, kind, dir, file, path, images, created_at, event_id)
    VALUES ('slack', 'mention', 'slack/work/dev', '/sources/slack/work/dev/2026-10-03.jsonl', '.[3]', '[]', '2026-10-03T00:45:00.000Z', 'with')`).run();
  const kinds = waitedOnKinds(db, ['with', 'without', 'ping'], ['sources-updated', 'sources-updated', 'ping']);
  assert.deepEqual(kinds, ['slack-mention', 'sources-updated', 'ping']);
  assert.match(cutShortText({ failure: 'model-call-limit', kinds, maxCalls: 16, timeoutMinutes: 10 })!, /^Slack のメンションへの対応が途中で打ち切られました/);
});
