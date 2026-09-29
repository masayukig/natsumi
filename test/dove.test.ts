import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/server/conversation-store.ts';
import { SlackDove, type DoveConfig } from '../src/server/dove.ts';
import { JUDGE_ISSUES, JudgeError, type JudgeClient, type Judgement } from '../src/server/judge.ts';
import { ImageStore } from '../src/server/images.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SlackArchive } from '../src/server/slack-archive.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { FakeSlack, PNG, tsAt } from './support/fake-slack.ts';

/**
 * The dove (ADR 0012, ADR 0039, ADR 0040), against a stand-in Slack and a stand-in Jev: natsumi's request is checked
 * and matched against the record, judged, and then sent, handed to the owner, or turned back. What happened comes back
 * to her later as an event whose line names no ID, and the owner decides on what was handed to her.
 */

const ORIGIN = 'https://natsumi.example.test';
const DAY = 86_400_000;
const CONFIG: DoveConfig = {
  thresholds: { owner: 0.3, return: 0.7 }, approvalDays: 7, placementFollowing: 2,
  judgeContext: { messages: 5, chars: 500 }, images: { maxBytes: 1024, maxCount: 2 },
};

/** A Jev that answers what the test queued, and records what it was asked. */
class FakeJev implements JudgeClient {
  readonly asked: { state: Record<string, unknown>; placement: boolean }[] = [];
  readonly answers: (Judgement | Error)[] = [];
  async judge(state: Record<string, unknown>, options: { placement: boolean }): Promise<Judgement> {
    this.asked.push({ state, placement: options.placement });
    const answer = this.answers.shift() ?? scores([], 'thread');
    if (answer instanceof Error) throw answer;
    return options.placement ? answer : { issues: answer.issues };
  }
}

function scores(values: number[], choice: 'thread' | 'channel' = 'thread'): Judgement {
  return {
    issues: JUDGE_ISSUES.map((issue, index) => ({ name: issue.name, label: issue.label, score: values[index] ?? 0.01 })),
    placement: { choice, probabilities: choice === 'thread' ? { thread: 0.8, channel: 0.2 } : { thread: 0.1, channel: 0.9 } },
  };
}
const SEND = () => scores([]);
const OWNER = () => scores([0.01, 0.5]);
const RETURN = () => scores([0.9]);

const PARENT = tsAt('2026-09-25T05:32:05Z'); // 14:32:05 in Tokyo

