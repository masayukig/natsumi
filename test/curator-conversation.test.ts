import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { conversationLines, fitConversation, readConversation } from '../src/server/curator-conversation.ts';

// The day's conversation the curator is handed (ADR 0068): the words that came from the owner and natsumi's answers,
// with what she read and searched in memory, out of her Pi sessions. Never her thinking, nor what a tool returned.
// Fictional sessions only.

let ids = 0;
const entry = (timestamp: string, message: Record<string, unknown>) => ({ type: 'message', id: `e${ids += 1}`, parentId: null, timestamp, message });
const events = (timestamp: string, ...lines: Record<string, unknown>[]) =>
  entry(timestamp, { role: 'user', content: [{ type: 'text', text: `<events>\n${lines.map(line => JSON.stringify(line)).join('\n')}\n</events>` }] });
const assistant = (timestamp: string, ...content: Record<string, unknown>[]) => entry(timestamp, { role: 'assistant', content });
const toolCall = (name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id: `c${ids += 1}`, name, arguments: args });
const toolResult = (timestamp: string, name: string, text: string) =>
  entry(timestamp, { role: 'toolResult', toolCallId: 'c', toolName: name, content: [{ type: 'text', text }], isError: false });

/** A fictional day: the owner on the Mac, natsumi answering, looking things up in memory, and writing to Slack. */
function day(): unknown[] {
  return [
    { type: 'session', version: 3, id: 's', timestamp: '2026-10-03T19:00:00.000Z', cwd: '/data' },
    events('2026-10-03T23:10:00.000Z', { type: 'mac_message', received_at: '2026-10-03T23:09:58.000Z', text: '金曜の歯医者、14時に変わったよ' }),
    assistant('2026-10-03T23:10:05.000Z', { type: 'thinking', thinking: '予定のファイルを見よう' },
      toolCall('search_memory', { query: '歯医者' }), toolCall('read', { path: '/memory/予定.md' })),
    toolResult('2026-10-03T23:10:06.000Z', 'search_memory', '予定.md:3:- 歯医者は金曜 10 時'),
    toolResult('2026-10-03T23:10:06.000Z', 'read', '# 予定\n- 歯医者は金曜 10 時'),
    assistant('2026-10-03T23:10:09.000Z', { type: 'text', text: '内心: 直しておく' },
      toolCall('run_shell', { command: 'sed -i s/10/14/ /memory/予定.md' }),
      toolCall('reply_to_mac', { text: '14時ですね。\n直しておきました！', expression: 'happy' })),
    toolResult('2026-10-03T23:10:10.000Z', 'run_shell', '（出力なし）'),
    entry('2026-10-03T23:10:12.000Z', { role: 'user', content: [{ type: 'text', text: '<turn_memo>\nこのターンはここまでです。\n</turn_memo>' }] }),
    assistant('2026-10-03T23:10:13.000Z', { type: 'text', text: '歯医者が 14 時に変わった' }),
    events('2026-10-04T01:00:00.000Z', { type: 'ping', received_at: '2026-10-04T01:00:00.000Z', local_time: '2026-10-04 10:00' },
      { type: 'sources_updated', received_at: '2026-10-04T00:59:00.000Z', changed: [{ dir: 'slack/work/dev', files: ['2026-10-04.jsonl'] }] },
      { type: 'agent_reply', received_at: '2026-10-04T00:58:00.000Z', agent: 'wiki-keeper', status: 'completed', text: 'Wiki を直しました' }),
    assistant('2026-10-04T01:00:05.000Z',
      toolCall('ask_agent', { agent: 'poppo', message: JSON.stringify({ kind: 'post', to: { file: '/sources/slack/work/dev/2026-10-04.jsonl', path: '.[3]' },
        text: 'おはようございます、確認します' }) }),
      toolCall('ask_agent', { agent: 'poppo', message: JSON.stringify({ kind: 'reaction', to: { file: '/sources/slack/work/dev/2026-10-04.jsonl', path: '.[3]' },
        emoji: 'eyes' }) }),
      toolCall('ask_agent', { agent: 'wiki-keeper', message: '歯医者のページを直して' }),
      toolCall('read', { path: 'notes.txt' }),
      toolCall('read', { path: '/manual/slack.md' })),
    events('2026-10-04T03:00:00.000Z', { type: 'slack_mention', received_at: '2026-10-04T02:59:00.000Z', via: 'mention', channel: 'work/#dev', from: '山田',
      text: 'なつみさん、資料ありがとう' }),
    assistant('2026-10-04T03:00:04.000Z', toolCall('notify_owner', { text: '山田さんからお礼が届きました', expression: 'happy' }),
      toolCall('search_memory', { query: '山田', path: '/memory/仕事' })),
    events('2026-10-04T19:00:00.000Z', { type: 'nightly_review', received_at: '2026-10-04T19:00:00.000Z', instructions: '一日の終わりです。' }),
    assistant('2026-10-04T19:00:10.000Z', toolCall('write_handoff_note', { text: '明日は歯医者' })),
  ];
}

