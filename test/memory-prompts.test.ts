import assert from 'node:assert/strict';
import test from 'node:test';
import { curatorSystemPrompt, REFLECTION_REQUEST, REVIEW_INSTRUCTIONS, workspaceSection } from '../src/server/prompts.ts';

// ADR 0055: how natsumi writes memory during the day, how she finds it, and what her night no longer does.

test('the day writes a topic as it stands now, and the story of the day into the diary', () => {
  assert.match(workspaceSection(), /今どうなっているか/);
  assert.match(workspaceSection(), /節を書き足さずに/);
  assert.match(workspaceSection(), /\/memory\/diary\//);
});

test('memory is found through INDEX.md first, and through search_memory for a word', () => {
  assert.match(workspaceSection(), /まず \/memory\/INDEX\.md/);
  assert.match(workspaceSection(), /search_memory/);
  // The old way in, rg through run_shell, is no longer what she is told to reach for first.
  assert.doesNotMatch(workspaceSection(), /run_shell の rg/);
  // INDEX.md is the curator's; she is told she cannot change it rather than finding out from a revert.
  assert.match(workspaceSection(), /INDEX\.md はあなたには書き換えられません/);
});

test('the night no longer offers to rebuild memory: that is the curator\'s, and it says so', () => {
  assert.doesNotMatch(REVIEW_INSTRUCTIONS, /トピックをまとめる/);
  assert.doesNotMatch(REVIEW_INSTRUCTIONS, /記憶全体を読み直し/);
  assert.match(REVIEW_INSTRUCTIONS, /記憶の整理係/);
  // What stays hers: the handoff first, then the menu of what else is worth doing.
  assert.match(REVIEW_INSTRUCTIONS, /write_handoff_note/);
  assert.match(REVIEW_INSTRUCTIONS, /always\.md/);
  assert.match(REVIEW_INSTRUCTIONS, /personality\.md/);
  assert.match(REVIEW_INSTRUCTIONS, /\/work と \/home\/natsumi を片づける/);
});

// ADR 0068: what the day writes where, now that the curator turns the day into knowledge at night, and how anything
// kept is written — who did it, and since when a fact that may change was so.

const TIME_POINT = '「（YYYY-MM-DD 時点）」';

test('the day writes what she was told to remember and promises into topics, and what happened into the diary', () => {
  const bullets = workspaceSection();
  assert.match(bullets, /「覚えておいて」と言われたことと、マスターとの約束は、\/memory のトピックのファイルに書きます/);
  assert.match(bullets, /その日に起きたことや経緯は、\/memory\/diary\/ のその日のファイル/);
  assert.match(bullets, /夜に記憶の整理係が、日記と会話からトピックに書き起こします/);
  assert.doesNotMatch(bullets, /マスターについて今後も役立つこと/);
});

test('the day, the night, the memo and the curator write a fact that may change with the date it held, and every sentence with its subject', () => {
  const told: [string, string][] = [['the day', workspaceSection()], ['the night', REVIEW_INSTRUCTIONS], ['the memo', REFLECTION_REQUEST],
    ['the curator', curatorSystemPrompt('なつみ')]];
  for (const [name, text] of told) {
    assert.ok(text.includes(TIME_POINT), `${name}: the date a fact held`);
    assert.match(text, /予定は日付が時点なので付けません/, `${name}: not on a plan`);
    assert.match(text, /文ごとに主語/, `${name}: the subject`);
  }
  // The rule against 自分 and 本人 stays beside it.
  assert.match(workspaceSection(), /「自分」「本人」「あの人」は使わず/);
});

test('the night no longer adds what the day left out: the curator does, and she keeps to the handoff, her two files and the workspace', () => {
  assert.doesNotMatch(REVIEW_INSTRUCTIONS, /まだ記憶にないもの/);
  assert.doesNotMatch(REVIEW_INSTRUCTIONS, /書き足す/);
  assert.match(REVIEW_INSTRUCTIONS, /今日の出来事をトピックに書き起こすのは、この後の記憶の整理係です/);
  for (const kept of ['write_handoff_note', 'always.md', 'personality.md', 'ps で残っているプロセス', '/work と /home/natsumi を片づける']) {
    assert.ok(REVIEW_INSTRUCTIONS.includes(kept), kept);
  }
});

test('the curator fills in a missing subject where the conversation or the diary tells it, and leaves it otherwise', () => {
  assert.match(curatorSystemPrompt('なつみ'), /主語の抜けた文があれば、会話の本文や diary\/ から分かる範囲で補います。分からなければそのままにします。/);
});
