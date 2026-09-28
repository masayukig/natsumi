import assert from 'node:assert/strict';
import test from 'node:test';
import { REVIEW_INSTRUCTIONS, workspaceSection } from '../src/server/prompts.ts';

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