async function setup(t: test.TestContext, options: { jev?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-dove-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const clock = { now: Date.parse('2026-09-25T06:00:00Z') };
  const archive = new SlackArchive({ db, directory: join(root, 'slack'), timeZone: 'Asia/Tokyo', now: () => clock.now });
  archive.addChannel('work', 'C1', { name: 'dev', isIm: false });
  await archive.record('work', 'C1', { ts: PARENT, speaker: '山田', own: false, text: '明日のレビュー、大丈夫そう？', files: [], edited: false });
  // natsumi's /work, as the server sees it in the data directory, with one image she drew.
  const work = join(root, 'work');
  await mkdir(join(work, 'images'), { recursive: true });
  await writeFile(join(work, 'images', 'cat.png'), PNG);
  const images = new ImageStore(db, join(root, 'images'));
  const slack = new FakeSlack();
  const jev = new FakeJev();
  const store = new ConversationStore(db, () => clock.now);
  const events: string[] = [];
  const clientEvents: { type: string; payload: Record<string, any> }[] = [];
  const logs: string[] = [];
  const open = () => {
    const dove = new SlackDove({
      db, archive, workspaces: { work: slack }, ...(options.jev === false ? {} : { judge: jev }), config: CONFIG, publicOrigin: ORIGIN,
      workDirectory: work, images,
      now: () => clock.now, log: line => { logs.push(line); },
      raise: record => {
        events.push(store.transaction(transaction => {
          const id = store.insertEvent('dove-reply');
          record(id, transaction);
          return id;
        }));
      },
    });
    dove.subscribe(event => { clientEvents.push(event); });
    return dove;
  };
  const dove = open();
  t.after(async () => {
    dove.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const lines = () => events.map(id => dove.takeEventLine(id, '2026-09-25T06:00:00.000Z'));
  return { root, work, images, db, clock, archive, slack, jev, dove, events, clientEvents, logs, lines, open };
}

const post = (body: string, { to = 'work/#dev 2026-09-25 14:32:05 山田', expression }: { to?: string; expression?: string } = {}) =>
  `返信先: ${to}\n種類: 投稿\n${expression ? `表情: ${expression}\n` : ''}---\n${body}`;

/** No Slack ts, no approval or post ID: she names things by what she can read (ADR 0024). */
function assertNoIds(line: Record<string, unknown>) {
  const text = JSON.stringify(line);
  assert.doesNotMatch(text, /\d{10}\.\d{6}/, 'no Slack ts');
  assert.doesNotMatch(text, /approval-|post-|[0-9a-f]{8}-[0-9a-f]{4}-/, 'no ID of the server');
  assert.doesNotMatch(text, /C1\b/, 'no channel ID');
}

test('a draft Jev passes is sent at once, without the owner, into the thread, under the icon of her feeling', async t => {
  const f = await setup(t);
  f.jev.answers.push(SEND());
  const outcome = await f.dove.ask(post('大丈夫です。明日の 10 時に始めましょう。', { expression: 'happy' }));
  assert.equal(outcome.ok, true);
  assert.match(outcome.text, /受け付け/);
  assert.match(outcome.text, /agent_reply/);
  assert.equal(f.slack.posts.length, 0, 'the tool only takes the request');
  await f.dove.idle();
  assert.deepEqual(f.slack.posts, [{ channel: 'C1', text: '大丈夫です。明日の 10 時に始めましょう。', threadTs: PARENT,
    iconUrl: `${ORIGIN}/avatar/happy.png` }]);
  assert.equal(f.clientEvents.length, 0, 'nothing waits for the owner');
  const [line] = f.lines();
  assert.equal(line!.type, 'agent_reply');
  assert.equal(line!.agent, 'poppo');
  assert.equal(line!.result, 'sent');
  assert.equal(line!.reply_to, 'work/#dev 2026-09-25 14:32:05 山田');
  assertNoIds(line!);
  const row = f.db.prepare('SELECT verdict, placement, sent_text, scores, state FROM dove_posts').get() as Record<string, string>;
  assert.equal(row.verdict, 'send');
  assert.equal(row.placement, 'thread');
  assert.equal(row.state, 'sent');
  assert.equal(row.sent_text, '大丈夫です。明日の 10 時に始めましょう。');
  assert.equal(JSON.parse(row.scores!).length, JUDGE_ISSUES.length, 'the scores are kept for looking back');
});

test('Jev sees the draft and the message it answers, and nothing natsumi said about it', async t => {
  const f = await setup(t);
  f.jev.answers.push(SEND());
  await f.dove.ask(post('大丈夫です。'));
  await f.dove.idle();
  const [{ state, placement }] = f.jev.asked as [{ state: Record<string, any>; placement: boolean }];
  assert.equal(placement, true);
  assert.equal(state.draft, '大丈夫です。');
  assert.equal(state.channel, 'work/#dev');
  assert.deepEqual(state.reply_to, { from: '山田', at: '2026-09-25 14:32:05', text: '明日のレビュー、大丈夫そう？' });
  assert.deepEqual(state.conversation, [{ from: '山田', at: '2026-09-25 14:32:05', text: '明日のレビュー、大丈夫そう？' }]);
  assert.deepEqual(Object.keys(state).sort(), ['channel', 'conversation', 'draft', 'reply_to']);
});

test('without a feeling the icon is neutral, and Jev choosing the channel posts outside the thread', async t => {
  const f = await setup(t);
  f.jev.answers.push(scores([], 'channel'));
  await f.dove.ask(post('大丈夫です。'));
  await f.dove.idle();
  assert.deepEqual(f.slack.posts, [{ channel: 'C1', text: '大丈夫です。', iconUrl: `${ORIGIN}/avatar/neutral.png` }]);
});

test('a post to the channel itself goes to the channel, and Jev is not asked where', async t => {
  const f = await setup(t);
  f.jev.answers.push(SEND());
  await f.dove.ask(post('おはようございます。', { to: 'work/#dev' }));
  await f.dove.idle();
  assert.equal(f.jev.asked[0]!.placement, false);
  assert.equal(f.jev.asked[0]!.state.reply_to, null);
  assert.deepEqual(f.slack.posts, [{ channel: 'C1', text: 'おはようございます。', iconUrl: `${ORIGIN}/avatar/neutral.png` }]);
});

test('a reply to a message in a thread stays in the thread, and Jev is not asked where', async t => {
  const f = await setup(t);
  await f.archive.record('work', 'C1', { ts: tsAt('2026-09-25T05:40:10Z'), threadTs: PARENT, speaker: '佐藤', own: false, text: '続きです', files: [], edited: false });
  f.jev.answers.push(SEND());
  await f.dove.ask(post('了解です。', { to: 'work/#dev 2026-09-25 14:40:10 佐藤' }));
  await f.dove.idle();
  assert.equal(f.jev.asked[0]!.placement, false);
  assert.deepEqual(f.slack.posts, [{ channel: 'C1', text: '了解です。', threadTs: PARENT, iconUrl: `${ORIGIN}/avatar/neutral.png` }]);
});

test('a draft Jev hands to the owner waits for her approval, and the approval carries what the contract says', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER());
  await f.dove.ask(post('大丈夫です。', { expression: 'thinking' }));
  await f.dove.idle();
  assert.equal(f.slack.posts.length, 0, 'nothing is sent before the owner decides');
  const [line] = f.lines();
  assert.equal(line!.result, 'to_owner');
  assert.match(String(line!.text), new RegExp(JUDGE_ISSUES[1]!.label));
  assertNoIds(line!);
  assert.equal(f.clientEvents.length, 1);
  const { type, payload } = f.clientEvents[0]!;
  assert.equal(type, 'approval.pending');
  assert.match(payload.approvalId, /./);
  assert.equal(payload.revision, 1);
  assert.equal(payload.kind, 'slack-post');
  assert.equal(payload.createdAt, '2026-09-25T06:00:00.000Z');
  assert.equal(payload.expiresAt, '2026-10-02T06:00:00.000Z');
  assert.deepEqual(payload.target, { channel: 'work/#dev', placement: 'thread',
    replyTo: { speaker: '山田', at: '2026-09-25 14:32:05', text: '明日のレビュー、大丈夫そう？' } });
  assert.equal(payload.text, '大丈夫です。');
  assert.equal(payload.expression, 'thinking');
  assert.equal(payload.reason.verdict, 'owner');
  assert.equal(payload.reason.issues.length, JUDGE_ISSUES.length);
  assert.deepEqual(payload.reason.issues[1], { name: JUDGE_ISSUES[1]!.name, label: JUDGE_ISSUES[1]!.label, score: 0.5, flagged: true });
  assert.equal(payload.reason.issues[0].flagged, undefined);
  assert.deepEqual(payload.reason.placement, { probabilities: { thread: 0.8, channel: 0.2 } });
  assert.deepEqual(payload.history, []);
  assert.deepEqual(f.dove.pendingApprovals(), [payload]);
});

test('with no verdict the draft goes to the owner, and the server places it: the channel when little came after', async t => {
  const f = await setup(t);
  f.jev.answers.push(new JudgeError('http-529'));
  await f.dove.ask(post('大丈夫です。'));
  await f.dove.idle();
  assert.equal(f.slack.posts.length, 0);
  const approval = f.clientEvents[0]!.payload;
  assert.equal(approval.reason.verdict, 'no-verdict');
  assert.deepEqual(approval.reason.issues, []);
  assert.equal(approval.reason.placement, undefined);
  assert.equal(approval.target.placement, 'channel');
  assert.equal(f.lines()[0]!.result, 'to_owner');
  assert.ok(f.logs.some(line => line.includes('http-529')));
});

test('with no verdict and more than a few messages after it, the server places the reply in the thread', async t => {
  const f = await setup(t, { jev: false });
  for (const [index, second] of ['10', '20', '30'].entries()) {
    await f.archive.record('work', 'C1', { ts: tsAt(`2026-09-25T05:33:${second}Z`), speaker: '佐藤', own: false, text: `別の話 ${index}`, files: [], edited: false });
  }
  await f.dove.ask(post('大丈夫です。'));
  await f.dove.idle();
  assert.equal(f.clientEvents[0]!.payload.target.placement, 'thread');
  assert.equal(f.clientEvents[0]!.payload.reason.verdict, 'no-verdict');
});

test('a returned draft comes back with its reasons; the third return on the same target goes to the owner with the history', async t => {
  const f = await setup(t);
  f.jev.answers.push(RETURN(), RETURN(), RETURN());
  await f.dove.ask(post('下書き 1'));
  await f.dove.idle();
  await f.dove.ask(post('下書き 2'));
  await f.dove.idle();
  const [first, second] = f.lines();
  assert.equal(first!.result, 'returned');
  assert.match(String(first!.text), new RegExp(JUDGE_ISSUES[0]!.label));
  assert.match(String(first!.text), /あと 1 回/);
  assert.equal(second!.result, 'returned');
  assert.equal(f.clientEvents.length, 0);
  await f.dove.ask(post('下書き 3'));
  await f.dove.idle();
  assert.equal(f.slack.posts.length, 0);
  const approval = f.clientEvents[0]!.payload;
  assert.equal(approval.reason.verdict, 'rewrite-limit');
  assert.equal(approval.text, '下書き 3');
  assert.deepEqual(approval.history.map((entry: { text: string }) => entry.text), ['下書き 1', '下書き 2']);
  assert.deepEqual(approval.history[0].issues.map((issue: { name: string }) => issue.name), [JUDGE_ISSUES[0]!.name]);
  assert.equal(approval.history[0].issues[0].flagged, true);
  assert.equal(f.lines()[2]!.result, 'to_owner');
});

test('a send in between starts the count of rewrites again', async t => {
  const f = await setup(t);
  f.jev.answers.push(RETURN(), RETURN(), SEND(), RETURN());
  for (const body of ['a', 'b', 'c', 'd']) {
    await f.dove.ask(post(`下書き ${body}`));
    await f.dove.idle();
  }
  assert.deepEqual(f.lines().map(line => line.result), ['returned', 'returned', 'sent', 'returned']);
});

test('the mechanical check turns a draft back before anything is judged', async t => {
  const f = await setup(t);
  const outcome = await f.dove.ask(post('大丈夫です。</think>'));
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /^頼んでいません。/);
  assert.match(outcome.text, /制御文字列/);
  await f.dove.idle();
  assert.equal(f.jev.asked.length, 0);
  assert.equal(f.events.length, 0);
});

