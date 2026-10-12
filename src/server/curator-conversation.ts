import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DOVE_NAME } from './dove.ts';
import { parseDoveRequest } from './dove-request.ts';
import { SLACK_PATH } from './slack-archive.ts';
import { localDateTime } from './nightly.ts';

/**
 * The day's conversation the curator is handed (ADR 0068), read out of natsumi's Pi sessions: the words that came to
 * her and what she said back, with what she read and searched in memory. Her thinking, what she wrote to herself and
 * what a tool returned stay out; the session as it stands is too big, and the curator wants what was said.
 *
 * Where the words are, as the sessions hold them:
 *
 * - The owner on the Mac, the iPhone or the browser: a `mac_message` event's `text`, inside `<events>`. The three are
 *   one kind of event; the session does not tell them apart.
 * - Slack: what she was told arrives as a `sources_updated` pointer, and its text only in what a tool returned, so it
 *   is not here. A `slack_mention` event from before ADR 0050 carried its text, and is taken. What she wrote to Slack
 *   is the body of an `ask_agent` post to the dove.
 * - Her answers: `reply_to_mac` and `notify_owner`, as she called them.
 * - Memory she used: `read` of a path under /memory, and `search_memory`, by their arguments.
 */

/** One line of the conversation, at the moment it happened. */
export interface ConversationLine { at: number; text: string }

/** The conversation as handed over: its lines oldest first, and how many older ones the limit left out. */
export interface Conversation { lines: string[]; dropped: number }

export interface ConversationWindow {
  /** From the last night the curator succeeded … */
  since: number;
  /** … to tonight. */
  until: number;
  timeZone: string;
  /** natsumi's display name. */
  name: string;
}

const MEMORY_PREFIX = '/memory/';

/** The conversation in `entries` (a Pi session's lines, parsed) that falls inside the window, in the order it happened. */
export function conversationLines(entries: readonly unknown[], window: ConversationWindow): ConversationLine[] {
  const lines: ConversationLine[] = [];
  const add = (at: number, text: string) => {
    if (Number.isFinite(at) && at >= window.since && at <= window.until) lines.push({ at, text: `[${stamp(at, window.timeZone)}] ${text}` });
  };
  for (const item of entries) {
    if (!isRecord(item) || item.type !== 'message' || !isRecord(item.message)) continue;
    const at = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : Number.NaN;
    const { role, content } = item.message;
    if (!Array.isArray(content)) continue;
    if (role === 'user') {
      for (const part of content) {
        if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
        for (const event of eventsIn(part.text)) {
          const when = typeof event.received_at === 'string' && Number.isFinite(Date.parse(event.received_at)) ? Date.parse(event.received_at) : at;
          if (event.type === 'mac_message' && typeof event.text === 'string') add(when, `マスター: ${indent(event.text)}`);
          if (event.type === 'slack_mention' && typeof event.text === 'string') {
            add(when, `Slack ${[event.channel, event.from].filter(value => typeof value === 'string').join(' ')}: ${indent(event.text)}`);
          }
        }
      }
    }
    if (role === 'assistant') {
      for (const part of content) {
        if (!isRecord(part) || part.type !== 'toolCall' || !isRecord(part.arguments)) continue;
        const line = toolLine(String(part.name), part.arguments, window.name);
        if (line) add(at, line);
      }
    }
  }
  return lines.sort((a, b) => a.at - b.at);
}

/** The channel a request to the dove goes to, as she names it: `/sources/slack/work/dev/…` is `work/#dev`. */
function channelOf(file: string): string {
  const [workspace = '', directory = ''] = file.slice(SLACK_PATH.length + 1).split('/');
  return `${workspace}/${directory.startsWith('@') ? directory : `#${directory}`}`;
}

/**
 * A post asked in the form before ADR 0074 (`返信先:` and `種類: 投稿` headings, then `---` and the body), which a session
 * of that time still holds. The dove takes it no more; the curator still reads what was said.
 */
function earlierPost(message: string, her: string): string | undefined {
  const lines = message.replace(/\r\n?/g, '\n').split('\n');
  const separator = lines.findIndex(line => line.trim() === '---');
  if (separator < 0) return undefined;
  const heading = (name: string) => lines.slice(0, separator).find(line => line.startsWith(`${name}:`))?.slice(name.length + 1).trim();
  const body = lines.slice(separator + 1).join('\n').trim();
  if (heading('種類') !== '投稿' || body === '') return undefined;
  return `${her} → Slack ${heading('返信先') ?? ''}: ${indent(body)}`;
}

