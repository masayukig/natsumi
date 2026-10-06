import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
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
 * Measured by the request: `agents/<agent>/<request>`, whose reply goes into the same directory. The history keeps the
 * request and the README alone, so `sources-diff` shows what was asked and the summary of the answer, and never the
 * body: the sections, what was received, the sources and the images stay out of it.
 */
export const AGENTS_REGISTRATION: SourceRegistration = {
  name: AGENTS_SOURCE, depth: 2, exclude: ['*/*/[0-9]*.md', '*/*/result.json', '*/*/sources.json', '*/*/images/'],
};

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

/** Which shape a reply was put from: the agent's DataPart, or its text cut into the shape. */
export type ReplyForm = 'data' | 'text';

/**
 * The limits of the reply extension's JSON Schema (fraction-agents `docs/extensions/reply/v1/reply.schema.json`).
 * Lengths are in characters (code points), as JSON Schema counts them.
 */
const DATA_LIMITS = {
  summary: 500, summaryLines: 3, sections: 50, sectionTitle: 200, sectionBody: 50_000, sources: 100, sourceTitle: 300, url: 2000,
};
const ONE_LINE = /^[^\r\n]+$/;
const WEB_URL = /^https?:\/\/\S+$/;

/**
 * What is wrong with a DataPart's content against the reply extension's JSON Schema, or undefined when nothing is.
 * Checked as strictly as the schema says, fields outside the shape included: an agent that names the extension and
 * does not keep it has its reply read as text.
 */
export function checkReplyData(value: unknown): string | undefined {
  if (!isRecord(value)) return 'the reply is not an object';
  const extra = Object.keys(value).filter(key => !['summary', 'sections', 'sources'].includes(key));
  if (extra.length > 0) return `the reply has fields outside the shape: ${extra.join(', ')}`;
  const { summary, sections, sources } = value;
  if (typeof summary !== 'string') return 'summary is not a string';
  const summaryError = checkLength('summary', summary, DATA_LIMITS.summary);
  if (summaryError) return summaryError;
  if (summary.split('\n').length > DATA_LIMITS.summaryLines) return `summary is longer than ${DATA_LIMITS.summaryLines} lines`;
  if (!Array.isArray(sections)) return 'sections is not a list';
  if (sections.length > DATA_LIMITS.sections) return `more than ${DATA_LIMITS.sections} sections`;
  for (const [index, section] of sections.entries()) {
    const error = checkEntry(`sections[${index}]`, section, 'body', DATA_LIMITS.sectionTitle,
      body => checkLength('body', body, DATA_LIMITS.sectionBody));
    if (error) return error;
  }
  if (!Array.isArray(sources)) return 'sources is not a list';
  if (sources.length > DATA_LIMITS.sources) return `more than ${DATA_LIMITS.sources} sources`;
  for (const [index, source] of sources.entries()) {
    const error = checkEntry(`sources[${index}]`, source, 'url', DATA_LIMITS.sourceTitle, url => [...url].length > DATA_LIMITS.url
      ? `url is longer than ${DATA_LIMITS.url} characters` : WEB_URL.test(url) ? undefined : 'url is not an http or https URL');
    if (error) return error;
  }
  return undefined;
}

/** A DataPart's content in the shared shape, or undefined when it is not (`checkReplyData`): then the reply is read as text. */
export function parseReplyData(value: unknown): ReplyData | undefined {
  if (checkReplyData(value) !== undefined) return undefined;
  const data = value as unknown as ReplyData;
  return { summary: data.summary, sections: data.sections.map(({ title, body }) => ({ title, body })),
    sources: data.sources.map(({ title, url }) => ({ title, url })) };
}

/** A section or a source: an object of a one-line `title` and one field more, and nothing else. */
function checkEntry(where: string, value: unknown, field: string, titleLimit: number, checkField: (text: string) => string | undefined):
  string | undefined {
  if (!isRecord(value)) return `${where} is not an object`;
  const extra = Object.keys(value).filter(key => key !== 'title' && key !== field);
  if (extra.length > 0) return `${where} has fields outside the shape: ${extra.join(', ')}`;
  const { title } = value;
  const content = value[field];
  if (typeof title !== 'string') return `${where}.title is not a string`;
  const titleError = checkLength('title', title, titleLimit) ?? (ONE_LINE.test(title) ? undefined : 'title is not one line');
  if (titleError) return `${where}.${titleError}`;
  if (typeof content !== 'string') return `${where}.${field} is not a string`;
  const error = checkField(content);
  return error ? `${where}.${error}` : undefined;
}

