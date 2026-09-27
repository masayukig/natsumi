import { EXPRESSIONS, type Expression } from './loop-tools.ts';

/**
 * What natsumi writes to the dove in `ask_agent` (ADR 0039, ADR 0040): a few `見出し: 値` lines, then `---` and the
 * body. The server reads it here and turns back anything out of shape before a word of it is judged or sent, with a
 * sentence that says what to fix.
 *
 * ```
 * 返信先: work/#dev 2026-09-25 14:32:05 山田
 * 種類: 投稿
 * 表情: happy
 * 画像: /work/images/cat.png
 * ---
 * 本文（リアクションなら絵文字の名前。画像があれば省ける）
 * ```
 *
 * `画像` names an image under /work, one line each (ADR 0044); where it is and what it is are checked when it is taken.
 */

/** A message or a channel as natsumi names it: never by a Slack ID (ADR 0024). */
export interface ParsedReference {
  workspace: string;
  /** `#dev`, or `@name` for a DM. */
  channel: string;
  /** Present when a message is meant: its local date and time to the second. */
  at?: { date: string; time: string };
  speaker?: string;
  /** How the message begins, `「…」` after the speaker: what tells apart two messages of the same second and speaker. */
  begins?: string;
}

export interface DoveRequest {
  target: ParsedReference;
  kind: 'post' | 'reaction';
  expression?: Expression;
  /** The draft, or for a reaction the emoji's name without colons. Empty only for a post of images alone. */
  body: string;
  /** The images to post with it, as the workspace names them, in the order written. Present only when there are some. */
  images?: string[];
}

export type ParsedRequest = { ok: true; request: DoveRequest } | { ok: false; text: string };

const KINDS: Record<string, DoveRequest['kind']> = { 投稿: 'post', リアクション: 'reaction' };
const HEADINGS = ['返信先', '種類', '表情', '画像'];
/** The heading that may be written more than once, one image per line. */
const IMAGE = '画像';
const FORM = '返信先・種類（・表情・画像）の見出しを 1 行ずつ書き、`---` の行の後に本文を書いてください。書き方は /manual/slack.md にあります。';
const REFERENCE = /^([^\s/]+)\/([#@][^\s]+)(?:\s+(\S+)(?:\s+(\S+)(?:\s+(.+))?)?)?$/;

/** Reads a request, or says in one sentence why it cannot be taken. */
export function parseDoveRequest(message: string): ParsedRequest {
  const refuse = (text: string): ParsedRequest => ({ ok: false, text: `頼んでいません。${text}` });
  const lines = message.replace(/\r\n?/g, '\n').split('\n');
  const separator = lines.findIndex(line => line.trim() === '---');
  if (separator < 0) return refuse(`\`---\` の行がありません。${FORM}`);
  const headings = new Map<string, string>();
  const images: string[] = [];
  for (const line of lines.slice(0, separator)) {
    if (line.trim() === '') continue;
    const match = /^\s*([^:：]+?)\s*[:：]\s*(.*?)\s*$/.exec(line);
    if (!match) return refuse(`見出しの行「${line.trim()}」が「見出し: 値」の形ではありません。${FORM}`);
    const [, name, value] = match as unknown as [string, string, string];
    if (!HEADINGS.includes(name)) return refuse(`「${name}」という見出しはありません。使える見出しは ${HEADINGS.join('・')} です。`);
    if (name === IMAGE) {
      if (value === '') return refuse('見出し「画像」にパスがありません。`画像: /work/images/cat.png` のように、1 行に 1 枚ずつ書いてください。');
      if (!value.startsWith('/')) return refuse(`画像「${value}」は /work/ から始まる絶対パスで書いてください。`);
      images.push(value);
      continue;
    }
    if (headings.has(name)) return refuse(`見出し「${name}」が 2 回あります。1 回だけ書いてください。`);
    headings.set(name, value);
  }
  const reference = headings.get('返信先');
  if (!reference) return refuse(`見出し「返信先」がありません。${FORM}`);
  const target = parseReference(reference);
  if (typeof target === 'string') return refuse(target);
  const kindText = headings.get('種類');
  if (!kindText) return refuse(`見出し「種類」がありません。投稿かリアクションかを書いてください。`);
  const kind = KINDS[kindText];
  if (!kind) return refuse(`種類「${kindText}」は使えません。投稿かリアクションのどちらかを書いてください。`);
  const expressionText = headings.get('表情');
  if (expressionText !== undefined && !(EXPRESSIONS as readonly string[]).includes(expressionText)) {
    return refuse(`表情「${expressionText}」は使えません。${EXPRESSIONS.join('・')} のどれかを書くか、見出しごと省いてください。`);
  }
  const expression = expressionText as Expression | undefined;
  const body = lines.slice(separator + 1).join('\n').replace(/^\n+|\s+$/g, '');
  if (kind === 'reaction' && images.length > 0) return refuse('リアクションに画像は付けられません。画像を投稿するなら、種類を投稿にしてください。');
  if (body.trim() === '' && images.length === 0) {
    return refuse(kind === 'reaction' ? '`---` の後に絵文字の名前がありません。' : '`---` の後に本文がありません（画像だけを投稿するなら、見出し「画像」を書きます）。');
  }
  if (kind === 'reaction') {
    if (!target.at) return refuse('リアクションは発言に付けます。返信先には発言の参照（例: work/#dev 2026-09-25 14:32:05 山田）を書いてください。');
    const emoji = body.trim().replace(/^:(.*):$/, '$1');
    // Whether it exists is the dove's to say (ADR 0042); here only that it is one name, with a skin tone at most.
    if (!/^[^\s:]+(?:::skin-tone-\d)?$/u.test(emoji)) return refuse('リアクションの本文には、絵文字の名前を 1 つだけ書いてください（例: +1）。');
    return { ok: true, request: { target, kind, ...(expression ? { expression } : {}), body: emoji } };
  }
  return { ok: true, request: { target, kind, ...(expression ? { expression } : {}), body: body.trim() === '' ? '' : body,
    ...(images.length > 0 ? { images } : {}) } };
}

/**
 * `work/#dev`, or `work/#dev 2026-09-25 14:32:05 山田`: a string when it cannot be read, saying what is wrong with it.
 */
export function parseReference(text: string): ParsedReference | string {
  const example = '発言は `work/#dev 2026-09-25 14:32:05 山田`、チャンネルそのものは `work/#dev` の形で書きます（ファイルの行の at と from を並べて書きます）。';
  const match = REFERENCE.exec(text.trim());
  if (!match) return `返信先「${text}」を読めません。${example}`;
  const [, workspace, channel, date, time, speaker] = match as unknown as [string, string, string, string?, string?, string?];
  if (date === undefined) return { workspace, channel };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `返信先の日付「${date}」は YYYY-MM-DD の形で書いてください。${example}`;
  if (time === undefined || !/^\d{2}:\d{2}:\d{2}$/.test(time)) return `返信先の時刻は秒まで（HH:MM:SS）書いてください。${example}`;
  if (!speaker) return `返信先に発言者がありません。${example}`;
  const quoted = /^(.*?)\s+「(.+)」$/.exec(speaker.trim());
  if (quoted) return { workspace, channel, at: { date, time }, speaker: quoted[1]!.trim(), begins: quoted[2]! };
  return { workspace, channel, at: { date, time }, speaker: speaker.trim() };
}
