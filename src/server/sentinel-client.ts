import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createInterface } from 'node:readline';

/**
 * The server's side of the sentinel's approvals socket (ADR 0096): HTTP/1.1 over the Unix socket the config names, JSON
 * in and out, as natsumi-sentinel's `docs/approvals-api.md` ("承認を受け付ける口") sets it. The sentinel's ledger is the
 * one record of the approvals and grants; this asks it every time and keeps nothing.
 *
 * What comes back is the sentinel's, and is read as data: every field is checked for its type, and a value of another
 * type is left out rather than shown. Its words — the summary, the labels, a pull request's title in a parameter — are
 * for the pages to show as plain text.
 *
 * Only the watcher (`sentinel.ts`), the dashboard and the composition take this; the thinking loop is given nothing that
 * reaches it, so the model has no way to answer an approval (ADR 0096).
 */

/** A request the socket answered with: its value, or the sentinel's refusal and its words; or no answer at all. */
export type SentinelResult<T> = { kind: 'ok'; value: T } | { kind: 'refused'; status: number; error: string } | { kind: 'unreachable' };

export interface SentinelBody { text: string; size: number; sha256: string; truncated: boolean; binary: boolean }
export interface SentinelParam { name: string; value: string }
/** One item of an approval: the facts of a request asked, or of one operation asked for beforehand. */
export interface SentinelItem {
  destination: string;
  method?: string;
  path?: string;
  query?: string;
  operation?: string;
  params: SentinelParam[];
  target: string[];
  targetText?: string;
  body?: SentinelBody;
}
export interface SentinelChoice { id: string; scope: string; seconds: number; label: string }
export interface SentinelApproval {
  id: string;
  kind: string;
  state: string;
  source: string;
  created: string;
  expires: string;
  summary: string;
  items: SentinelItem[];
  choices: SentinelChoice[];
  requests: number;
  answered?: string;
  choice?: string;
  grants: string[];
}
export interface SentinelGrant {
  id: string;
  approval: string;
  source: string;
  scope: string;
  created: string;
  expires?: string;
  summary: string;
  destination?: string;
  operation?: string;
  target?: string;
  method?: string;
  path?: string;
}
/** One of the sentinel's records: its id and time, and its other fields as they came, each a string, number or flag. */
export interface SentinelRecord {
  id: number;
  time: string;
  kind: string;
  fields: Record<string, string | number | boolean>;
  request?: SentinelBody;
  dnsAnswer?: string[];
}
export type SentinelEvent =
  | { type: 'hello' }
  | { type: 'ping' }
  | { type: 'approval.created' | 'approval.closed'; approval: SentinelApproval };

/** The sentinel's own limit of a list; every open approval fits in one. */
export const MAX_LIST = 1000;
const REQUEST_TIMEOUT_MS = 10_000;
/** More than any page of records at its limit; an answer past it is not read. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** One line of the events at most: one approval with its items. */
const MAX_EVENT_LINE_CHARS = 4 * 1024 * 1024;

export interface SentinelClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export class SentinelClient {
  private readonly options: SentinelClientOptions;

  constructor(options: SentinelClientOptions) {
    this.options = options;
  }

  /** The approvals of a state (by default the open ones, oldest first), as many as the sentinel lists at once. */
  async approvals(query: { state?: 'open' | 'all' } = {}): Promise<SentinelResult<SentinelApproval[]>> {
    const answer = await this.call('GET', `/v1/approvals?state=${query.state ?? 'open'}&limit=${MAX_LIST}`);
    return mapOk(answer, value => listOf(value, 'approvals', readApproval));
  }

  async approval(id: string): Promise<SentinelResult<SentinelApproval>> {
    return mapOk(await this.call('GET', `/v1/approvals/${encodeURIComponent(id)}`), readApproval);
  }

  /** The owner's answer, as the sentinel takes it: a choice only with `allow`. A second answer is the sentinel's to refuse. */
  async answer(id: string, answer: { answer: 'allow'; choice: string } | { answer: 'deny' }): Promise<SentinelResult<SentinelApproval>> {
    const body = answer.answer === 'allow' ? { answer: 'allow', choice: answer.choice } : { answer: 'deny' };
    return mapOk(await this.call('POST', `/v1/approvals/${encodeURIComponent(id)}/answer`, body), readApproval);
  }

  /** The grants in force, oldest first. */
  async grants(): Promise<SentinelResult<SentinelGrant[]>> {
    return mapOk(await this.call('GET', '/v1/grants'), value => listOf(value, 'grants', readGrant));
  }

