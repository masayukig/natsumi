import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextEvent } from '@earendil-works/pi-coding-agent';
import { REFLECTION_REQUEST } from '../src/server/prompts.ts';
import { ALREADY_READ, foldTurns, MEMO_CUT, MEMO_HEADING, MEMO_MAX_CHARS, SENT } from '../src/server/turn-fold.ts';

// Folding the turns that have ended (ADR 0047): what the model is sent, never what the session records.

type AgentMessage = ContextEvent['messages'][number];

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

let clock = 0;
const user = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: ++clock });
const events = (text: string) => user(`<events>\n{"type":"mac_message","text":"${text}"}\n</events>`);
type Block = { type: 'thinking'; thinking: string } | { type: 'text'; text: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };
const assistant = (...content: Block[]): AgentMessage => ({ role: 'assistant', content: blocks(content), api: 'openai-completions',
  provider: 'natsumi-compatible', model: 'fixture', usage: USAGE,
  stopReason: content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: ++clock });
const think = (thinking: string): Block => ({ type: 'thinking', thinking });
const say = (text: string): Block => ({ type: 'text', text });
const call = (id: string, name: string, args: Record<string, unknown>): Block => ({ type: 'toolCall', id, name, arguments: args });
const blocks = (content: Block[]) => content as Extract<AgentMessage, { role: 'assistant' }>['content'];
const result = (id: string, name: string, text: string, isError = false): AgentMessage => ({ role: 'toolResult', toolCallId: id,
  toolName: name, content: [{ type: 'text', text }], isError, timestamp: ++clock });
const reflection = (memo: string): AgentMessage[] => [user(REFLECTION_REQUEST), assistant(think('振り返りの思考'), say(memo))];

/** One ordinary turn: she looked something up, replied, and the server asked for her memo. */
function turn(n: number): AgentMessage[] {
  return [
    events(`質問${n}`),
    assistant(think(`考え${n}`), call(`shell-${n}`, 'run_shell', { command: `rg 予定${n} /memory` })),
    result(`shell-${n}`, 'run_shell', `コマンドは終了コード 0 で終わりました。\n標準出力:\n予定${n}`),
    assistant(think(`返事を考える${n}`), say('（内心）'), call(`reply-${n}`, 'reply_to_mac', { text: `答え${n}`, expression: 'happy' })),
    result(`reply-${n}`, 'reply_to_mac', '本人の Mac にセリフを送りました。このセリフは確定しました。'),
    assistant(think('終わる'), say('済んだ')),
    ...reflection(`予定${n}を確認した。`),
  ];
}

const texts = (message: AgentMessage): string => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string; thinking?: string; name?: string }[])
    .map(block => block.text ?? block.thinking ?? `call:${block.name}`).join('|');
};
const shape = (messages: AgentMessage[]) => messages.map(message => `${message.role}: ${texts(message)}`);

test('a turn that has ended keeps what arrived, what she sent and her memo; its thinking and other tools go', () => {
  const current = [events('いまの質問'), assistant(think('いまの考え'), call('shell-now', 'run_shell', { command: 'ls' }))];
  const folded = foldTurns([...turn(1), ...current]);
  assert.ok(folded);
  assert.deepEqual(shape(folded), [
    'user: <events>\n{"type":"mac_message","text":"質問1"}\n</events>',
    'assistant: call:reply_to_mac',
    `toolResult: ${SENT}`,
    `assistant: ${MEMO_HEADING}予定1を確認した。`,
    // The turn in progress is left exactly as it is.
    ...shape(current),
  ]);
  // The reply is kept whole: what she said is part of the conversation.
  const kept = folded[1] as Extract<AgentMessage, { role: 'assistant' }>;
  assert.deepEqual(kept.content, [{ type: 'toolCall', id: 'reply-1', name: 'reply_to_mac', arguments: { text: '答え1', expression: 'happy' } }]);
});