test('the owner\'s words, natsumi\'s answers and her posts to Slack, with what she read and searched in memory, in order', () => {
  const lines = conversationLines(day(), { since: Date.parse('2026-10-03T19:00:00.000Z'), until: Date.parse('2026-10-04T19:30:00.000Z'),
    timeZone: 'Asia/Tokyo', name: 'なつみ' });
  assert.deepEqual(lines.map(line => line.text), [
    '[10-04 08:09] マスター: 金曜の歯医者、14時に変わったよ',
    '[10-04 08:10] なつみが記憶を探した: 「歯医者」',
    '[10-04 08:10] なつみが記憶を読んだ: 予定.md',
    '[10-04 08:10] なつみ → マスター: 14時ですね。\n  直しておきました！',
    '[10-04 10:00] なつみ → Slack work/#dev: おはようございます、確認します',
    '[10-04 11:59] Slack work/#dev 山田: なつみさん、資料ありがとう',
    '[10-04 12:00] なつみ → マスター（知らせ）: 山田さんからお礼が届きました',
    '[10-04 12:00] なつみが記憶を探した: 「山田」（仕事）',
  ]);
  const all = lines.map(line => line.text).join('\n');
  // Her thinking, what she wrote to herself, what tools returned, the memo, the night's instructions and other agents are left out.
  for (const absent of ['予定のファイルを見よう', '内心', '歯医者は金曜 10 時', 'このターンはここまで', '歯医者が 14 時に変わった', '一日の終わり',
    'Wiki を直しました', '歯医者のページ', 'eyes', 'notes.txt', 'slack.md', '明日は歯医者', 'sed -i']) {
    assert.equal(all.includes(absent), false, absent);
  }
});

test('only what falls between the last night the curator succeeded and tonight is taken', () => {
  const lines = conversationLines(day(), { since: Date.parse('2026-10-04T00:00:00.000Z'), until: Date.parse('2026-10-04T02:00:00.000Z'),
    timeZone: 'Asia/Tokyo', name: 'なつみ' });
  assert.deepEqual(lines.map(line => line.text), ['[10-04 10:00] なつみ → Slack work/#dev: おはようございます、確認します']);
});

test('a post to Slack asked in the form before ADR 0074 is still read from a session of that time', () => {
  const entries = [
    assistant('2026-10-04T01:00:00.000Z', toolCall('ask_agent', { agent: 'poppo',
      message: '返信先: work/#dev 2026-10-04 09:58:00 山田\n種類: 投稿\n表情: happy\n---\nおはようございます、\n確認します' }),
      toolCall('ask_agent', { agent: 'poppo', message: '返信先: work/#dev 2026-10-04 09:58:00 山田\n種類: リアクション\n---\neyes' })),
  ];
  const lines = conversationLines(entries, { since: Date.parse('2026-10-04T00:00:00.000Z'), until: Date.parse('2026-10-04T02:00:00.000Z'),
    timeZone: 'Asia/Tokyo', name: 'なつみ' });
  assert.deepEqual(lines.map(line => line.text), ['[10-04 10:00] なつみ → Slack work/#dev 2026-10-04 09:58:00 山田: おはようございます、\n  確認します']);
});