test('a reference the record does not have, or an unknown workspace or channel, is turned back', async t => {
  const f = await setup(t);
  for (const [to, pattern] of [
    ['work/#dev 2026-09-25 14:32:06 山田', /見つかりません/],
    ['home/#dev', /ワークスペース/],
    ['work/#random', /チャンネル/],
  ] as const) {
    const outcome = await f.dove.ask(post('大丈夫です。', { to }));
    assert.equal(outcome.ok, false, to);
    assert.match(outcome.text, pattern);
  }
  assert.equal(f.jev.asked.length, 0);
});

test('two messages of the same second by the same speaker are turned back with how each begins, and no ts', async t => {
  const f = await setup(t);
  await f.archive.record('work', 'C1', { ts: tsAt('2026-09-25T05:32:05Z', '000200'), speaker: '山田', own: false, text: 'もう一つの発言です', files: [], edited: false });
  const outcome = await f.dove.ask(post('大丈夫です。'));
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /明日のレビュー、大丈夫そう？/);
  assert.match(outcome.text, /もう一つの発言です/);
  assert.doesNotMatch(outcome.text, /\d{10}\.\d{6}/);
  assert.match(outcome.text, /書き出し/);
  f.jev.answers.push(SEND());
  assert.equal((await f.dove.ask(post('そちらへの返事', { to: 'work/#dev 2026-09-25 14:32:05 山田 「もう一つ」' }))).ok, true);
  await f.dove.idle();
  assert.deepEqual(f.slack.posts.map(sent => sent.threadTs), [tsAt('2026-09-25T05:32:05Z', '000200')]);
});

