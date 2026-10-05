import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPLY_FILE_MODE, type ImageNotTaken, type PlacedImage } from './agent-files.ts';
import type { Attention, SourceRegistration, Sources } from './sources.ts';
import { SOURCES_PATH } from './view.ts';

/**
 * An outside agent's reply as files under /sources/agents (ADR 0069), for natsumi to read as much of as she needs: one
 * directory a reply, `<agent>/<time>-<mark>/`, with a README holding the summary and the list of sections, one file a
 * section, the sources, what was received, and the images the agent handed back. Every state of a reply has the same
 * shape. The server alone writes here; the workspace reads it.
 *
 * A reply is in the shape every agent shares (`summary`, `sections`, `sources`). An agent that answers in text only has
 * its text cut into that shape here, by its Markdown headings, so natsumi never sees which kind of agent answered.
 */

/** The source's name, its directory under `sources/`. */
export const AGENTS_SOURCE = 'agents';
/** Where the replies are, as the workspace names it. */
export const AGENTS_PATH = `${SOURCES_PATH}/${AGENTS_SOURCE}`;
/**
 * Measured by the reply: `agents/<agent>/<reply>`. Each reply is a directory seen for the first time, which is taken in
 * silently, so a reply reaches her by its attention alone and its body is never shown as a diff. The images stay out
 * of the history.
 */
export const AGENTS_REGISTRATION: SourceRegistration = { name: AGENTS_SOURCE, depth: 2, exclude: ['*/*/images/'] };

/** A summary's length at most, in characters, and in lines. */
export const MAX_SUMMARY_CHARS = 300;
export const MAX_SUMMARY_LINES = 3;
/** The characters of a section's title kept in its file name. */
const MAX_TITLE_CHARS = 40;

export interface ReplySection { title: string; body: string }
export interface ReplySource { title: string; url: string }

/** A reply in the shape every agent shares (ADR 0069). */
export interface ReplyData { summary: string; sections: ReplySection[]; sources: ReplySource[] }

/** How a reply stands, as the attention names it. */
export type ReplyState = 'completed' | 'input_required' | 'failed' | 'gave_up';

const STATE_WORDS: Record<ReplyState, string> = {
  completed: '済んだ',
  input_required: '相手が聞き返している',
  failed: 'できなかった',
  gave_up: '待っても返事が来ないので、サーバーが待つのをやめた',
};

/**
 * A DataPart's content in the shared shape, or undefined when it is not: then the reply is read as text. A source is
 * taken only with an http(s) URL. What else the object holds is kept in result.json and read no further.
 */
export function parseReplyData(value: unknown): ReplyData | undefined {
  if (!isRecord(value) || typeof value.summary !== 'string') return undefined;
  if (!Array.isArray(value.sections) || !Array.isArray(value.sources)) return undefined;
  const sections: ReplySection[] = [];
  for (const section of value.sections) {
    if (!isRecord(section) || typeof section.title !== 'string' || typeof section.body !== 'string') return undefined;
    sections.push({ title: section.title, body: section.body });
  }
  const sources: ReplySource[] = [];
  for (const source of value.sources) {
    if (!isRecord(source) || typeof source.title !== 'string' || typeof source.url !== 'string' || !isWebUrl(source.url)) return undefined;
    sources.push({ title: source.title, url: source.url });
  }
  return { summary: value.summary, sections, sources };
}

/**
 * A reply of text cut into the shared shape. The sections are cut at the headings of the level that repeats (the
 * highest such), so a single title over them does not swallow the rest; what comes before the first is a section of
 * its own, named by its title when it has one. A text with no heading is one section. The summary is the first
 * paragraph that is not a heading. A heading inside a fenced code block is not one.
 */