  async revoke(id: string): Promise<SentinelResult<SentinelGrant>> {
    return mapOk(await this.call('DELETE', `/v1/grants/${encodeURIComponent(id)}`), value => readGrant(field(value, 'revoked')));
  }

  /** A page of the records, newest first, from before the id given; `next` is where the page after it starts. */
  async records(query: { before?: number; limit?: number } = {}): Promise<SentinelResult<{ records: SentinelRecord[]; next?: number }>> {
    const params = new URLSearchParams();
    if (query.before !== undefined) params.set('before', String(query.before));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const search = params.size > 0 ? `?${params}` : '';
    return mapOk(await this.call('GET', `/v1/records${search}`), value => {
      const records = listOf(value, 'records', readRecord);
      const next = field(value, 'next');
      return records && { records, ...(isId(next) ? { next } : {}) };
    });
  }

  async record(id: number): Promise<SentinelResult<SentinelRecord>> {
    return mapOk(await this.call('GET', `/v1/records/${id}`), readRecord);
  }

  /**
   * Opens the stream of events. Each line is read as it comes; a line that is not JSON, of a type not known, or with an
   * approval that cannot be read, is passed over. The iteration ends when the stream does, or the signal is aborted.
   */
  async events(signal: AbortSignal): Promise<SentinelResult<AsyncIterable<SentinelEvent>>> {
    const opened = await this.open('GET', '/v1/events', undefined, signal);
    if (opened.kind === 'unreachable') return opened;
    const { response } = opened;
    if (response.statusCode !== 200) return refusal(response.statusCode ?? 0, await readAll(response).catch(() => undefined));
    return { kind: 'ok', value: readEvents(response) };
  }

  private async call(method: string, path: string, body?: unknown): Promise<SentinelResult<unknown>> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const opened = await this.open(method, path, body, timeout);
    if (opened.kind === 'unreachable') return opened;
    let text: string | undefined;
    try { text = await readAll(opened.response); } catch { return { kind: 'unreachable' }; }
    const status = opened.response.statusCode ?? 0;
    if (status < 200 || status >= 300) return refusal(status, text);
    try { return { kind: 'ok', value: JSON.parse(text ?? '') as unknown }; } catch { return { kind: 'refused', status: 502, error: 'the sentinel\'s answer was not JSON' }; }
  }

  private open(method: string, path: string, body: unknown, signal: AbortSignal):
    Promise<{ kind: 'response'; response: IncomingMessage } | { kind: 'unreachable' }> {
    return new Promise(resolve => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const request = httpRequest({
        socketPath: this.options.socketPath, method, path, signal,
        headers: { host: 'sentinel', accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
      }, response => { resolve({ kind: 'response', response }); });
      request.on('error', () => { resolve({ kind: 'unreachable' }); });
      request.end(payload);
    });
  }
}

function refusal(status: number, text: string | undefined): SentinelResult<never> {
  let error = '';
  try {
    const parsed = JSON.parse(text ?? '') as unknown;
    const words = field(parsed, 'error');
    if (typeof words === 'string') error = words;
  } catch { /* no words of its own */ }
  return { kind: 'refused', status, error };
}

function mapOk<T>(result: SentinelResult<unknown>, read: (value: unknown) => T | undefined): SentinelResult<T> {
  if (result.kind !== 'ok') return result;
  const value = read(result.value);
  return value === undefined ? { kind: 'refused', status: 502, error: 'the sentinel\'s answer was not of the shape expected' } : { kind: 'ok', value };
}

async function readAll(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += (chunk as Buffer).length;
    if (size > MAX_RESPONSE_BYTES) {
      response.destroy();
      throw new Error('too large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function* readEvents(response: IncomingMessage): AsyncIterable<SentinelEvent> {
  const lines = createInterface({ input: response, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > MAX_EVENT_LINE_CHARS) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      const type = field(parsed, 'type');
      if (type === 'hello' || type === 'ping') yield { type };
      else if (type === 'approval.created' || type === 'approval.closed') {
        const approval = readApproval(field(parsed, 'approval'));
        if (approval) yield { type, approval };
      }
    }
  } catch { /* the stream was cut; the iteration ends */ } finally {
    lines.close();
    response.destroy();
  }
}

// Reading the sentinel's JSON. A required field of the wrong type makes the whole thing unreadable; an optional one is
// left out.

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined || value === '' ? {} : { [key]: value }) as { [P in K]?: string };
}

