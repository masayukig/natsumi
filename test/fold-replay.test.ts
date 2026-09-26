import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { classify, contextAt, foldedContextAt, findTurns, lookups, pickPairs } from '../src/probe/fold-replay-plan.ts';
import { REFLECTION_REQUEST } from '../src/server/prompts.ts';
import { MEMO_HEADING } from '../src/server/turn-fold.ts';

// Replaying a past session with and without folding (ADR 0047): the pieces that decide what is sent.

let serial = 0;
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
/** Entries 10 ms apart, as calls follow each other; `{ after: ms }` puts a longer wait before the next one. */
function session(messages: object[]): SessionEntry[] {
  let parentId: string | null = null;
  let clock = Date.parse('2026-09-20T00:00:00Z');
  let wait = 10;
  const entries: SessionEntry[] = [];
  for (const message of messages) {
    if ('after' in message) { wait = (message as { after: number }).after; continue; }
    const id = `e${++serial}`;
    clock += wait;
    wait = 10;
    entries.push({ type: 'message', id, parentId, timestamp: new Date(clock).toISOString(),
      message: { timestamp: clock, ...message } } as unknown as SessionEntry);
    parentId = id;
  }
  return entries;
}
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const events = (text: string) => user(`<events>\n{"type":"mac_message","text":"${text}"}\n</events>`);
const assistant = (...content: object[]) => ({ role: 'assistant', content, api: 'openai-completions', provider: 'p', model: 'm',
  usage: USAGE, stopReason: content.some(block => (block as { type: string }).type === 'toolCall') ? 'toolUse' : 'stop' });
const call = (id: string, name: string, args: object) => ({ type: 'toolCall', id, name, arguments: args });
const result = (id: string, name: string, text: string) => ({ role: 'toolResult', toolCallId: id, toolName: name,
  content: [{ type: 'text', text }], isError: false });
const think = (thinking: string) => ({ type: 'thinking', thinking });

function day() {
  return session([
    events('一つ目'),
    assistant(think('考え1'), call('s1', 'run_shell', { command: 'rg 予定 /memory' })),
    result('s1', 'run_shell', '出力1'),
    events('途中で届いた'),
    assistant(think('返す1'), call('r1', 'reply_to_mac', { text: '返事1', expression: 'neutral' })),
    result('r1', 'reply_to_mac', '送った'),
    assistant(think('終わり1')),
    events('二つ目'),
    assistant(think('考え2'), call('r2', 'reply_to_mac', { text: '返事2', expression: 'neutral' })),
    result('r2', 'reply_to_mac', '送った'),
    assistant(think('終わり2')),
    events('三つ目'),
    assistant(think('考え3'), call('s3', 'read', { path: '/memory/a.md' })),
    user('<events>\n{"type":"nightly_review"}\n</events>'),
  ]);
}

test('turns start at an event prompt; one steered in after a tool result belongs to the turn it arrived in', () => {
  const entries = day();
  const turns = findTurns(entries);
  assert.deepEqual(turns.map(turn => turn.index), [0, 1, 2]);
  assert.equal(turns[0]!.lastEntryId, entries[6]!.id);
  assert.equal(turns[1]!.startEntryId, entries[7]!.id);
  assert.equal(turns[1]!.eventKinds, 'mac_message');
  // The nightly review is not a turn to replay, and the turn before it ends where the review begins.
  assert.equal(turns[2]!.lastEntryId, entries[12]!.id);
  assert.deepEqual(turns[0]!.production, { category: 'lookup', tool: 'run_shell' });
  assert.deepEqual(turns[1]!.production, { category: 'reply', tool: 'reply_to_mac' });
});