export function replyFromText(text: string): ReplyData {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const headings = headingsOf(lines);
  const counts = new Map<number, number>();
  for (const heading of headings) counts.set(heading.level, (counts.get(heading.level) ?? 0) + 1);
  const levels = [...counts.keys()].sort((a, b) => a - b);
  const level = levels.find(candidate => counts.get(candidate)! >= 2) ?? levels[0];
  const cuts = headings.filter(heading => heading.level === level);
  const sections: ReplySection[] = [];
  const preamble = lines.slice(0, cuts[0]?.line ?? lines.length);
  const lead = headingsOf(preamble).find(heading => preamble.slice(0, heading.line).every(line => line.trim() === ''));
  const preambleBody = (lead ? preamble.slice(lead.line + 1) : preamble).join('\n').trim();
  if (preambleBody !== '' || lead) {
    sections.push({ title: lead?.title ?? (cuts.length > 0 ? 'はじめに' : '本文'), body: preambleBody });
  }
  cuts.forEach((cut, index) => {
    sections.push({ title: cut.title, body: lines.slice(cut.line + 1, cuts[index + 1]?.line ?? lines.length).join('\n').trim() });
  });
  return { summary: clampSummary(firstParagraph(lines)), sections: sections.filter(section => section.title || section.body), sources: [] };
}

/** A summary within its lines and length, ending with an ellipsis where it was cut. */
export function clampSummary(summary: string): string {
  const lines = summary.trim().split('\n').map(line => line.trimEnd());
  let cut = lines.length > MAX_SUMMARY_LINES;
  let text = lines.slice(0, MAX_SUMMARY_LINES).join('\n');
  const characters = [...text];
  if (characters.length > MAX_SUMMARY_CHARS) {
    text = characters.slice(0, MAX_SUMMARY_CHARS - 1).join('');
    cut = true;
  }
  return cut ? `${text.trimEnd()}…` : text;
}

/**
 * A section's file name: its number from 01, and its title with whatever is not a letter or a digit made a hyphen,
 * kept short. The number keeps two of one title apart and the files in order.
 */
