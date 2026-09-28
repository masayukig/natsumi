import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SlackDove } from '../src/server/dove.ts';
import { ImageStore } from '../src/server/images.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SlackApprovals } from '../src/server/slack-approvals.ts';
import { SlackArchive } from '../src/server/slack-archive.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { FakeSlack, tsAt } from './support/fake-slack.ts';

/**
 * Fork (ADR 0057): the owner approves the dove's drafts with two buttons in their DM with the bot. A press goes to the
 * dove's own `decide`, and the message is rewritten to what came of it.
 */

const PARENT = tsAt('2026-09-25T05:32:05Z');
const DAY = 86_400_000;

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-slack-approvals-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const clock = { now: Date.parse('2026-09-25T06:00:00Z') };
  const archive = new SlackArchive({ db, directory: join(root, 'slack'), timeZone: 'Asia/Tokyo', now: () => clock.now });
  archive.addChannel('work', 'C1', { name: 'dev', isIm: false });
  await archive.record('work', 'C1', { ts: PARENT, speaker: '山田', own: false, text: '明日 <大丈夫> & OK？', files: [], edited: false });
  const slack = new FakeSlack();
  const logs: string[] = [];
  // No judge: every draft goes to the owner.
  const dove = new SlackDove({
    db, archive, workspaces: { work: slack }, publicOrigin: 'https://natsumi.example.test', workDirectory: join(root, 'work'),
    images: new ImageStore(db, join(root, 'images')), now: () => clock.now, log: line => { logs.push(line); }, raise: () => {},
    config: { thresholds: { owner: 0.3, return: 0.7 }, approvalDays: 7, placementFollowing: 2, judgeContext: { messages: 5, chars: 500 },
      images: { maxBytes: 1024, maxCount: 2 } },
  });
  const approvals = new SlackApprovals({ db, dove, api: slack, socket: slack, workspace: 'work', ownerUserId: 'U1', log: line => { logs.push(line); } });
  t.after(async () => {
    approvals.stop();
    dove.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const draft = async (body = '大丈夫です <b> & 了解') => {
    await dove.ask(`返信先: work/#dev 2026-09-25 14:32:05 山田\n種類: 投稿\n---\n${body}`);
    await dove.idle();
    await approvals.idle();
    return dove.pendingApprovals().at(-1)!.approvalId;
  };
  const press = async (approvalId: string, action: 'approve' | 'reject', user = 'U1', index = 0) => {
    slack.interact({ type: 'block_actions', user: { id: user }, container: { message_ts: `${1_900_000_001 + index}.000100` },
      actions: [{ action_id: `fork-approval-${action}`, value: approvalId }] });
    await dove.idle();
    await approvals.idle();
  };
  return { db, clock, slack, dove, approvals, logs, draft, press };
}

const buttons = (blocks: unknown[]) => (blocks as { type: string; elements?: { action_id?: string; value?: string }[] }[])
  .filter(block => block.type === 'actions').flatMap(block => block.elements!);
const said = (blocks: unknown[]) => JSON.stringify(blocks.at(-1));

test('a draft handed to the owner is posted once in their DM, with the draft as plain text and two buttons carrying its ID', async t => {
  const f = await setup(t);
  const id = await f.draft();
  f.approvals.sync();
  await f.approvals.idle();
  assert.equal(f.slack.blockPosts.length, 1, 'once, however often it is looked at');
  const [posted] = f.slack.blockPosts;
  assert.equal(posted!.channel, 'D-U1');
  assert.doesNotMatch(posted!.text, /[<>]/);
  assert.deepEqual(buttons(posted!.blocks).map(button => [button.action_id, button.value]),
    [['fork-approval-approve', id], ['fork-approval-reject', id]]);
  const shown = JSON.stringify(posted!.blocks);
  assert.match(shown, /"type":"plain_text","text":"大丈夫です <b> & 了解"/);
  assert.match(shown, /返信先: 山田（2026-09-25 14:32:05）「明日 <大丈夫> & OK？」/);
  assert.match(shown, /判定できなかった/);
  assert.match(shown, /<!date\^\d+\^/);
});

test('the owner pressing 送る sends it by the dove\'s own decision, and the message says it was sent, without buttons', async t => {
  const f = await setup(t);
  const id = await f.draft();
  await f.press(id, 'approve');
  assert.deepEqual(f.slack.posts.map(post => post.text), ['大丈夫です <b> & 了解']);
  assert.equal((f.db.prepare('SELECT device_id FROM approvals').get() as { device_id: string }).device_id, 'slack');
  const last = f.slack.updates.at(-1)!;
  assert.equal(last.ts, '1900000001.000100');
  assert.deepEqual(buttons(last.blocks), []);
  assert.match(said(last.blocks), /→ 送った/);
});

test('見送る rejects it, and a press on an approval already closed only rewrites the message', async t => {
  const f = await setup(t);
  const id = await f.draft();
  f.dove.decide({ approvalId: id, revision: 1, decision: 'reject', deviceId: 'iphone' });
  await f.approvals.idle();
  assert.match(said(f.slack.updates.at(-1)!.blocks), /→ 見送った/);
  const updates = f.slack.updates.length;
  await f.press(id, 'approve');
  assert.equal(f.slack.posts.length, 0);
  assert.equal(f.slack.updates.length, updates, 'already said');
});

test('a press by anyone but the owner does nothing', async t => {
  const f = await setup(t);
  const id = await f.draft();
  await f.press(id, 'approve', 'U2');
  assert.equal(f.dove.pendingApprovals().length, 1);
  assert.equal(f.slack.posts.length, 0);
  assert.equal(f.slack.updates.length, 0);
  assert.deepEqual(f.logs, ['slack (work): an approval button was pressed by someone other than the owner; ignored']);
});

test('an approval that runs out of time has its message rewritten', async t => {
  const f = await setup(t);
  await f.draft();
  f.clock.now += 8 * DAY;
  f.dove.expire();
  await f.approvals.idle();
  assert.deepEqual(buttons(f.slack.updates.at(-1)!.blocks), []);
  assert.match(said(f.slack.updates.at(-1)!.blocks), /→ 期限切れ/);
});

test('an approval that ran out while the server was stopped is caught up at the start', async t => {
  const f = await setup(t);
  await f.draft();
  f.clock.now += 8 * DAY;
  f.approvals.stop(); // As if the server were stopped: nothing hears the expiry.
  f.dove.expire();
  assert.equal(f.slack.updates.length, 0);
  const again = new SlackApprovals({ db: f.db, dove: f.dove, api: f.slack, socket: f.slack, workspace: 'work', ownerUserId: 'U1' });
  t.after(() => { again.stop(); });
  again.sync();
  await again.idle();
  assert.match(said(f.slack.updates.at(-1)!.blocks), /→ 期限切れ/);
  assert.equal(f.slack.blockPosts.length, 1);
});
