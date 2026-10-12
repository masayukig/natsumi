import assert from 'node:assert/strict';
import test from 'node:test';
import { LONG_RESULT_BYTES, turnPage, turnsPage } from '../src/server/dashboard-turns.ts';
import type { RecordEntry, TurnRow } from '../src/server/turn-log.ts';
import { SessionRecord } from './support/session-record.ts';

// The pages of the turns (ADR 0049): the list from the numbers, and each turn whole, every word escaped.

const HOSTILE = '<img src=x onerror=alert(1)>';
const ZONE = 'Asia/Tokyo';

function row(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    turnId: 'turn-1', kind: 'events', startedAt: '2026-01-01T00:00:00.000Z', turnMs: 12_300, fold: 'on', route: 'local',
    eventKinds: 'mac_message', outcome: 'ok', firstOutMs: 4_200, modelCalls: 3, inputTokens: 1_200, cacheReadTokens: 30_000,
    outputTokens: 450, contextTokens: 31_000, reflectionMs: 800, compacted: false, toolErrors: 0,
    place: { sessionFile: 'a.jsonl', firstEntryId: 'aa000001', lastEntryId: 'aa000009', startOffset: 10, endOffset: 900 },
    eventIds: ['event-1'], ...overrides,
  };
}

test('the list shows each turn’s time, kind, events, outcome, times, calls, tokens, route, fold and compaction, newest first', () => {
  const text = turnsPage({ rows: [row({ compacted: true }), row({ turnId: 'turn-2', kind: 'review', eventKinds: 'nightly_review' }),
    row({ turnId: 'turn-3', kind: 'curator', eventKinds: 'memory_curator' })], more: false, page: 1 }, ZONE).text;
  assert.match(text, /記憶の整理/, 'the curator\'s turn is a kind of its own (ADR 0055)');
  assert.match(text, /2026-01-01 09:00:00/, 'in the configured time zone');
  assert.match(text, /href="\/dashboard\/turns\/turn-1"/);
  assert.match(text, /mac_message/);
  assert.match(text, /4\.2 s/, 'to the first reply');
  assert.match(text, /12\.3 s/, 'the turn');
  assert.match(text, /1,200/);
  assert.match(text, /30,000/);
  assert.match(text, /450/);
  assert.match(text, /local/);
  assert.match(text, /夜の振り返り/);
  assert.match(text, /compaction/);
  assert.match(text, /aria-current="page"[^>]*>ターン|>ターン<\/a>/, 'the navigation has the turns now');
  assert.doesNotMatch(text, /ターン<small>準備中/);
});

test('failed and cut-short turns stand out, and turns from before the places are marked as estimated', () => {
  const text = turnsPage({ rows: [row({ outcome: 'model-call-limit' }), row({ turnId: 'turn-2', outcome: 'model-error' }),
    row({ turnId: 'turn-3', place: null, eventIds: null })], more: false, page: 1 }, ZONE).text;
  assert.match(text, /class="[^"]*bad[^"]*"[^>]*>model-call-limit/);
  assert.match(text, /class="[^"]*bad[^"]*"[^>]*>model-error/);
  assert.equal(text.match(/推定/g)?.length, 1 + 1, 'the one row, and the legend');
});

test('the list goes a page at a time', () => {
  const first = turnsPage({ rows: [row()], more: true, page: 1 }, ZONE).text;
  assert.match(first, /href="\/dashboard\/turns\?page=2"/);
  assert.doesNotMatch(first, /page=0/);
  const second = turnsPage({ rows: [row()], more: false, page: 2 }, ZONE).text;
  assert.match(second, /href="\/dashboard\/turns(\?page=1)?"/);
  assert.doesNotMatch(second, /page=3/);
  assert.match(turnsPage({ rows: [], more: false, page: 1 }, ZONE).text, /まだ記録されたターンはありません/);
});

