import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Role, TaskState, type AgentCard, type Message, type Part, type Task } from '@a2a-js/sdk';
import { Client, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { A2AError, TaskNotFoundError } from '@a2a-js/sdk/errors';

/** How long one call to an agent may take. Sending returns at once (`returnImmediately`), so this is generous. */
export const DEFAULT_A2A_CALL_TIMEOUT_MS = 30_000;

/**
 * Why a call to an agent did not go through, in the few kinds the caller acts on differently:
 * - `no-token`: the token file could not be read, or is empty. Nothing was sent.
 * - `unavailable`: the agent could not be reached or did not answer in JSON-RPC (down, refused the token, timed out).
 * - `refused`: the agent answered with an error, such as a context it does not know.
 * - `not-found`: the agent does not know the task.
 * The message is for the server's log: it may carry an upstream reason, and never the token.
 */
export class A2ACallError extends Error {
  readonly kind: 'no-token' | 'unavailable' | 'refused' | 'not-found';
  constructor(kind: A2ACallError['kind'], message: string) {
    super(message);
    this.name = 'A2ACallError';
    this.kind = kind;
  }
}

/** A task as the server tracks it: still going, done with an answer, failed, or waiting for natsumi's answer. */
export type AgentTaskState = 'waiting' | 'completed' | 'failed' | 'input-required';

/** What a send started: a task to fetch later, or a message that is already the whole answer. */
export type SendResult =
  | { kind: 'task'; taskId: string; contextId: string; state: AgentTaskState; text: string }
  | { kind: 'message'; contextId: string; text: string };

/**
 * Where a task stands, and the text that goes with it: the answer, the failure, or the question. A finished task may
 * also hand back files, one artifact each; `files` is there only when it has some.
 */
export interface TaskView { state: AgentTaskState; text: string; files?: AgentFile[] }

/**
 * A file a finished task hands back: an artifact with a FilePart, which A2A 1.0 writes as `{ url, mediaType, filename }`
 * (the contract with fraction-agents). Only named here; `fetchFile` brings it.
 */
export interface AgentFile { uri: string; mediaType: string; name: string; description: string }

/**
 * Why a file could not be fetched:
 * - `elsewhere`: it is not at the agent's own origin, so it was not asked for, and the token went nowhere.
 * - `no-token`: the token file could not be read, or is empty.
 * - `unauthorized`: the agent refused the token (401 or 403).
 * - `not-found`: the agent does not have it, or no longer does (404).
 * - `too-large`: it is over the limit, by its Content-Length or as it arrived.
 * - `unavailable`: the agent could not be reached, answered otherwise, or took too long.
 */
export class AgentFileError extends Error {
  readonly kind: 'elsewhere' | 'no-token' | 'unauthorized' | 'not-found' | 'too-large' | 'unavailable';
  constructor(kind: AgentFileError['kind'], message: string) {
    super(message);
    this.name = 'AgentFileError';
    this.kind = kind;
  }
}

/** What natsumi's list of agents says about one of them (ADR 0036). */
export interface CardSummary {
  name: string;
  description: string;
  skills: { name: string; description: string; examples: string[] }[];
}

/** The calls the server makes to outside agents (ADR 0035). Tests stand a fake agent behind the real one. */
export interface A2AClient {
  send(url: string, input: { text: string; contextId?: string; taskId?: string }): Promise<SendResult>;
  getTask(url: string, taskId: string): Promise<TaskView>;
  card(url: string): Promise<CardSummary>;
  /** A file a task handed back, from the agent at `url` only, and no larger than `maxBytes`. */
  fetchFile(url: string, fileUri: string, maxBytes: number): Promise<Buffer>;
}

export interface SdkA2AClientOptions {
  /** Read afresh on every call: a projected token is replaced while the server runs (ADR 0033). */
  tokenFile: string;
  timeoutMs?: number;
  /** Replaces the global fetch. Tests use it to hold a call open. */
  fetch?: typeof fetch;
}

/**
 * A2A 1.0 over JSON-RPC through the official SDK (ADR 0025). The client is built on the URL in the config, never on
 * the one an Agent Card names: the card is fetched without authentication, and the token goes only where the owner
 * said it may.
 */
export class SdkA2AClient implements A2AClient {
  private readonly tokenFile: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;

  constructor(options: SdkA2AClientOptions) {
    this.tokenFile = options.tokenFile;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_A2A_CALL_TIMEOUT_MS;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async send(url: string, input: { text: string; contextId?: string; taskId?: string }): Promise<SendResult> {
    const message: Message = {
      messageId: randomUUID(), contextId: input.contextId ?? '', taskId: input.taskId ?? '', role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: input.text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    };
    const result = await this.call(url, (client, signal) => client.sendMessage({
      tenant: '', message, metadata: undefined,
      configuration: { acceptedOutputModes: ['text/plain'], taskPushNotificationConfig: undefined, returnImmediately: true },
    }, { signal }));
    if ('status' in result) return { kind: 'task', taskId: result.id, contextId: result.contextId, ...view(result) };
    return { kind: 'message', contextId: result.contextId, text: partsText(result.parts) };
  }

  async getTask(url: string, taskId: string): Promise<TaskView> {
    return view(await this.call(url, (client, signal) => client.getTask({ tenant: '', id: taskId }, { signal })));
  }

  async card(url: string): Promise<CardSummary> {
    const cardUrl = new URL('.well-known/agent-card.json', url.endsWith('/') ? url : `${url}/`);
    const body = await this.timed(async signal => {
      const response = await this.fetch(cardUrl, { headers: { accept: 'application/json' }, signal });
      if (!response.ok) throw new Error(`the Agent Card answered ${response.status}`);
      return await response.json() as unknown;
    });
    return summarizeCard(body);
  }

  async fetchFile(url: string, fileUri: string, maxBytes: number): Promise<Buffer> {
    let target: URL;
    try { target = new URL(fileUri); } catch { throw new AgentFileError('elsewhere', 'the file URI is not a URL'); }
    // The token goes only where the owner said it may: the origin of the configured URL, which serves the card too.
    if (target.origin !== new URL(url).origin) throw new AgentFileError('elsewhere', 'the file is not at the agent\'s origin');
    let token: string;
    try { token = await this.token(); } catch (error) { throw new AgentFileError('no-token', (error as Error).message); }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AgentFileError('unavailable', `no file within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.download(target, token, maxBytes, controller.signal), limit]);
    } catch (error) {
      if (error instanceof AgentFileError) throw error;
      throw new AgentFileError('unavailable', error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /** One GET, never redirected: a redirect could carry the token to another origin. */
  private async download(target: URL, token: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    const response = await this.fetch(target, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal });
    if (response.status === 401 || response.status === 403) throw new AgentFileError('unauthorized', `the agent answered ${response.status}`);
    if (response.status === 404) throw new AgentFileError('not-found', 'the agent answered 404');
    if (!response.ok || !response.body) throw new AgentFileError('unavailable', `the agent answered ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) throw new AgentFileError('too-large', `the file is ${length} bytes`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new AgentFileError('too-large', `the file is over ${maxBytes} bytes`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private async call<T>(url: string, run: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
    const token = await this.token();
    const authorized: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return this.fetch(input, { ...init, headers });
    };
    const card = cardFor(url);
    const transport = await new JsonRpcTransportFactory({ fetchImpl: authorized }).create(url, card);
    return this.timed(signal => run(new Client(transport, card), signal));
  }

  /** Runs one call under the time limit. A fetch that ignores the signal is still left behind at the limit. */
  private async timed<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new A2ACallError('unavailable', `no answer within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([run(controller.signal), limit]);
    } catch (error) {
      throw classify(error);
    } finally { clearTimeout(timer); }
  }

  private async token(): Promise<string> {
    let text: string;
    try { text = await readFile(this.tokenFile, 'utf8'); } catch { throw new A2ACallError('no-token', 'the token file cannot be read'); }
    const token = text.trim();
    if (token === '') throw new A2ACallError('no-token', 'the token file is empty');
    return token;
  }
}

/** The card the SDK is given to talk to `url`: the configured URL, over JSON-RPC 1.0, and nothing else from outside. */
function cardFor(url: string): AgentCard {
  return {
    name: '', description: '', version: '', provider: undefined, capabilities: undefined,
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    securitySchemes: {}, securityRequirements: [], defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [], signatures: [],
  };
}

function classify(error: unknown): A2ACallError {
  if (error instanceof A2ACallError) return error;
  if (error instanceof TaskNotFoundError) return new A2ACallError('not-found', error.message);
  if (error instanceof A2AError) return new A2ACallError('refused', error.message);
  return new A2ACallError('unavailable', error instanceof Error ? error.message : String(error));
}

function view(task: Task): TaskView {
  const state = task.status?.state;
  const said = partsText(task.status?.message?.parts ?? []);
  if (state === TaskState.TASK_STATE_COMPLETED) {
    const answer = task.artifacts.map(artifact => partsText(artifact.parts)).filter(Boolean).join('\n\n');
    const files = task.artifacts.flatMap(artifact => artifact.parts.flatMap(part => part.content?.$case === 'url'
      ? [{ uri: part.content.value, mediaType: part.mediaType, name: part.filename, description: artifact.description }] : []));
    return { state: 'completed', text: answer || said, ...(files.length > 0 ? { files } : {}) };
  }
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED) return { state: 'input-required', text: said };
  if (state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_CANCELED || state === TaskState.TASK_STATE_REJECTED
    || state === TaskState.TASK_STATE_AUTH_REQUIRED) {
    return { state: 'failed', text: said };
  }
  return { state: 'waiting', text: '' };
}

/** The text of a message or an artifact. Files are brought separately (`fetchFile`), and data is not natsumi's to read. */
function partsText(parts: Part[]): string {
  return parts.map(part => part.content?.$case === 'text' ? part.content.value : '').filter(Boolean).join('\n');
}

/**
 * What the list needs from a card, read leniently from the JSON as served: a host may write parts of the card in
 * shapes the SDK's own parser disagrees with, and only three fields are wanted here.
 */
function summarizeCard(body: unknown): CardSummary {
  const card = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  const skills = Array.isArray(card.skills) ? card.skills : [];
  return {
    name: text(card.name),
    description: text(card.description),
    skills: skills.filter(skill => typeof skill === 'object' && skill !== null).map(skill => {
      const entry = skill as Record<string, unknown>;
      return { name: text(entry.name), description: text(entry.description),
        examples: Array.isArray(entry.examples) ? entry.examples.map(text).filter(Boolean) : [] };
    }),
  };
}