function listOf<T>(value: unknown, key: string, read: (item: unknown) => T | undefined): T[] | undefined {
  const list = field(value, key);
  if (!Array.isArray(list)) return undefined;
  return list.flatMap(item => read(item) ?? []);
}

function readBody(value: unknown): SentinelBody | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return {
    text: text(field(value, 'text')) ?? '', size: count(field(value, 'size')) ?? 0, sha256: text(field(value, 'sha256')) ?? '',
    truncated: field(value, 'truncated') === true, binary: field(value, 'binary') === true,
  };
}

function readItem(value: unknown): SentinelItem | undefined {
  const destination = text(field(value, 'destination'));
  if (destination === undefined) return undefined;
  const params = Array.isArray(field(value, 'params')) ? (field(value, 'params') as unknown[]).flatMap(param => {
    const name = text(field(param, 'name'));
    const paramValue = text(field(param, 'value'));
    return name === undefined || paramValue === undefined ? [] : [{ name, value: paramValue }];
  }) : [];
  const body = readBody(field(value, 'body'));
  return {
    destination, ...optional('method', text(field(value, 'method'))), ...optional('path', text(field(value, 'path'))),
    ...optional('query', text(field(value, 'query'))), ...optional('operation', text(field(value, 'operation'))),
    params, target: texts(field(value, 'target')), ...optional('targetText', text(field(value, 'targetText'))), ...(body ? { body } : {}),
  };
}

function readChoice(value: unknown): SentinelChoice | undefined {
  const id = text(field(value, 'id'));
  const scope = text(field(value, 'scope'));
  const label = text(field(value, 'label'));
  if (id === undefined || scope === undefined || label === undefined) return undefined;
  return { id, scope, seconds: count(field(value, 'seconds')) ?? 0, label };
}

function readApproval(value: unknown): SentinelApproval | undefined {
  const id = text(field(value, 'id'));
  const kind = text(field(value, 'kind'));
  const state = text(field(value, 'state'));
  if (id === undefined || kind === undefined || state === undefined || !APPROVAL_ID.test(id)) return undefined;
  const items = field(value, 'items');
  const choices = field(value, 'choices');
  return {
    id, kind, state, source: text(field(value, 'source')) ?? '', created: text(field(value, 'created')) ?? '',
    expires: text(field(value, 'expires')) ?? '', summary: text(field(value, 'summary')) ?? '',
    items: Array.isArray(items) ? items.flatMap(item => readItem(item) ?? []) : [],
    choices: Array.isArray(choices) ? choices.flatMap(choice => readChoice(choice) ?? []) : [],
    requests: count(field(value, 'requests')) ?? 0, ...optional('answered', text(field(value, 'answered'))),
    ...optional('choice', text(field(value, 'choice'))), grants: texts(field(value, 'grants')),
  };
}

function readGrant(value: unknown): SentinelGrant | undefined {
  const id = text(field(value, 'id'));
  if (id === undefined || !GRANT_ID.test(id)) return undefined;
  return {
    id, approval: text(field(value, 'approval')) ?? '', source: text(field(value, 'source')) ?? '', scope: text(field(value, 'scope')) ?? '',
    created: text(field(value, 'created')) ?? '', ...optional('expires', text(field(value, 'expires'))), summary: text(field(value, 'summary')) ?? '',
    ...optional('destination', text(field(value, 'destination'))), ...optional('operation', text(field(value, 'operation'))),
    ...optional('target', text(field(value, 'target'))), ...optional('method', text(field(value, 'method'))),
    ...optional('path', text(field(value, 'path'))),
  };
}

function readRecord(value: unknown): SentinelRecord | undefined {
  const id = field(value, 'id');
  if (!isId(id)) return undefined;
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'id' || key === 'request' || key === 'dnsAnswer') continue;
    if (typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) fields[key] = item;
  }
  const request = readBody(field(value, 'request'));
  const dnsAnswer = field(value, 'dnsAnswer');
  return {
    id, time: text(field(value, 'time')) ?? '', kind: text(field(value, 'kind')) ?? '', fields, ...(request ? { request } : {}),
    ...(Array.isArray(dnsAnswer) ? { dnsAnswer: texts(dnsAnswer) } : {}),
  };
}

/**
 * The ids as the sentinel makes them, and nothing else: an id goes into a path of the socket, a file name under
 * /sources and a link of the dashboard, so one that is not of this shape is not read at all.
 */
export const APPROVAL_ID = /^ap-[A-Za-z0-9_-]{1,100}$/;
export const GRANT_ID = /^gr-[A-Za-z0-9_-]{1,100}$/;