test('approving sends exactly the approved text, once, and tells the devices and natsumi', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER());
  await f.dove.ask(post('承認を待つ下書き', { expression: 'sad' }));
  await f.dove.idle();
  const { approvalId } = f.clientEvents[0]!.payload;
  const accepted = f.dove.decide({ approvalId, revision: 1, decision: 'approve', deviceId: 'd1' });
  assert.deepEqual(accepted, { kind: 'accepted', approvalId, revision: 1, state: 'approved' });
  await f.dove.idle();
  assert.deepEqual(f.slack.posts, [{ channel: 'C1', text: '承認を待つ下書き', threadTs: PARENT, iconUrl: `${ORIGIN}/avatar/sad.png` }]);
  const resolved = f.clientEvents.find(event => event.type === 'approval.resolved')!.payload;
  assert.deepEqual({ ...resolved, resolvedAt: undefined }, { approvalId, revision: 1, state: 'approved', resolvedAt: undefined,
    delivery: 'sent', sentText: '承認を待つ下書き' });
  const last = f.lines().at(-1)!;
  assert.equal(last.result, 'sent');
  assert.match(String(last.text), /本人/);
  // The same answer again, from another device: the first decision stands and nothing is sent twice.
  assert.deepEqual(f.dove.decide({ approvalId, revision: 1, decision: 'reject', deviceId: 'd2' }),
    { kind: 'accepted', approvalId, revision: 1, state: 'approved' });
  await f.dove.idle();
  assert.equal(f.slack.posts.length, 1);
  assert.deepEqual(f.dove.pendingApprovals(), []);
  assert.equal(f.jev.asked.length, 1, 'the owner\'s approval is not judged again');
});

test('a wrong revision is stale, an unknown approval is invalid, and neither sends', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER());
  await f.dove.ask(post('下書き'));
  await f.dove.idle();
  const { approvalId } = f.clientEvents[0]!.payload;
  assert.deepEqual(f.dove.decide({ approvalId, revision: 2, decision: 'approve', deviceId: 'd1' }), { kind: 'rejected', code: 'stale-revision' });
  assert.deepEqual(f.dove.decide({ approvalId: 'approval-unknown', revision: 1, decision: 'approve', deviceId: 'd1' }),
    { kind: 'rejected', code: 'invalid-request' });
  await f.dove.idle();
  assert.equal(f.slack.posts.length, 0);
  assert.equal(f.dove.pendingApprovals().length, 1);
});

