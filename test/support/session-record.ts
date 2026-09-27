import { REFLECTION_REQUEST } from '../../src/server/prompts.ts';

/**
 * A made-up Pi session record (session version 3, as Pi 0.87.1 writes it), for reading turns back without a model.
 * Nothing in it is from a real conversation. Each entry's parentId is the entry before it, as in a session that never
 * branched; times are given by the test.
 */
export class SessionRecord {
  readonly lines: string[] = [];
  private last: string | null = null;
  private serial = 0;

  readonly sessionId: string;

  constructor(sessionId = 'fixture-session', at = '2026-01-01T00:00:00.000Z') {
    this.sessionId = sessionId;
    this.lines.push(JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: at, cwd: '/data' }));
  }

  /** Appends an entry and returns its ID. */
  add(at: string, entry: Record<string, unknown>): string {
    const id = `${this.sessionId.slice(0, 2)}${(++this.serial).toString(16).padStart(6, '0')}`;
    this.lines.push(JSON.stringify({ type: entry.type ?? 'message', id, parentId: this.last, timestamp: at, ...entry }));
    this.last = id;
    return id;
  }

  message(at: string, message: Record<string, unknown>): string {
    return this.add(at, { type: 'message', message: { timestamp: Date.parse(at), ...message } });
  }

  events(at: string, lines: Record<string, unknown>[], extra = '', images: { data: string; mimeType: string }[] = []): string {
    const text = `<events>\n${lines.map(line => JSON.stringify(line)).join('\n')}\n</events>${extra}`;
    return this.message(at, { role: 'user', content: images.length === 0 ? text
      : [{ type: 'text', text }, ...images.map(image => ({ type: 'image', ...image }))] });
  }

  assistant(at: string, content: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
    return this.message(at, { role: 'assistant', content, api: 'openai-completions', provider: 'fixture', model: 'fixture-model',
      usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, totalTokens: 105, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop', ...extra });
  }

  toolResult(at: string, toolCallId: string, toolName: string, content: string | Record<string, unknown>[], isError = false): string {
    return this.message(at, { role: 'toolResult', toolCallId, toolName, isError,
      content: typeof content === 'string' ? [{ type: 'text', text: content }] : content });
  }

  memoRequest(at: string): string {
    return this.message(at, { role: 'user', content: REFLECTION_REQUEST });
  }

  compaction(at: string, summary: string, firstKeptEntryId: string): string {
    return this.add(at, { type: 'compaction', summary, firstKeptEntryId, tokensBefore: 61_000 });
  }

  text(): string { return `${this.lines.join('\n')}\n`; }
  bytes(): number { return Buffer.byteLength(this.text()); }
}

/** A turn of the usual shape: events, a thought and a reply, its result, a closing thought, the memo request and memo. */
export function ordinaryTurn(record: SessionRecord, at: number, words: { message: string; thought: string; reply: string; memo: string }) {
  const iso = (offset: number) => new Date(at + offset).toISOString();
  const first = record.events(iso(10), [{ type: 'mac_message', received_at: iso(0), text: words.message }]);
  record.assistant(iso(1_000), [{ type: 'thinking', thinking: words.thought },
    { type: 'toolCall', id: `call-${first}`, name: 'reply_to_mac', arguments: { text: words.reply, expression: 'neutral' } }]);
  record.toolResult(iso(1_010), `call-${first}`, 'reply_to_mac', '送りました。');
  record.assistant(iso(2_000), [{ type: 'text', text: '済んだ' }]);
  record.memoRequest(iso(2_100));
  const last = record.assistant(iso(2_500), [{ type: 'text', text: words.memo }]);
  return { first, last, endedAt: at + 2_000 };
}