test('a turn that ended on a tool result is followed by a new turn, told apart from a steered event by the wait', () => {
  const entries = session([
    events('一つ目'),
    assistant(call('f1', 'reply_to_mac', { text: '返事', expression: 'neutral' })),
    result('f1', 'reply_to_mac', '送った'),
    // Stopped at the call limit, or ended by a tool in an older version: the next event came a while later.
    { after: 60_000 },
    events('二つ目'),
    assistant(call('s2', 'run_shell', { command: 'ls' })),
    result('s2', 'run_shell', '出力'),
    // Steered in at once, at the next model-call boundary.
    events('途中'),
    assistant(think('終わり')),
  ]);
  const turns = findTurns(entries);
  assert.equal(turns.length, 2);
  assert.equal(turns[1]!.startEntryId, entries[3]!.id);
  assert.equal(turns[1]!.lastEntryId, entries[7]!.id);
});

test('the unfolded context is what the turn\'s first call was sent in production', () => {
  const entries = day();
  const [, second] = findTurns(entries);
  const messages = contextAt(entries, second!.startEntryId);
  assert.equal(messages.length, 8);
  assert.equal(JSON.stringify(messages.at(-1)).includes('二つ目'), true);
});

test('the folded context carries a memo after every ended turn and folds them; the turn\'s prompt stays last', () => {
  const entries = day();
  const turns = findTurns(entries);
  const memos = new Map([[0, 'メモ1'], [1, 'メモ2']]);
  const folded = foldedContextAt(entries, turns, 2, memos);
  const text = JSON.stringify(folded);
  assert.doesNotMatch(text, /考え1|考え2|出力1/);
  assert.match(text, new RegExp(`${MEMO_HEADING}メモ1`));
  assert.match(text, new RegExp(`${MEMO_HEADING}メモ2`));
  assert.match(text, /途中で届いた/);
  assert.match(JSON.stringify(folded.at(-1)), /三つ目/);
  assert.doesNotMatch(text, new RegExp(REFLECTION_REQUEST.slice(0, 10)));
  // The first turn has nothing before it to fold.
  assert.deepEqual(foldedContextAt(entries, turns, 0, memos), contextAt(entries, turns[0]!.startEntryId));
});

test('a first action is a reply, a lookup, a request to the dove, another tool, or nothing', () => {
  const reply = { content: [think('x'), call('a', 'reply_to_mac', {})] };
  assert.deepEqual(classify(reply as never), { category: 'reply', tool: 'reply_to_mac' });
  assert.deepEqual(classify({ content: [call('a', 'notify_owner', {})] } as never), { category: 'reply', tool: 'notify_owner' });
  assert.deepEqual(classify({ content: [call('a', 'read', {})] } as never), { category: 'lookup', tool: 'read' });
  assert.deepEqual(classify({ content: [call('a', 'ask_agent', { agent: 'poppo' })] } as never), { category: 'dove', tool: 'ask_agent' });
  assert.deepEqual(classify({ content: [call('a', 'ask_agent', { agent: 'wiki' })] } as never), { category: 'other', tool: 'ask_agent' });
  assert.deepEqual(classify({ content: [call('a', 'schedule_self_check', {})] } as never), { category: 'other', tool: 'schedule_self_check' });
  assert.deepEqual(classify({ content: [think('x')] } as never), { category: 'none', tool: null });
});

test('lookups already made in earlier turns are counted, whatever the spaces', () => {
  const entries = day();
  const turns = findTurns(entries);
  const response = { content: [call('x', 'run_shell', { command: ' rg  予定 /memory ' }), call('y', 'read', { path: '/memory/b.md' })] };
  assert.deepEqual(lookups(entries, turns, 2, response as never), { lookups: 2, repeated: 1 });
  assert.deepEqual(lookups(entries, turns, 0, response as never), { lookups: 2, repeated: 0 });
});

test('pairs are drawn from turns where the two sides first acted differently, with A and B shuffled by the seed', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ key: `t${index}`, differs: index % 2 === 0 }));
  const first = pickPairs(rows, 5, 42);
  assert.equal(first.length, 5);
  assert.ok(first.every(pair => rows.find(row => row.key === pair.key)!.differs));
  assert.deepEqual(pickPairs(rows, 5, 42), first);
  assert.ok(first.some(pair => pair.foldedIs === 'A') || first.some(pair => pair.foldedIs === 'B'));
});