function checkLength(name: string, text: string, limit: number): string | undefined {
  const length = [...text].length;
  if (length === 0) return `${name} is empty`;
  return length > limit ? `${name} is longer than ${limit} characters` : undefined;
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

/** How a request stands to the exchange before it. */
export type RequestKind = 'new' | 'continue' | 'answer';

const REQUEST_KIND_WORDS: Record<RequestKind, string> = {
  new: '新しい依頼',
  continue: '前のやり取りの続き',
  answer: '相手の聞き返しへの答え',
};

/** The longest first line of a request an attention carries, in characters. */
export const MAX_REQUEST_LINE_CHARS = 80;

/** A request's directory, where its reply goes too. */
export interface RequestPlace {
  /** As the workspace names it. */
  path: string;
  /** As the server sees it. */
  directory: string;
}

export interface WriteRequestOptions {
  /** `sources/agents` as the server sees it. */
  directory: string;
  agent: string;
  /** When she asked, which names the directory. */
  at: number;
  /** The same time as she reads it, in the owner's time zone. */
  askedAt: string;
  text: string;
  how: RequestKind;
  /**
   * For one that goes on with an exchange: the directory of the request it goes on from, or null when that is not
   * known (one made before requests were kept).
   */
  previous?: string | null;
}

/**
 * Makes the directory a request's reply will be put in, as the request is made, with `request.md`: when, to whom, how
 * it stands to the exchange before it, and every word of it. A reply is told by its attention; the request is hers,
 * and nothing is told of it.
 */
export async function writeAgentRequest(options: WriteRequestOptions): Promise<RequestPlace> {
  const { directory, agent } = options;
  const lines = [`# ${agent} への依頼`, '', `- 頼んだ時刻: ${options.askedAt}`, `- 相手: ${agent}`, `- 種類: ${REQUEST_KIND_WORDS[options.how]}`];
  if (options.how !== 'new') {
    lines.push(`- 前のやり取り: ${options.previous ? `${options.previous}/` : '分かりません（記録が残る前のやり取りです）'}`);
  }
  lines.push('', '## 文面', '', options.text.trim(), '');
  const made = await makeReplyDirectory(directory, agent, options.at, async temporary => {
    await put(join(temporary, REQUEST_FILE), lines.join('\n'));
  });
  return { path: made.path, directory: made.directory };
}

/** The first line of a request with words in it, cut short for an attention. */
export function firstLine(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '') ?? '';
  const characters = [...line];
  return characters.length > MAX_REQUEST_LINE_CHARS ? `${characters.slice(0, MAX_REQUEST_LINE_CHARS - 1).join('')}…` : line;
}

export interface WriteReplyOptions {
  /** `sources/agents` as the server sees it. */
  directory: string;
  agent: string;
  state: ReplyState;
  /** When the reply was taken, which names its directory when its request has none. */
  at: number;
  reply: ReplyData;
  /** Which shape the reply was put from, for result.json. `text` when omitted. */
  form?: ReplyForm;
  /** The content of the agent's DataPart as it came, whether it fitted or not, for result.json. */
  data?: unknown;
  bring?: BringImages;
  /** The request's directory. Without it (a request made before they were kept) the reply gets one of its own. */
  place?: RequestPlace;
  /** What was asked, for the head of the README. */
  request?: { text: string; askedAt: string };
}

export interface WrittenReply {
  /** The reply's directory, as the workspace names it. */
  path: string;
  /** The same, as the server sees it. */
  directory: string;
  readme: string;
  /** Whether the directory was made for the reply, rather than its request's. */
  created: boolean;
  images: PlacedImage[];
  notTaken: ImageNotTaken[];
}

/** The file a request is kept in, beside its reply. */
export const REQUEST_FILE = 'request.md';

/**
 * Writes a reply into its request's directory, or into a directory of its own. What an earlier attempt left there is
 * cleared first, and the README is written last: it is what the sources' history follows. Throws when it cannot be
 * written; `undoReply` takes back what was written.
 */