/** A turn with every kind of step in it. */
function wholeTurn() {
  const r = new SessionRecord('new-session');
  const at = (seconds: number) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + seconds * 1_000).toISOString();
  r.message(at(0), { role: 'system', content: '', sections: { base: '指示の本文' } });
  r.events(at(0), [{ type: 'mac_message', received_at: at(0), text: `本人の質問 ${HOSTILE}` }], '\n\n記憶のファイルを戻しました。',
    [{ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', mimeType: 'image/png' }]);
  r.assistant(at(1), [{ type: 'thinking', thinking: `まず考える ${HOSTILE}` }, { type: 'text', text: '独り言' },
    { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: `/memory/${HOSTILE}.md` } },
    { type: 'toolCall', id: 'c2', name: 'run_shell', arguments: { command: 'ls /nope' } }]);
  r.toolResult(at(2), 'c1', 'read', `長い本文${'x'.repeat(LONG_RESULT_BYTES)}終わり`);
  r.toolResult(at(2), 'c2', 'run_shell', 'No such file', true);
  r.events(at(3), [{ type: 'mac_message', received_at: at(3), text: '差し込まれた一言' }]);
  r.assistant(at(4), [{ type: 'toolCall', id: 'c3', name: 'reply_to_mac', arguments: { text: '返事の本文', expression: 'happy' } }]);
  r.toolResult(at(4), 'c3', 'reply_to_mac', '送りました。');
  r.assistant(at(5), [], { stopReason: 'error', errorMessage: `provider said ${HOSTILE}` });
  r.memoRequest(at(6));
  r.assistant(at(7), [{ type: 'text', text: '一行メモの本文' }]);
  r.compaction(at(8), `要約の本文 ${HOSTILE}`, 'ne000002');
  return r.lines.slice(1).map(line => JSON.parse(line) as RecordEntry);
}

test('the detail shows the turn whole: the events, the message steered in, each call’s thinking, words and tool calls with their results', () => {
  const text = turnPage({ row: row(), reading: { found: true, estimated: false, sessionFile: 'a.jsonl', entries: wholeTurn() } }, ZONE).text;
  assert.match(text, /届いた出来事/);
  assert.match(text, /本人の質問 &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(text, /記憶のファイルを戻しました。/, 'what the server added after the events');
  assert.match(text, /差し込まれた出来事[\s\S]*差し込まれた一言/);
  assert.match(text, /思考[\s\S]*まず考える &lt;img/);
  assert.match(text, /独り言/);
  assert.match(text, /read[\s\S]*&quot;path&quot;: &quot;\/memory\/&lt;img/, 'the arguments, whole');
  assert.match(text, /reply_to_mac[\s\S]*返事の本文/);
  assert.match(text, /No such file/);
  assert.match(text, /class="[^"]*bad[^"]*"[^>]*>エラー/, 'a tool result that was an error');
  assert.match(text, /provider said &lt;img/, 'a model error');
  assert.match(text, /一行メモ[\s\S]*一行メモの本文/);
  assert.match(text, /一行メモの依頼/);
  assert.match(text, /compaction[\s\S]*要約の本文 &lt;img/);
  assert.match(text, /61,000/, 'tokens before the compaction');
  assert.match(text, /fixture-model/);
  assert.match(text, /90/, 'the cached tokens of a call');
  assert.ok(!text.includes('<img src=x'), 'nothing from the record is markup');
});

test('a long tool result is folded by default; a short one is shown open', () => {
  const text = turnPage({ row: row(), reading: { found: true, estimated: false, sessionFile: 'a.jsonl', entries: wholeTurn() } }, ZONE).text;
  const long = text.indexOf('長い本文');
  const opened = text.lastIndexOf('<details', long);
  assert.ok(opened >= 0 && text.lastIndexOf('</details>', long) < opened, 'the long result is inside a <details>');
  assert.doesNotMatch(text.slice(opened, text.indexOf('>', opened) + 1), /\bopen\b/, 'closed by default');
  const short = text.indexOf('No such file');
  const around = text.lastIndexOf('<details', short);
  assert.ok(around < 0 || text.lastIndexOf('</details>', short) > around, 'the short result is not folded');
});

test('images are shown by an authenticated URL of the dashboard, never inline', () => {
  const text = turnPage({ row: row(), reading: { found: true, estimated: false, sessionFile: 'a.jsonl', entries: wholeTurn() } }, ZONE).text;
  assert.match(text, /<img src="\/dashboard\/turns\/turn-1\/images\/0"/);
  assert.doesNotMatch(text, /iVBORw0KGgo/);
  assert.doesNotMatch(text, /data:image/);
});

test('an estimated turn says so, and a turn not found in the record says why', () => {
  const estimated = turnPage({ row: row({ place: null }), reading: { found: true, estimated: true, sessionFile: 'a.jsonl', entries: wholeTurn() } }, ZONE).text;
  assert.match(estimated, /推定/);
  const gone = turnPage({ row: row(), reading: { found: false, reason: 'no-file' } }, ZONE).text;
  assert.match(gone, /記録のファイルが見つかりません/);
  const missing = turnPage({ row: row({ place: null }), reading: { found: false, reason: 'not-in-file' } }, ZONE).text;
  assert.match(missing, /記録の中に見つかりません/);
  assert.match(missing, /mac_message/, 'the numbers are still shown');
});

test('the turn in progress is shown as such, before it has a row', () => {
  const text = turnPage({ inProgress: { turnId: 'turn-running', kind: 'events', startedAt: '2026-01-01T00:00:00.000Z',
    eventKinds: 'mac_message', eventIds: ['event-1'], place: { sessionFile: 'a.jsonl', startOffset: 10 } },
  reading: { found: true, estimated: false, sessionFile: 'a.jsonl', entries: wholeTurn().slice(0, 3) } }, ZONE).text;
  assert.match(text, /実行中/);
  assert.match(text, /本人の質問/);
});

/** A turn whose calls name paths: read inside and outside the places, a relative one, and a shell command. */
function pathsTurn() {
  const r = new SessionRecord('path-session');
  const at = '2026-01-01T00:00:01.000Z';
  r.assistant(at, [
    { type: 'toolCall', id: 'p1', name: 'read', arguments: { path: '/memory/notes/a b.md' } },
    { type: 'toolCall', id: 'p2', name: 'read', arguments: { path: 'drafts/plan.md' } },
    { type: 'toolCall', id: 'p3', name: 'read', arguments: { path: '/etc/passwd' } },
    { type: 'toolCall', id: 'p4', name: 'read', arguments: { path: '/work/../etc/shadow' } },
    { type: 'toolCall', id: 'p5', name: 'run_shell', arguments: { command: 'cat /memory/notes/shell.md' } },
    { type: 'toolCall', id: 'p6', name: 'read', arguments: { path: `/memory/${HOSTILE}` } },
    { type: 'toolCall', id: 'p7', name: 'reply_to_mac', arguments: { text: 'see /work/x.md', expression: 'happy' } },
  ]);
  r.toolResult(at, 'p1', 'read', 'the file mentions /memory/notes/result.md');
  return r.lines.slice(1).map(line => JSON.parse(line) as RecordEntry);
}

test('a file tool’s path inside her places links to the file as it is now, and says it is not the turn’s', () => {
  const text = turnPage({ row: row(), reading: { found: true, estimated: false, sessionFile: 'a.jsonl', entries: pathsTurn() } }, ZONE).text;
  assert.match(text, /<a href="\/dashboard\/files\/memory\/notes\/a%20b\.md">\/memory\/notes\/a b\.md<\/a>/);
  assert.match(text, /<a href="\/dashboard\/files\/work\/drafts\/plan\.md">\/work\/drafts\/plan\.md<\/a>/, 'a relative path is taken from /work');
  assert.match(text, /href="\/dashboard\/files\/memory\/%3Cimg%20src%3Dx%20onerror%3Dalert\(1\)%3E">\/memory\/&lt;img/);
  assert.equal(text.match(/今の中身です。このターンの時点のものではありません/g)?.length, 3);
  assert.doesNotMatch(text, /href="\/dashboard\/files\/etc|href="[^"]*passwd|href="[^"]*shadow/, 'a path outside her places is not a link');
  assert.doesNotMatch(text, /shell\.md"|result\.md"|x\.md"/, 'nor a path in a command, a result or another tool');
  assert.ok(!text.includes('<img src=x'));
});

// ADR 0075: a call to a tool the config declares is marked as one, by what its result recorded, success or failure.
test('a declared tool’s call is marked as declared in the config; a built-in one is not', () => {
  const r = new SessionRecord('declared');
  const at = (seconds: number) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + seconds * 1_000).toISOString();
  r.events(at(0), [{ type: 'mac_message', received_at: at(0), text: '天気は？' }]);
  r.assistant(at(1), [{ type: 'toolCall', id: 'd1', name: 'weather', arguments: { city: '東京' } },
    { type: 'toolCall', id: 'd2', name: 'weather', arguments: { city: '大阪' } },
    { type: 'toolCall', id: 'b1', name: 'run_shell', arguments: { command: 'date' } }]);
  r.message(at(2), { role: 'toolResult', toolCallId: 'd1', toolName: 'weather', isError: false, details: { declared: true },
    content: [{ type: 'text', text: '晴れ' }] });
  r.message(at(2), { role: 'toolResult', toolCallId: 'd2', toolName: 'weather', isError: true, details: { declared: true },
    content: [{ type: 'text', text: 'ツールは終了コード 2 で失敗しました。' }] });
  r.toolResult(at(2), 'b1', 'run_shell', '2026');
  const entries = r.lines.slice(1).map(line => JSON.parse(line) as RecordEntry);
  const text = turnPage({ row: row(), reading: { found: true, estimated: false, sessionFile: 'a.jsonl', entries } }, ZONE).text;
  assert.equal(text.match(/<strong>weather<\/strong> <small class="declared">config で宣言したツール<\/small>/g)?.length, 2);
  assert.match(text, /<strong>run_shell<\/strong><\/p>/);
});