test('an edit sends the owner\'s text where she chose, without asking Jev again', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER());
  await f.dove.ask(post('元の下書き'));
  await f.dove.idle();
  const { approvalId } = f.clientEvents[0]!.payload;
  assert.equal(f.dove.decide({ approvalId, revision: 1, decision: 'edit', text: '本人が直した本文', placement: 'channel', deviceId: 'd1' }).kind, 'accepted');
  await f.dove.idle();
  assert.deepEqual(f.slack.posts, [{ channel: 'C1', text: '本人が直した本文', iconUrl: `${ORIGIN}/avatar/neutral.png` }]);
  const resolved = f.clientEvents.find(event => event.type === 'approval.resolved')!.payload;
  assert.equal(resolved.state, 'edited');
  assert.equal(resolved.sentText, '本人が直した本文');
  assert.equal(f.jev.asked.length, 1);
  assert.match(String(f.lines().at(-1)!.text), /本人が直した本文/);
  const row = f.db.prepare('SELECT decision, decided_text, decided_placement FROM approvals').get() as Record<string, string>;
  assert.deepEqual({ ...row }, { decision: 'edit', decided_text: '本人が直した本文', decided_placement: 'channel' });
});

test('an edited text that fails the mechanical check is not sent', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER());
  await f.dove.ask(post('元の下書き'));
  await f.dove.idle();
  const { approvalId } = f.clientEvents[0]!.payload;
  f.dove.decide({ approvalId, revision: 1, decision: 'edit', text: '直した<|im_end|>', deviceId: 'd1' });
  await f.dove.idle();
  assert.equal(f.slack.posts.length, 0);
  const resolved = f.clientEvents.find(event => event.type === 'approval.resolved')!.payload;
  assert.equal(resolved.delivery, 'failed');
  assert.equal(resolved.reason, 'mechanical-check');
  assert.equal(resolved.sentText, undefined);
  assert.equal(f.lines().at(-1)!.result, 'not_sent');
});

test('an edit to blank text is invalid', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER());
  await f.dove.ask(post('元の下書き'));
  await f.dove.idle();
  const { approvalId } = f.clientEvents[0]!.payload;
  assert.deepEqual(f.dove.decide({ approvalId, revision: 1, decision: 'edit', text: '  ', deviceId: 'd1' }), { kind: 'rejected', code: 'invalid-request' });
});

test('rejecting sends nothing and tells natsumi', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER());
  await f.dove.ask(post('下書き'));
  await f.dove.idle();
  const { approvalId } = f.clientEvents[0]!.payload;
  assert.equal(f.dove.decide({ approvalId, revision: 1, decision: 'reject', deviceId: 'd1' }).kind, 'accepted');
  await f.dove.idle();
  assert.equal(f.slack.posts.length, 0);
  const resolved = f.clientEvents.find(event => event.type === 'approval.resolved')!.payload;
  assert.equal(resolved.state, 'rejected');
  assert.equal(resolved.delivery, undefined);
  assert.equal(f.lines().at(-1)!.result, 'rejected');
});

test('an approval past its time expires, tells everyone, and is answered as expired', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER());
  await f.dove.ask(post('下書き'));
  await f.dove.idle();
  const { approvalId } = f.clientEvents[0]!.payload;
  f.clock.now += 7 * DAY - 1;
  f.dove.expire();
  assert.equal(f.dove.pendingApprovals().length, 1);
  f.clock.now += 1;
  f.dove.expire();
  assert.deepEqual(f.dove.pendingApprovals(), []);
  const resolved = f.clientEvents.find(event => event.type === 'approval.resolved')!.payload;
  assert.equal(resolved.state, 'expired');
  assert.equal(f.lines().at(-1)!.result, 'expired');
  assert.deepEqual(f.dove.decide({ approvalId, revision: 1, decision: 'approve', deviceId: 'd1' }),
    { kind: 'accepted', approvalId, revision: 1, state: 'expired' });
  await f.dove.idle();
  assert.equal(f.slack.posts.length, 0);
});

test('a decision that comes after the time is up expires the approval rather than sending', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER());
  await f.dove.ask(post('下書き'));
  await f.dove.idle();
  const { approvalId } = f.clientEvents[0]!.payload;
  f.clock.now += 8 * DAY;
  assert.equal((f.dove.decide({ approvalId, revision: 1, decision: 'approve', deviceId: 'd1' }) as { state: string }).state, 'expired');
  await f.dove.idle();
  assert.equal(f.slack.posts.length, 0);
});

const reaction = (name: string) => `返信先: work/#dev 2026-09-25 14:32:05 山田\n種類: リアクション\n---\n${name}`;

