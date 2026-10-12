import { EXPRESSIONS, type Expression } from './loop-tools.ts';

/**
 * What natsumi writes to the dove in `ask_agent` (ADR 0074): one JSON object, read here before a word of it is judged
 * or sent. Anything out of shape is turned back with a sentence that names the field and says what to fix; the checks
 * are written by hand so that each says that much (a schema would only say that it does not fit).
 *
 * ```json
 * {"kind":"post","to":{"file":"/sources/slack/work/dev/2026-09-25.jsonl","path":".[12]"},"face":"happy","text":"…"}
 * ```
 *
 * `to` names where it goes as she reads it (ADR 0050): a channel's directory, or a day's file and the `jq -s` path of
 * the message's line. Whether it is there is the record's to say. `images` names images under /work (ADR 0044); where
 * they are and what they are are checked when they are taken.
 */

/** Where a request goes, as natsumi copies it from an attention or a line of the record. */
export interface DoveTarget {
  file: string;
  /** The `jq -s` path of a message's line, `.[12]`. Absent for a channel. */
  path?: string;
}

export interface DoveRequest {
  kind: 'post' | 'reaction';
  to: DoveTarget;
  expression?: Expression;
  /** The draft, or for a reaction the emoji's name without colons. Empty only for a post of images alone. */
  body: string;
  /** The images to post with it, as the workspace names them, in the order written. Present only when there are some. */
  images?: string[];
}

export type ParsedRequest = { ok: true; request: DoveRequest } | { ok: false; text: string };

const FIELDS = ['kind', 'to', 'face', 'text', 'emoji', 'images'];
const MANUAL = '書き方は /manual/slack.md にあります。';
const LINE_PATH = /^\.\[(\d+)\]$/;

/** Reads a request, or says in one sentence why it cannot be taken. */
export function parseDoveRequest(message: string): ParsedRequest {
  const refuse = (text: string): ParsedRequest => ({ ok: false, text: `頼んでいません。${text}` });
  let value: unknown;
  try { value = JSON.parse(message); } catch {
    // The form before ADR 0074: headings, then `---` and the body.
    if (/^\s*(返信先|種類)\s*[:：]/m.test(message) || /^\s*---\s*$/m.test(message)) {
      return refuse(`見出し付きの書き方は使えなくなりました。message には JSON のオブジェクトを 1 つ書いてください。${MANUAL}`);
    }
    return refuse(`message が JSON として読めません。JSON のオブジェクトを 1 つだけ書いてください。${MANUAL}`);
  }
  if (!isRecord(value)) return refuse(`message は JSON のオブジェクト（{ … }）で書いてください。${MANUAL}`);
  const unknown = Object.keys(value).filter(key => !FIELDS.includes(key));
  if (unknown.length > 0) return refuse(`「${unknown[0]}」という欄はありません。使える欄は ${FIELDS.join('・')} です。`);

  const { kind, to, face, text, emoji, images } = value;
  if (kind === undefined) return refuse('kind がありません。投稿なら "post"、リアクションなら "reaction" を書いてください。');
  if (kind !== 'post' && kind !== 'reaction') {
    return refuse(`kind の「${String(kind)}」は使えません。投稿なら "post"、リアクションなら "reaction" を書いてください。`);
  }
  const target = parseTarget(to);
  if (typeof target === 'string') return refuse(target);
  if (face !== undefined && (typeof face !== 'string' || !(EXPRESSIONS as readonly string[]).includes(face))) {
    return refuse(`face の「${String(face)}」は使えません。${EXPRESSIONS.join('・')} のどれかを書くか、欄ごと省いてください。`);
  }
  const expression = face as Expression | undefined;

  if (kind === 'reaction') {
    for (const [name, field] of [['text', text], ['images', images], ['face', face]] as const) {
      if (field !== undefined) return refuse(`リアクションに ${name} は書けません。絵文字の名前を emoji に書くだけです。投稿するなら kind を "post" にしてください。`);
    }
    if (target.path === undefined) {
      return refuse('リアクションは発言に付けます。to には、発言のある日のファイル（file）と、その行の場所（path、例: ".[12]"）を書いてください。');
    }
    if (typeof emoji !== 'string' || emoji.trim() === '') return refuse('emoji に、付ける絵文字の名前を書いてください（例: "+1"）。');
    const name = emoji.trim().replace(/^:(.*):$/, '$1');
    // Whether it exists is the dove's to say (ADR 0042); here only that it is one name, with a skin tone at most.
    if (!/^[^\s:]+(?:::skin-tone-\d)?$/u.test(name)) return refuse('emoji には、絵文字の名前を 1 つだけ書いてください（例: "+1"）。');
    return { ok: true, request: { kind, to: target, body: name } };
  }

  if (emoji !== undefined) return refuse('投稿に emoji は書けません。リアクションなら kind を "reaction" にしてください。');
  if (text !== undefined && typeof text !== 'string') return refuse('text は文字列で書いてください。');
  const named = parseImages(images);
  if (typeof named === 'string') return refuse(named);
  const body = text ?? '';
  if (body.trim() === '' && named.length === 0) {
    return refuse('text に本文がありません（画像だけを投稿するなら、images に画像のパスを書きます）。');
  }
  return { ok: true, request: { kind, to: target, ...(expression ? { expression } : {}), body: body.trim() === '' ? '' : body,
    ...(named.length > 0 ? { images: named } : {}) } };
}

/** `to`, or a string saying what is wrong with it. Whether it names anything the record has is not known here. */
function parseTarget(to: unknown): DoveTarget | string {
  const form = 'to は {"file": "…"} の形で書きます。チャンネルに投稿するなら file にチャンネルのディレクトリ（例: "/sources/slack/work/dev"）を、'
    + '発言に返すなら file にその日のファイル、path に行の場所（例: ".[12]"）を書きます。';
  if (to === undefined) return `to がありません。${form}`;
  if (!isRecord(to)) return `to が読めません。${form}`;
  const unknown = Object.keys(to).filter(key => key !== 'file' && key !== 'path');
  if (unknown.length > 0) return `to に「${unknown[0]}」という欄はありません。to に書けるのは file と path だけです。`;
  if (typeof to.file !== 'string' || to.file.trim() === '') return `to.file がありません。${form}`;
  if (to.path === undefined) return { file: to.file };
  if (typeof to.path !== 'string' || !LINE_PATH.test(to.path.trim())) {
    return 'to.path は、発言の行の場所を ".[12]" の形で書いてください（出来事の attention の path を、そのまま写せます）。';
  }
  return { file: to.file, path: to.path.trim() };
}

/** The images named, or a string saying what is wrong with them. */
function parseImages(images: unknown): string[] | string {
  if (images === undefined) return [];
  if (!Array.isArray(images)) return 'images は、画像のパスの並び（例: ["/work/images/cat.png"]）で書いてください。';
  const named: string[] = [];
  for (const image of images) {
    if (typeof image !== 'string' || image.trim() === '') return 'images に空のものがあります。1 つずつ画像のパスを書いてください。';
    if (!image.startsWith('/')) return `画像「${image}」は /work/ から始まる絶対パスで書いてください。`;
    named.push(image);
  }
  return named;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