test('past the limit the oldest lines are dropped, and how many is told; a single line longer than the limit is cut short', () => {
  const lines = [{ at: 1, text: 'a'.repeat(10) }, { at: 2, text: 'b'.repeat(10) }, { at: 3, text: 'c'.repeat(10) }];
  assert.deepEqual(fitConversation(lines, 1000), { lines: lines.map(line => line.text), dropped: 0 });
  // Each line counts with the newline after it.
  assert.deepEqual(fitConversation(lines, 22), { lines: ['b'.repeat(10), 'c'.repeat(10)], dropped: 1 });
  assert.deepEqual(fitConversation(lines, 21), { lines: ['c'.repeat(10)], dropped: 2 });
  assert.deepEqual(fitConversation(lines, 6), { lines: ['cccc…'], dropped: 2 });
  assert.deepEqual(fitConversation(lines, 0), { lines: [], dropped: 3 });
});

test('the sessions read are those the window reaches, never the curator\'s own, and an unreadable line is skipped', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-curator-conversation-')));
  try {
    const write = (name: string, entries: unknown[]) => writeFile(join(root, name), `${entries.map(item => JSON.stringify(item)).join('\n')}\n`);
    const header = (timestamp: string) => ({ type: 'session', version: 3, id: timestamp, timestamp, cwd: '/data' });
    await write('2026-10-01T19-00-00-000Z_a.jsonl', [header('2026-10-01T19:00:00.000Z'),
      events('2026-10-02T01:00:00.000Z', { type: 'mac_message', received_at: '2026-10-02T01:00:00.000Z', text: 'おととい' })]);
    await write('2026-10-02T19-00-00-000Z_b.jsonl', [header('2026-10-02T19:00:00.000Z'),
      events('2026-10-03T01:00:00.000Z', { type: 'mac_message', received_at: '2026-10-03T01:00:00.000Z', text: 'きのうの朝' }),
      events('2026-10-03T21:00:00.000Z', { type: 'mac_message', received_at: '2026-10-03T21:00:00.000Z', text: 'ゆうべ' })]);
    await writeFile(join(root, '2026-10-03T19-00-00-000Z_c.jsonl'), `${JSON.stringify(header('2026-10-03T19:00:00.000Z'))}\n{not json\n`
      + `${JSON.stringify(events('2026-10-04T01:00:00.000Z', { type: 'mac_message', received_at: '2026-10-04T01:00:00.000Z', text: 'けさ' }))}\n`);
    await mkdir(join(root, 'curator'));
    await write('curator/2026-10-04T19-00-00-000Z_d.jsonl', [header('2026-10-04T19:00:00.000Z'),
      events('2026-10-04T19:01:00.000Z', { type: 'mac_message', received_at: '2026-10-04T19:01:00.000Z', text: '係' })]);

    const conversation = await readConversation({ sessionDirectory: root, since: Date.parse('2026-10-03T12:00:00.000Z'),
      until: Date.parse('2026-10-04T19:30:00.000Z'), timeZone: 'Asia/Tokyo', name: 'なつみ', maxChars: 1000 });
    assert.deepEqual(conversation, { lines: ['[10-04 06:00] マスター: ゆうべ', '[10-04 10:00] マスター: けさ'], dropped: 0 });

    const none = await readConversation({ sessionDirectory: join(root, 'missing'), since: 0, until: Date.now(), timeZone: 'Asia/Tokyo',
      name: 'なつみ', maxChars: 1000 });
    assert.deepEqual(none, { lines: [], dropped: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