test('a standard emoji is put on at once, with neither Jev nor the owner', async t => {
  const f = await setup(t);
  const outcome = await f.dove.ask(reaction(':+1:'));
  assert.equal(outcome.ok, true);
  await f.dove.idle();
  assert.deepEqual(f.slack.reactions, [{ channel: 'C1', ts: PARENT, name: '+1' }]);
  assert.equal(f.jev.asked.length, 0);
  assert.equal(f.clientEvents.length, 0);
  const [reacted] = f.lines();
  assert.equal(reacted!.result, 'reacted');
  assertNoIds(reacted!);
});

test('any emoji that exists may be asked for: a standard one, one with a skin tone, a custom one and an alias (ADR 0042)', async t => {
  const f = await setup(t);
  f.slack.emoji.set('lgtm', 'https://emoji.example.test/lgtm.png');
  f.slack.emoji.set('了解', 'https://emoji.example.test/ryokai.png');
  f.slack.emoji.set('thanks', 'alias:pray');
  for (const name of ['fire', ':thumbsup::skin-tone-3:', 'lgtm', ':了解:', 'thanks']) {
    assert.equal((await f.dove.ask(reaction(name))).ok, true, name);
  }
  await f.dove.idle();
  assert.deepEqual(f.slack.reactions.map(({ name }) => name), ['fire', 'thumbsup::skin-tone-3', 'lgtm', '了解', 'thanks']);
  assert.equal(f.jev.asked.length, 0);
  assert.equal(f.clientEvents.length, 0);
});

test('an emoji that is nowhere is refused at once, and the refusal says how to find one', async t => {
  const f = await setup(t);
  const outcome = await f.dove.ask(reaction('no_such_emoji'));
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /no_such_emoji/);
  assert.match(outcome.text, /\/manual\/slack\.md/);
  await f.dove.idle();
  assert.deepEqual(f.slack.reactions, []);
  assert.equal(f.lines().length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dove_posts').get()!.n, 0);
});

test('without emoji:read, a standard emoji is still put on and a custom one is refused, with one line in the log', async t => {
  const f = await setup(t);
  f.slack.emoji.set('lgtm', 'https://emoji.example.test/lgtm.png');
  f.slack.fail('customEmoji', '', 'emoji.list', 'missing_scope', 'emoji:read');
  assert.equal((await f.dove.ask(reaction('lgtm'))).ok, false);
  assert.equal((await f.dove.ask(reaction('eyes'))).ok, true);
  await f.dove.idle();
  assert.deepEqual(f.slack.reactions.map(({ name }) => name), ['eyes']);
  assert.deepEqual(f.logs.filter(line => line.includes('emoji')),
    ['slack (work): the custom emoji could not be read (emoji.list: missing_scope, needed emoji:read)']);
});

test('Slack refusing the post, or the message having been deleted, is told to natsumi as not sent', async t => {
  const f = await setup(t);
  f.jev.answers.push(SEND(), SEND());
  f.slack.fail('postMessage', 'C1', 'chat.postMessage', 'ratelimited');
  await f.dove.ask(post('一通目'));
  await f.dove.idle();
  assert.equal(f.lines()[0]!.result, 'not_sent');
  assert.ok(f.logs.some(line => line.includes('chat.postMessage: ratelimited')));
  assert.ok(!f.logs.some(line => line.includes('一通目')), 'no text in the log');
  f.slack.failures.clear();
  await f.dove.ask(post('二通目'));
  await f.archive.remove('work', 'C1', PARENT);
  await f.dove.idle();
  assert.equal(f.slack.posts.length, 0);
  assert.equal(f.lines()[1]!.result, 'not_sent');
  const rows = f.db.prepare('SELECT state, failure FROM dove_posts ORDER BY created_at, rowid').all().map(row => ({ ...row }));
  assert.deepEqual(rows, [{ state: 'failed', failure: 'slack-error' }, { state: 'failed', failure: 'target-gone' }]);
});

test('after a restart, a draft still being judged is judged, and one caught mid-send is never sent twice', async t => {
  const f = await setup(t);
  f.jev.answers.push(SEND());
  f.db.prepare(`INSERT INTO dove_posts (post_id, kind, workspace, channel_id, target_ts, target_thread_ts, reference, text,
    expression, state, created_at, updated_at) VALUES ('post-a', 'post', 'work', 'C1', ?, NULL, 'work/#dev 2026-09-25 14:32:05 山田',
    '判定中だった下書き', NULL, 'judging', '2026-09-25T05:59:00.000Z', '2026-09-25T05:59:00.000Z'),
    ('post-b', 'post', 'work', 'C1', ?, NULL, 'work/#dev 2026-09-25 14:32:05 山田', '送信中だった下書き', NULL, 'sending',
    '2026-09-25T05:59:01.000Z', '2026-09-25T05:59:01.000Z')`).run(PARENT, PARENT);
  f.dove.resume();
  await f.dove.idle();
  assert.deepEqual(f.slack.posts.map(sent => sent.text), ['判定中だった下書き']);
  assert.deepEqual(f.lines().map(line => line.result).sort(), ['not_sent', 'sent']);
});