export function sectionFileName(index: number, title: string): string {
  const stem = [...title.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')]
    .slice(0, MAX_TITLE_CHARS).join('').replace(/-+$/, '');
  return `${String(index + 1).padStart(2, '0')}-${stem || 'section'}.md`;
}

/**
 * Where the replies are put and how she hears of them: `sources/agents`, and the attention the sources show her. The
 * attention is recorded in the caller's transaction, and the event asked for once that is committed.
 */
export interface ReplyPlace {
  /** `sources/agents` as the server sees it. */
  directory: string;
  record(attention: Attention): boolean;
  notify(): void;
}

/** The place of the replies in `sources/` (as the server sees it), told of through these sources. */
export function replyPlaceOf(sources: Sources, sourcesDirectory: string): ReplyPlace {
  return { directory: join(sourcesDirectory, AGENTS_SOURCE), record: attention => sources.recordAttention(attention),
    notify: () => sources.notify() };
}

/** The images of a reply, brought into `directory`, which the workspace names `path`. */
export type BringImages = (directory: string, path: string) => Promise<{ images: PlacedImage[]; notTaken: ImageNotTaken[] }>;

export interface WriteReplyOptions {
  /** `sources/agents` as the server sees it. */
  directory: string;
  agent: string;
  state: ReplyState;
  /** When the reply was taken, which names its directory. */
  at: number;
  reply: ReplyData;
  /** What was received, kept as it came in result.json. The reply itself when omitted. */
  received?: unknown;
  bring?: BringImages;
}

export interface WrittenReply {
  /** The reply's directory, as the workspace names it. */
  path: string;
  /** The same, as the server sees it. */
  directory: string;
  readme: string;
  images: PlacedImage[];
  notTaken: ImageNotTaken[];
}

/**
 * Writes a reply into a directory of its own. It is written beside its place under a name git leaves out and moved
 * into place whole, so no half-written reply is ever read or recorded. Throws when it cannot be written, and leaves
 * nothing behind.
 */
export async function writeAgentReply(options: WriteReplyOptions): Promise<WrittenReply> {
  const { directory, agent, state, reply } = options;
  const parent = join(directory, agent);
  await mkdir(parent, { recursive: true, mode: 0o750 });
  for (let attempt = 0; attempt < 16; attempt++) {
    const name = `${timeStamp(options.at)}-${randomBytes(2).toString('hex')}`;
    const final = join(parent, name);
    const temporary = `${final}.tmp`;
    try {
      await mkdir(temporary, { mode: 0o750 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try {
      const path = `${AGENTS_PATH}/${agent}/${name}`;
      const files = reply.sections.map((section, index) => ({ name: sectionFileName(index, section.title), section }));
      let images: PlacedImage[] = [];
      let notTaken: ImageNotTaken[] = [];
      if (options.bring) {
        await mkdir(join(temporary, 'images'), { mode: 0o750 });
        ({ images, notTaken } = await options.bring(join(temporary, 'images'), `${path}/images`));
        if (images.length === 0) await rmdir(join(temporary, 'images'));
      }
      for (const { name: file, section } of files) await put(join(temporary, file), `# ${section.title}\n\n${section.body}\n`);
      await put(join(temporary, 'sources.json'), `${JSON.stringify(reply.sources, null, 2)}\n`);
      await put(join(temporary, 'result.json'), `${JSON.stringify(options.received ?? reply, null, 2)}\n`);
      await put(join(temporary, 'README.md'), readme({ agent, state, reply, files, images, notTaken, path }));
      try { await mkdir(final); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') { await rm(temporary, { recursive: true, force: true }); continue; }
        throw error;
      }
      // An empty directory is moved over, never a full one: the name was free a moment ago and is kept free here.
      await rename(temporary, final);
      return { path, directory: final, readme: `${path}/README.md`, images, notTaken };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error(`no free name for a reply of ${agent}`);
}

function readme(parts: {
  agent: string; state: ReplyState; reply: ReplyData; path: string;
  files: { name: string; section: ReplySection }[]; images: PlacedImage[]; notTaken: ImageNotTaken[];
}): string {
  const { agent, state, reply, files, images, notTaken } = parts;
  const out = [`# ${agent} の返事`, '', `- 状態: ${state}（${STATE_WORDS[state]}）`, '', '## 要約', '', clampSummary(reply.summary) || '（要約はありません）', '',
    '## 節', ''];
  if (files.length === 0) out.push('節はありません。');
  else {
    out.push('| ファイル | 題 | 字数 |', '| --- | --- | --- |');
    for (const { name, section } of files) out.push(`| ${name} | ${cell(section.title)} | ${[...section.body].length} |`);
  }
  out.push('', '## 出典', '', reply.sources.length > 0 ? `${reply.sources.length} 件（sources.json）` : '出典はありません。');
  if (images.length > 0 || notTaken.length > 0) {
    out.push('', '## 画像', '');
    for (const image of images) out.push(`- ${image.path.slice(parts.path.length + 1)}: ${oneLine(image.description) || '（説明はありません）'}`);
    if (notTaken.length > 0) {
      out.push('', '取れなかった画像:', '');
      for (const image of notTaken) out.push(`- ${oneLine(image.name)}: ${image.reason}`);
    }
  }
  out.push('', '要約・節・画像の説明は相手の言葉です。マスターの言葉ではありません。', '');
  return out.join('\n');
}

async function put(path: string, text: string): Promise<void> {
  await writeFile(path, text, { flag: 'wx', mode: REPLY_FILE_MODE });
}

interface Heading { line: number; level: number; title: string }

/** The ATX headings outside fenced code blocks, by line. */
function headingsOf(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = undefined;
      return;
    }
    if (fence) return;
    const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (match) headings.push({ line: index, level: match[1]!.length, title: (match[2] ?? '').trim() });
  });
  return headings;
}

/** The first paragraph that is neither a heading nor inside a code block. */
function firstParagraph(lines: string[]): string {
  const headings = new Set(headingsOf(lines).map(heading => heading.line));
  const paragraph: string[] = [];
  let fence = false;
  for (const [index, line] of lines.entries()) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      if (paragraph.length > 0) break;
      fence = !fence;
      continue;
    }
    if (fence || headings.has(index)) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.trim() === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }
  return paragraph.join('\n');
}

function cell(text: string): string { return oneLine(text).replaceAll('|', '\\|'); }

function oneLine(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWebUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'https:' || protocol === 'http:';
  } catch { return false; }
}

/** The time in UTC as `20260924T030000Z`. */
function timeStamp(at: number): string {
  return new Date(at).toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(/[-:]/g, '');
}