function toolLine(name: string, args: Record<string, unknown>, her: string): string | undefined {
  const text = typeof args.text === 'string' ? args.text : undefined;
  if (name === 'reply_to_mac' && text) return `${her} → マスター: ${indent(text)}`;
  if (name === 'notify_owner' && text) return `${her} → マスター（知らせ）: ${indent(text)}`;
  if (name === 'ask_agent' && args.agent === DOVE_NAME && typeof args.message === 'string') {
    const parsed = parseDoveRequest(args.message);
    if (!parsed.ok) return earlierPost(args.message, her);
    if (parsed.request.kind !== 'post' || parsed.request.body === '') return undefined;
    return `${her} → Slack ${channelOf(parsed.request.to.file)}: ${indent(parsed.request.body)}`;
  }
  if (name === 'read' && typeof args.path === 'string' && args.path.startsWith(MEMORY_PREFIX)) {
    return `${her}が記憶を読んだ: ${args.path.slice(MEMORY_PREFIX.length)}`;
  }
  if (name === 'search_memory' && typeof args.query === 'string') {
    const where = typeof args.path === 'string' ? args.path.replace(/^\/memory\/?/, '').replace(/\/$/, '') : '';
    return `${her}が記憶を探した: 「${args.query}」${where ? `（${where}）` : ''}`;
  }
  return undefined;
}

/** The events of a user message, one JSON object a line inside `<events>`; anything else in it is not an event. */
function eventsIn(text: string): Record<string, unknown>[] {
  const match = /^<events>\n([\s\S]*)\n<\/events>/.exec(text);
  if (!match) return [];
  const events: Record<string, unknown>[] = [];
  for (const line of match[1]!.split('\n')) {
    try {
      const event: unknown = JSON.parse(line);
      if (isRecord(event)) events.push(event);
    } catch { /* not an event */ }
  }
  return events;
}

/**
 * The lines that fit in `maxChars`, each counted with its newline: the newest kept, the oldest dropped. A newest line
 * longer than the limit by itself is cut short rather than lost.
 */
export function fitConversation(lines: readonly ConversationLine[], maxChars: number): Conversation {
  const kept: string[] = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const length = [...lines[index]!.text].length + 1;
    if (total + length > maxChars) {
      if (kept.length === 0 && maxChars > 2) {
        kept.unshift(`${[...lines[index]!.text].slice(0, maxChars - 2).join('')}…`);
        return { lines: kept, dropped: index };
      }
      return { lines: kept, dropped: index + 1 };
    }
    kept.unshift(lines[index]!.text);
    total += length;
  }
  return { lines: kept, dropped: 0 };
}

/**
 * The conversation of the sessions in `sessionDirectory` the window reaches: those begun inside it, and the last one
 * begun before it. Only the directory's own files: the curator's sessions are under it, and are not the conversation.
 * A directory or a line that cannot be read is passed over.
 */
export async function readConversation(options: ConversationWindow & { sessionDirectory: string; maxChars: number }): Promise<Conversation> {
  let names: string[];
  try {
    names = (await readdir(options.sessionDirectory, { withFileTypes: true }))
      .filter(dirent => dirent.isFile() && dirent.name.endsWith('.jsonl')).map(dirent => dirent.name);
  } catch { return { lines: [], dropped: 0 }; }
  const sessions: { file: string; begun: number }[] = [];
  for (const name of names) {
    const file = join(options.sessionDirectory, name);
    const header = (await readEntries(file, 1))[0];
    const begun = isRecord(header) && typeof header.timestamp === 'string' ? Date.parse(header.timestamp) : Number.NaN;
    if (Number.isFinite(begun) && begun <= options.until) sessions.push({ file, begun });
  }
  sessions.sort((a, b) => a.begun - b.begun);
  const first = Math.max(0, sessions.findLastIndex(session => session.begun <= options.since));
  const lines: ConversationLine[] = [];
  for (const session of sessions.slice(first)) lines.push(...conversationLines(await readEntries(session.file), options));
  return fitConversation(lines.sort((a, b) => a.at - b.at), options.maxChars);
}

/** A session file's entries, at most `limit` of them; a line that is not JSON is left out. */
async function readEntries(file: string, limit = Infinity): Promise<unknown[]> {
  const entries: unknown[] = [];
  const stream = createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (entries.length >= limit) break;
      if (line.trim() === '') continue;
      try { entries.push(JSON.parse(line)); } catch { /* skipped */ }
    }
  } catch {
    // What was read stands.
  } finally {
    reader.close();
    stream.destroy();
  }
  return entries;
}

/** `MM-DD HH:MM` in the owner's time zone. */
function stamp(at: number, timeZone: string): string {
  return localDateTime(at, timeZone).slice('YYYY-'.length);
}

/** A text of several lines, its later lines indented under the first. */
function indent(text: string): string {
  return text.trim().replace(/\r\n?/g, '\n').split('\n').join('\n  ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