test('an event line is handed over once: its text is emptied from the record after', async t => {
  const f = await setup(t);
  f.jev.answers.push(RETURN());
  await f.dove.ask(post('下書き'));
  await f.dove.idle();
  const line = f.dove.takeEventLine(f.events[0]!, '2026-09-25T06:00:00.000Z');
  assert.match(String(line.text), /./);
  const row = f.db.prepare('SELECT text FROM dove_replies').get() as { text: string };
  assert.equal(row.text, '');
});

// ADR 0044: images named under `画像:`, taken and copied at once, sent with files.uploadV2's three calls.
const withImages = (body: string, images: string[], to = 'work/#dev 2026-09-25 14:32:05 山田') =>
  `返信先: ${to}\n種類: 投稿\n${images.map(image => `画像: ${image}\n`).join('')}---\n${body}`;

test('images alone are sent at once, with neither Jev nor the owner, placed by the server\'s rule', async t => {
  const f = await setup(t);
  const outcome = await f.dove.ask(withImages('', ['/work/images/cat.png']));
  assert.equal(outcome.ok, true);
  assert.match(outcome.text, /画像/);
  await f.dove.idle();
  assert.equal(f.jev.asked.length, 0, 'Jev is not asked about images');
  assert.equal(f.clientEvents.length, 0, 'nothing waits for the owner');
  assert.equal(f.slack.posts.length, 0);
  // A top-level message with nothing after it: the reply goes to the channel, as without a verdict.
  assert.deepEqual(f.slack.uploads, [{ channel: 'C1', files: [{ filename: 'cat.png', data: PNG }] }]);
  const [line] = f.lines();
  assert.equal(line!.result, 'sent');
  assert.deepEqual(line!.images, ['/work/images/cat.png']);
  assert.equal(line!.draft, undefined, 'no draft to show');
  assertNoIds(line!);
  const row = f.db.prepare('SELECT verdict, state, placement, text FROM dove_posts').get() as Record<string, string | null>;
  assert.deepEqual({ ...row }, { verdict: null, state: 'sent', placement: 'channel', text: '' });
});

test('images alone into a thread go to the thread, as the server\'s rule has it for a reply in one', async t => {
  const f = await setup(t);
  const reply = tsAt('2026-09-25T05:40:10Z');
  await f.archive.record('work', 'C1', { ts: reply, threadTs: PARENT, speaker: '佐藤', own: false, text: '絵をお願い', files: [], edited: false });
  await f.dove.ask(withImages('', ['/work/images/cat.png'], 'work/#dev 2026-09-25 14:40:10 佐藤'));
  await f.dove.idle();
  assert.deepEqual(f.slack.uploads, [{ channel: 'C1', files: [{ filename: 'cat.png', data: PNG }], threadTs: PARENT }]);
});

test('with a body, only the body is judged, and a pass sends the images with the body as their comment', async t => {
  const f = await setup(t);
  f.jev.answers.push(SEND());
  await f.dove.ask(withImages('描いてみました。', ['/work/images/cat.png']));
  await f.dove.idle();
  assert.equal(f.jev.asked.length, 1);
  assert.equal(f.jev.asked[0]!.state.draft, '描いてみました。');
  assert.doesNotMatch(JSON.stringify(f.jev.asked[0]!.state), /cat\.png|\/work\//, 'Jev is shown nothing of the images');
  assert.deepEqual(f.slack.uploads, [{ channel: 'C1', files: [{ filename: 'cat.png', data: PNG }], threadTs: PARENT,
    initialComment: '描いてみました。' }]);
  assert.equal(f.slack.posts.length, 0);
  const [line] = f.lines();
  assert.equal(line!.result, 'sent');
  assert.equal(line!.draft, '描いてみました。');
  assert.deepEqual(line!.images, ['/work/images/cat.png']);
});

test('a body the judge hands to the owner takes its images to the approval, and what is sent is the copy', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER());
  await f.dove.ask(withImages('描いてみました。', ['/work/images/cat.png']));
  await f.dove.idle();
  const [pending] = f.clientEvents;
  assert.equal(pending!.type, 'approval.pending');
  const images = pending!.payload.images as { imageId: string; mimeType: string; bytes: number }[];
  assert.equal(images.length, 1);
  assert.deepEqual(Object.keys(images[0]!).sort(), ['bytes', 'imageId', 'mimeType']);
  assert.equal(images[0]!.mimeType, 'image/png');
  assert.equal(images[0]!.bytes, PNG.length);
  assert.doesNotMatch(JSON.stringify(pending!.payload), /\/work\/|cat\.png/, 'the owner is shown the image, not where it was');
  assert.deepEqual(f.dove.pendingApprovals(), [pending!.payload]);

  assert.deepEqual(await f.images.read(images[0]!.imageId), { mimeType: 'image/png', data: PNG });

  // She draws over the file after asking: the owner approved the copy, and the copy is what goes.
  await writeFile(join(f.work, 'images', 'cat.png'), Buffer.concat([PNG, Buffer.from('redrawn')]));
  f.dove.decide({ approvalId: pending!.payload.approvalId, revision: 1, decision: 'approve', deviceId: 'd1' });
  await f.dove.idle();
  assert.deepEqual(f.slack.uploads, [{ channel: 'C1', files: [{ filename: 'cat.png', data: PNG }], threadTs: PARENT,
    initialComment: '描いてみました。' }]);
});