export async function writeAgentReply(options: WriteReplyOptions): Promise<WrittenReply> {
  const { agent, state, reply } = options;
  let target: RequestPlace;
  let created = false;
  if (options.place) {
    target = options.place;
    await clearReply(target.directory);
  } else {
    target = await makeReplyDirectory(options.directory, agent, options.at, async () => {});
    created = true;
  }
  const here = target.directory;
  try {
    const files = reply.sections.map((section, index) => ({ name: sectionFileName(index, section.title), section }));
    let images: PlacedImage[] = [];
    let notTaken: ImageNotTaken[] = [];
    if (options.bring) {
      await mkdir(join(here, 'images'), { mode: 0o750 });
      ({ images, notTaken } = await options.bring(join(here, 'images'), `${target.path}/images`));
      if (images.length === 0) await rmdir(join(here, 'images'));
    }
    for (const { name: file, section } of files) await put(join(here, file), `# ${section.title}\n\n${section.body}\n`);
    await put(join(here, 'sources.json'), `${JSON.stringify(reply.sources, null, 2)}\n`);
    // Which shape it was put from is for the owner to look into, not for her: the README does not say.
    const result = { form: options.form ?? 'text', reply, ...(options.data !== undefined ? { data: options.data } : {}) };
    await put(join(here, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    await put(join(here, 'README.md'), readme({ agent, state, reply, files, images, notTaken, path: target.path, request: options.request }));
    return { path: target.path, directory: here, readme: `${target.path}/README.md`, created, images, notTaken };
  } catch (error) {
    await undoReply({ directory: here, created });
    throw error;
  }
}

/** Takes back a reply: its directory when it was made for it, or all but the request in its request's. */
export async function undoReply(written: { directory: string; created: boolean }): Promise<void> {
  if (written.created) await rm(written.directory, { recursive: true, force: true });
  else await clearReply(written.directory);
}

/** Removes everything in a request's directory but the request. */
async function clearReply(directory: string): Promise<void> {
  for (const entry of await readdir(directory)) {
    if (entry !== REQUEST_FILE) await rm(join(directory, entry), { recursive: true, force: true });
  }
}

/**
 * Makes a directory `<agent>/<time>-<mark>` with what `fill` writes into it. It is filled beside its place under a
 * name git leaves out and moved into place whole, so it is never seen half-written.
 */
async function makeReplyDirectory(directory: string, agent: string, at: number, fill: (temporary: string) => Promise<void>):
  Promise<RequestPlace> {
  const parent = join(directory, agent);
  await mkdir(parent, { recursive: true, mode: 0o750 });
  for (let attempt = 0; attempt < 16; attempt++) {
    const name = `${timeStamp(at)}-${randomBytes(2).toString('hex')}`;
    const final = join(parent, name);
    const temporary = `${final}.tmp`;
    try {
      await mkdir(temporary, { mode: 0o750 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try {
      await fill(temporary);
      try { await mkdir(final); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') { await rm(temporary, { recursive: true, force: true }); continue; }
        throw error;
      }
      // An empty directory is moved over, never a full one: the name was free a moment ago and is kept free here.
      await rename(temporary, final);
      return { path: `${AGENTS_PATH}/${agent}/${name}`, directory: final };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error(`no free name for a request of ${agent}`);
}

function readme(parts: {
  agent: string; state: ReplyState; reply: ReplyData; path: string; request: { text: string; askedAt: string } | undefined;
  files: { name: string; section: ReplySection }[]; images: PlacedImage[]; notTaken: ImageNotTaken[];
}): string {
  const { agent, state, reply, files, images, notTaken, request } = parts;
  const out = [`# ${agent} の返事`, '', `- 状態: ${state}（${STATE_WORDS[state]}）`, '', '## 頼んだこと', ''];
  if (request) {
    const lines = request.text.trim().split('\n');
    out.push(`- 頼んだ時刻: ${request.askedAt}`, '', ...lines.slice(0, REQUEST_HEAD_LINES).map(line => `> ${line}`));
    out.push('', `全文は ${REQUEST_FILE} にあります。`);
  } else out.push('頼んだことの記録はありません（記録が残る前の依頼です）。');
  out.push('', '## 要約', '', clampSummary(reply.summary) || '（要約はありません）', '', '## 節', '');
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

/** The lines of a request shown at the head of its reply's README. */
const REQUEST_HEAD_LINES = 3;

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

/** The time in UTC as `20260924T030000Z`. */
function timeStamp(at: number): string {
  return new Date(at).toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(/[-:]/g, '');
}