test('the turn being reflected on is not folded, so the memo request extends the cached prefix', () => {
  const ending = turn(1).slice(0, -1);
  assert.equal(foldTurns(ending), undefined);
  assert.equal(foldTurns(turn(1)), undefined, 'a memo with nothing after it is still the current turn');
  assert.equal(foldTurns([events('最初')]), undefined);
});

test('notices, questions to other agents and reads are kept; failed calls and the rest are not', () => {
  const messages = [
    events('一日の予定'),
    assistant(think('調べる'),
      call('read-1', 'read', { path: '/memory/schedule.md' }),
      call('shell-1', 'run_shell', { command: 'date' }),
      call('face-1', 'set_mac_avatar_expression', { expression: 'happy' })),
    result('read-1', 'read', '# 予定\n- 15:00 会議'),
    result('shell-1', 'run_shell', 'コマンドは終了コード 0 で終わりました。'),
    result('face-1', 'set_mac_avatar_expression', 'アバターの表情を happy にしました。'),
    assistant(call('ask-1', 'ask_agent', { agent: 'poppo', message: '返信先: …', continue: false }),
      call('notify-1', 'notify_owner', { text: '会議です', expression: 'neutral' }),
      call('reply-1', 'reply_to_mac', { text: '長すぎる返事', expression: 'neutral' }),
      call('check-1', 'schedule_self_check', { reason: '会議の前', in_minutes: 30 })),
    result('ask-1', 'ask_agent', 'poppo に頼みました。'),
    result('notify-1', 'notify_owner', '本人に知らせを送りました。'),
    result('reply-1', 'reply_to_mac', '送信していません。長すぎます。', true),
    result('check-1', 'schedule_self_check', '予約しました。'),
    assistant(call('read-2', 'read', { path: '/manual/nothing.md' })),
    result('read-2', 'read', 'ENOENT', true),
    ...reflection('15:00 に会議。'),
    events('次'),
  ];
  const folded = foldTurns(messages)!;
  assert.deepEqual(shape(folded), [
    'user: <events>\n{"type":"mac_message","text":"一日の予定"}\n</events>',
    'assistant: call:read',
    'toolResult: # 予定\n- 15:00 会議',
    'assistant: call:ask_agent|call:notify_owner',
    'toolResult: poppo に頼みました。',
    `toolResult: ${SENT}`,
    `assistant: ${MEMO_HEADING}15:00 に会議。`,
    'user: <events>\n{"type":"mac_message","text":"次"}\n</events>',
  ]);
});

test('a file read again with the same content becomes a note; one that changed is kept', () => {
  const readTurn = (n: number, text: string): AgentMessage[] => [
    events(`${n}`),
    assistant(call(`read-${n}`, 'read', { path: '/memory/people.md' })),
    result(`read-${n}`, 'read', text),
    ...reflection(`メモ${n}`),
  ];
  const folded = foldTurns([...readTurn(1, '古い'), ...readTurn(2, '古い'), ...readTurn(3, '新しい'), ...readTurn(4, '新しい'), events('次')])!;
  const results = folded.filter(message => message.role === 'toolResult').map(texts);
  assert.deepEqual(results, ['古い', ALREADY_READ('/memory/people.md'), '新しい', ALREADY_READ('/memory/people.md')]);
});

test('steered events stay where they arrived, and a turn without a memo waits for the next memo to fold', () => {
  const messages = [
    events('一つ目'),
    assistant(think('a'), call('shell-1', 'run_shell', { command: 'ls' })),
    result('shell-1', 'run_shell', '出力'),
    events('途中で届いた'),
    assistant(think('b'), say('終わり')),
    // This turn failed: no memo was asked for. Its steps fold with the next turn's, which has one.
    events('二つ目'),
    assistant(think('c'), call('reply-2', 'reply_to_mac', { text: '返事', expression: 'neutral' })),
    result('reply-2', 'reply_to_mac', '送りました'),
    ...reflection('二つまとめて'),
    events('三つ目'),
  ];
  assert.deepEqual(shape(foldTurns(messages)!), [
    'user: <events>\n{"type":"mac_message","text":"一つ目"}\n</events>',
    'user: <events>\n{"type":"mac_message","text":"途中で届いた"}\n</events>',
    'user: <events>\n{"type":"mac_message","text":"二つ目"}\n</events>',
    'assistant: call:reply_to_mac',
    `toolResult: ${SENT}`,
    `assistant: ${MEMO_HEADING}二つまとめて`,
    'user: <events>\n{"type":"mac_message","text":"三つ目"}\n</events>',
  ]);
});

