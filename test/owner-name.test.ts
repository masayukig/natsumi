import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  ASK_AGENT_DESCRIPTION, BASE_INSTRUCTION, compactionInstructions, composeSystemPrompt, CURATOR_INDEX_INSTRUCTIONS, CURATOR_RUN_SHELL_DESCRIPTION,
  CURATOR_STRUCTURE_INSTRUCTIONS,
  CURATOR_WRITE_CHANGE_NOTE_DESCRIPTION, curatorSystemPrompt, DEFAULT_SELF, LIST_SELF_CHECKS_DESCRIPTION,
  NO_WORKSPACE_SECTION, NOTIFY_OWNER_DESCRIPTION, READ_DESCRIPTION, REFLECTION_REQUEST, REPLY_TO_MAC_DESCRIPTION,
  REVIEW_INSTRUCTIONS, RUN_SHELL_DESCRIPTION, SCHEDULE_SELF_CHECK_DESCRIPTION, SEARCH_MEMORY_DESCRIPTION,
  SET_MAC_AVATAR_EXPRESSION_DESCRIPTION, workspaceSection, WRITE_CHANGE_NOTE_DESCRIPTION, WRITE_HANDOFF_NOTE_DESCRIPTION,
} from '../src/server/prompts.ts';

/**
 * Who the owner is, in what natsumi reads (ADR 0061): always "マスター", never "本人", and every memo, diary line and
 * memory written with who did what to whom named rather than "自分", "本人" or "あの人".
 */

const ROOT = join(import.meta.dirname, '..');

/** The rule itself quotes the words it forbids; everywhere else the word is gone. */
const withoutTheRule = (text: string) => text.replaceAll('「本人」', '');

/** Every text of prompts.ts that natsumi or the curator reads. */
const PROMPT_TEXTS: [string, string][] = [
  ['system prompt with a workspace', composeSystemPrompt({ workspace: true, manualIndex: '- 目次', personality: '', always: '', handoff: '' })],
  ['system prompt without a workspace', BASE_INSTRUCTION(NO_WORKSPACE_SECTION)],
  ['run_shell', RUN_SHELL_DESCRIPTION],
  ['read', READ_DESCRIPTION],
  ['search_memory', SEARCH_MEMORY_DESCRIPTION],
  ['reply_to_mac', REPLY_TO_MAC_DESCRIPTION],
  ['notify_owner', NOTIFY_OWNER_DESCRIPTION],
  ['set_mac_avatar_expression', SET_MAC_AVATAR_EXPRESSION_DESCRIPTION(['neutral'])],
  ['write_handoff_note', WRITE_HANDOFF_NOTE_DESCRIPTION],
  ['write_change_note', WRITE_CHANGE_NOTE_DESCRIPTION],
  ['schedule_self_check', SCHEDULE_SELF_CHECK_DESCRIPTION],
  ['list_self_checks', LIST_SELF_CHECKS_DESCRIPTION],
  ['ask_agent', ASK_AGENT_DESCRIPTION],
  ['nightly review', REVIEW_INSTRUCTIONS],
  ['turn memo', REFLECTION_REQUEST],
  ['compaction', compactionInstructions(DEFAULT_SELF)],
  ['curator', curatorSystemPrompt('なつみ')],
  ['curator structure stage', CURATOR_STRUCTURE_INSTRUCTIONS],
  ['curator index stage', CURATOR_INDEX_INSTRUCTIONS],
  ['curator run_shell', CURATOR_RUN_SHELL_DESCRIPTION],
  ['curator write_change_note', CURATOR_WRITE_CHANGE_NOTE_DESCRIPTION],
];

/** The manual pages she reads, and the server files whose tool results and messages reach her. */
const FILES_SHE_READS = [
  'manual/INDEX.md', 'manual/ask-agent.md', 'manual/slack.md', 'assets/manual/images.md',
  'src/server/thinking-loop.ts', 'src/server/scheduler.ts', 'src/server/agent-requests.ts', 'src/server/agent-list.ts',
  'src/server/dove.ts', 'src/server/memory-repository.ts',
];

test('the owner is introduced once as her master, at the very start of her instructions', () => {
  assert.ok(BASE_INSTRUCTION(NO_WORKSPACE_SECTION).startsWith(
    'あなたはなつみ (natsumi)。あなたのオーナー（持ち主）であるマスター専属の秘書で、マスターの Mac のデスクトップにアバターとして常駐しています。'));
  assert.ok(curatorSystemPrompt('なつみ').includes('なつみのオーナー（持ち主）を、記憶ではマスターと呼びます。'));
});

test('nothing the server writes for her calls the owner "本人"', async () => {
  for (const [name, text] of PROMPT_TEXTS) {
    assert.ok(!withoutTheRule(text).includes('本人'), `${name} still says 本人`);
    assert.ok(!text.includes('本人（オーナー）'), name);
  }
  for (const file of FILES_SHE_READS) {
    const text = await readFile(join(ROOT, file), 'utf8');
    assert.ok(!text.includes('本人'), `${file} still says 本人`);
  }
});

test('memory, the diary and the turn memo are written with who did what to whom, by name', () => {
  const rule = (her: string) => `「自分」「本人」「あの人」は使わず、マスター・${her}・ポッポさん・Slack の名前などの呼び名で、誰が誰に何をしたかを書きます。`;
  const bullets = workspaceSection('- 目次');
  assert.ok(bullets.includes(`- 記憶・日記・一行メモは、${rule('あなたの名前')}`));
  assert.ok(bullets.includes('- マスターだと分かっている人は、Slack などでの名前ではなく「マスター」と書きます。'
    + 'どの名前がマスターかは、記憶に書いておきます。'));
  assert.ok(REFLECTION_REQUEST.includes(rule('あなたの名前')));
  assert.ok(REFLECTION_REQUEST.includes('100 字以内'));
  assert.ok(curatorSystemPrompt('はな').includes(`- 書くときは、${rule('はな')}`));
});