test('an approval lists only its own images, and one without images has no field for them', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER(), OWNER());
  await f.dove.ask(withImages('一枚目', ['/work/images/cat.png']));
  await f.dove.ask(post('画像なし'));
  await f.dove.idle();
  const [withImage, without] = f.clientEvents.map(event => event.payload);
  assert.equal(without!.images, undefined);
  const listed = (withImage!.images as { imageId: string }[]).map(image => image.imageId);
  const recorded = (f.db.prepare('SELECT image_id FROM dove_post_images ORDER BY rowid').all() as { image_id: string }[]).map(row => row.image_id);
  assert.deepEqual(listed, recorded);
});

test('what is sent and where is recorded: the copy\'s path, its size and its type, in the place she named it', async t => {
  const f = await setup(t);
  await f.dove.ask(withImages('', ['/work/images/cat.png']));
  await f.dove.idle();
  const rows = f.db.prepare(`SELECT p.position, i.source, i.file, i.mime_type, i.bytes, i.sha256 FROM dove_post_images p
    JOIN images i ON i.image_id = p.image_id`).all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.position, 0);
  assert.equal(rows[0]!.source, '/work/images/cat.png');
  assert.equal(rows[0]!.mime_type, 'image/png');
  assert.equal(rows[0]!.bytes, PNG.length);
  assert.match(String(rows[0]!.sha256), /^[0-9a-f]{64}$/);
  assert.deepEqual(await readFile(join(f.root, 'images', String(rows[0]!.file))), PNG);
});

for (const [name, images, pattern] of [
  ['an image outside /work', ['/sources/slack/work/dev/files/a.png'], /\/work/],
  ['an image that is not there', ['/work/images/none.png'], /見つかりません/],
  ['more images than the limit', ['/work/images/cat.png', '/work/images/cat.png', '/work/images/cat.png'], /2 枚まで/],
] as const) {
  test(`${name} is refused at once, and nothing is asked or recorded`, async t => {
    const f = await setup(t);
    const outcome = await f.dove.ask(withImages('描きました', [...images]));
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /^頼んでいません。/);
    assert.match(outcome.text, pattern);
    await f.dove.idle();
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM dove_posts').get() as { n: number }).n, 0);
    assert.equal(f.jev.asked.length, 0);
    assert.equal(f.slack.uploads.length, 0);
  });
}

test('an image too large is refused at once with the limit', async t => {
  const f = await setup(t);
  await writeFile(join(f.work, 'images', 'large.png'), Buffer.concat([PNG, Buffer.alloc(2048)]));
  const outcome = await f.dove.ask(withImages('', ['/work/images/large.png']));
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /大きすぎ/);
});

test('Slack refusing the upload is told to natsumi as not sent', async t => {
  const f = await setup(t);
  f.slack.fail('uploadFiles', 'C1', 'files.completeUploadExternal', 'ratelimited');
  await f.dove.ask(withImages('', ['/work/images/cat.png']));
  await f.dove.idle();
  const [line] = f.lines();
  assert.equal(line!.result, 'not_sent');
  assert.match(String(line!.text), /Slack に断られた/);
  assert.ok(f.logs.some(line => line.includes('files.completeUploadExternal: ratelimited')));
});

// ADR 0044: the devices are given only the images of an approval, never those that went out without one.
test('only the images of an approval are shown to the devices', async t => {
  const f = await setup(t);
  f.jev.answers.push(OWNER());
  await f.dove.ask(withImages('見てください', ['/work/images/cat.png']));
  await f.dove.ask(withImages('', ['/work/images/cat.png']));
  await f.dove.idle();
  const approved = (f.clientEvents[0]!.payload.images as { imageId: string }[])[0]!.imageId;
  const alone = (f.db.prepare(`SELECT p.image_id FROM dove_post_images p JOIN dove_posts d ON d.post_id = p.post_id
    WHERE d.text = ''`).get() as { image_id: string }).image_id;
  assert.equal(f.dove.showsImage(approved), true);
  assert.equal(f.dove.showsImage(alone), false);
  assert.equal(f.dove.showsImage('image-unknown'), false);
});