test('an empty memo leaves no line, and the calls a memo tried are dropped with it', () => {
  const messages = [
    events('一つ目'),
    user(REFLECTION_REQUEST),
    assistant(think('何もない'), call('reply-x', 'reply_to_mac', { text: 'だめ', expression: 'neutral' })),
    result('reply-x', 'reply_to_mac', '振り返りの間はツールを使えません。', true),
    events('次'),
  ];
  assert.deepEqual(shape(foldTurns(messages)!), [
    'user: <events>\n{"type":"mac_message","text":"一つ目"}\n</events>',
    'user: <events>\n{"type":"mac_message","text":"次"}\n</events>',
  ]);
});

test('the same messages always fold the same way, and a fold is a prefix of the next one', () => {
  const [one, two, three] = [turn(1), turn(2), turn(3)];
  const day = [...one, ...two, events('3')];
  const first = foldTurns(structuredClone(day))!;
  assert.deepEqual(foldTurns(structuredClone(day)), first);
  // The next turn goes on, then ends: what was folded before stands unchanged at the front.
  const later = foldTurns([...one, ...two, ...three, events('4')])!;
  assert.deepEqual(later.slice(0, first.length - 1), first.slice(0, -1));
  // The input is not touched: Pi hands the handler a copy, but a fold must not rely on it.
  const copy = structuredClone(day);
  foldTurns(copy);
  assert.deepEqual(copy, day);
});

test('a call ID carrying a paired reasoning item keeps only its call ID once the reasoning is gone', () => {
  const messages = [
    events('一つ目'),
    assistant(think('推論'), call('call_abc|fc_123', 'reply_to_mac', { text: 'はい', expression: 'neutral' })),
    result('call_abc|fc_123', 'reply_to_mac', '送りました'),
    ...reflection('メモ'),
    events('次'),
  ];
  const folded = foldTurns(messages)!;
  const kept = folded[1] as Extract<AgentMessage, { role: 'assistant' }>;
  assert.equal((kept.content[0] as { id: string }).id, 'call_abc');
  assert.equal((folded[2] as { toolCallId: string }).toolCallId, 'call_abc');
});

test('messages of other kinds, such as a compaction summary, pass through untouched', () => {
  const summary = { role: 'compactionSummary', summary: '要約', tokensBefore: 1, timestamp: ++clock } as unknown as AgentMessage;
  const folded = foldTurns([summary, ...turn(1), events('次')])!;
  assert.equal(folded[0], summary);
});

test('a memo of "なし" leaves no line, like an empty one; a memo past the limit is cut with a mark', () => {
  for (const nothing of ['なし', ' なし。', '「なし」', '特になし']) {
    const folded = foldTurns([events('一つ目'), ...reflection(nothing), events('次')])!;
    assert.equal(folded.some(message => texts(message).startsWith(MEMO_HEADING)), false, nothing);
  }
  const long = 'あ'.repeat(MEMO_MAX_CHARS + 50);
  const folded = foldTurns([events('一つ目'), ...reflection(long), events('次')])!;
  const line = folded.map(texts).find(text => text.startsWith(MEMO_HEADING))!;
  assert.equal(line, `${MEMO_HEADING}${'あ'.repeat(MEMO_MAX_CHARS)}${MEMO_CUT}`);
  // Within the limit it stands whole, with its line breaks folded into spaces.
  const short = foldTurns([events('一つ目'), ...reflection('15:00 に会議。\n資料は未確認。'), events('次')])!;
  assert.ok(short.map(texts).includes(`${MEMO_HEADING}15:00 に会議。 資料は未確認。`));
});
