import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentCard, Role, TaskState, type Message, type Part, type Task } from '@a2a-js/sdk';
import { ContentTypeNotSupportedError, PushNotificationNotSupportedError, RequestMalformedError, TaskNotFoundError,
  UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { JsonRpcTransportHandler, ServerCallContext, validateVersion, type A2ARequestHandler, type User } from '@a2a-js/sdk/server';
import { ASSERTION_HEADER, type AssertionResult } from './gated-assertion.ts';
import { InboxRefusal, type Inbox, type InboxMessage, type InboxState, type InboxTask } from './inbox.ts';

/**
 * natsumi's way in over A2A (ADR 0089), under `/a2a/` of the listener the browser uses: the Agent Card, served without a
 * token, and SendMessage and GetTask over JSON-RPC, in the SDK and version `ask_agent` speaks. A caller is a sender only
 * by its own bearer token or gated's assertion of its subject; anything else, the browser's cookie included, is the same
 * 401, and the name is the one the check gave. CancelTask, streaming and push are not served. What is asked is the
 * inbox's to keep; this only checks who asks and writes the tasks in A2A's shape.
 */

/** Where the way in is, as the listener routes it. */
export const A2A_PATH = '/a2a';
const CALLS_PATH = `${A2A_PATH}/`;
const CARD_PATH = `${A2A_PATH}/.well-known/agent-card.json`;
/** A call's body at most: room for 1 MiB of text however JSON writes it. The text itself is held to 1 MiB by the inbox. */
export const MAX_A2A_BODY_BYTES = 2 * 1024 * 1024;
const VERSION_HEADER = 'a2a-version';
/** The calls that would stream, which the SDK answers as a stream; refused before it, so the answer is one JSON body. */
const STREAMING_METHODS = new Set(['SendStreamingMessage', 'SubscribeToTask']);

/** Who sent a call, by the check of its headers alone, or undefined for anyone else. */
export type SenderCheck = (request: IncomingMessage) => Promise<string | undefined>;

/**
 * The senders' check: gated's assertion of a declared subject, when gated is configured and the call carries one, and
 * otherwise a declared bearer token. Every token is compared by its digest, in a time that does not depend on which
 * matches or where they differ.
 */
export function inboxSenders(options: {
  tokens: ReadonlyMap<string, string>;
  subjects: ReadonlyMap<string, string>;
  verifier?: { verify(assertion: string | undefined): Promise<AssertionResult> };
}): SenderCheck {
  const digests = [...options.tokens].map(([name, token]) => [name, digest(token)] as const);
  return async request => {
    const assertion = request.headers[ASSERTION_HEADER];
    // gated puts its assertion in place of the token it took; with gated in front, the assertion alone decides.
    if (options.verifier && assertion !== undefined) {
      const result = await options.verifier.verify(typeof assertion === 'string' ? assertion : undefined);
      return result.ok ? options.subjects.get(result.subject) : undefined;
    }
    const token = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(request.headers.authorization ?? '')?.[1];
    if (token === undefined) return undefined;
    const presented = digest(token);
    let found: string | undefined;
    for (const [name, expected] of digests) if (timingSafeEqual(presented, expected)) found ??= name;
    return found;
  };
}

export interface InboxEndpointOptions {
  /** The way in as the senders reach it, ending in `/a2a/`. The card names it. */
  publicUrl: string;
  card: { name: string; description: string };
  inbox: Pick<Inbox, 'receive' | 'task'>;
  senders: SenderCheck;
  log?: (line: string) => void;
}

export class InboxEndpoint {
  private readonly options: InboxEndpointOptions;
  private readonly card: AgentCard;
  private readonly cardJson: string;
  private readonly transport: JsonRpcTransportHandler;

  constructor(options: InboxEndpointOptions) {
    this.options = options;
    this.card = buildCard(options.publicUrl, options.card);
    this.cardJson = JSON.stringify(cardJson(this.card));
    this.transport = new JsonRpcTransportHandler(new InboxRequests(options.inbox, this.card));
  }

  /** Whether a path is under the way in. Without senders the listener lets it be not found, as any other. */
  static owns(pathname: string): boolean { return pathname === A2A_PATH || pathname.startsWith(CALLS_PATH); }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? 'GET';
    if (method === 'GET' && url.pathname === CARD_PATH) {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }).end(this.cardJson);
      return;
    }
    if (method !== 'POST' || (url.pathname !== CALLS_PATH && url.pathname !== A2A_PATH)) return json(response, 404, { error: 'not-found' });
    const sender = await this.options.senders(request);
    if (!sender) {
      this.log('a call was refused (unauthorized)');
      response.setHeader('connection', 'close');
      return json(response, 401, { error: 'unauthorized' });
    }
    if (Number(request.headers['content-length'] ?? 0) > MAX_A2A_BODY_BYTES) return tooLarge(response);
    const body = await readBody(request, MAX_A2A_BODY_BYTES);
    if (body === undefined) return tooLarge(response);
    let call: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body.toString('utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      call = parsed as Record<string, unknown>;
    } catch {
      return json(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON payload.' } });
    }
    const id = call.id ?? null;
    const failure = (error: unknown) => ({ jsonrpc: '2.0', id, error: JsonRpcTransportHandler.mapToJSONRPCError(error) });
    if (typeof call.method === 'string' && STREAMING_METHODS.has(call.method)) {
      return json(response, 200, failure(new UnsupportedOperationError('this agent does not stream; send the message and get the task')));
    }
    const header = request.headers[VERSION_HEADER];
    const context = new ServerCallContext({ user: new Sender(sender), ...(typeof header === 'string' && header ? { requestedVersion: header } : {}) });
    try {
      validateVersion(context.requestedVersion, this.card, 'JSONRPC');
      json(response, 200, await this.transport.handle(call, context) as unknown as Record<string, unknown>);
    } catch (error) {
      const answer = failure(error);
      this.log(`a call of ${sender} failed (${answer.error.code})`);
      json(response, answer.error.code === -32603 ? 500 : 200, answer);
    }
  }

  private log(line: string): void { this.options.log?.(`a2a-inbox: ${line}`); }
}

class Sender implements User {
  private readonly name: string;
  constructor(name: string) { this.name = name; }
  get isAuthenticated(): boolean { return true; }
  get userName(): string { return this.name; }
}

/** The calls served, onto the inbox; the rest are refused as not supported. */
class InboxRequests implements A2ARequestHandler {
  private readonly inbox: Pick<Inbox, 'receive' | 'task'>;
  private readonly card: AgentCard;

  constructor(inbox: Pick<Inbox, 'receive' | 'task'>, card: AgentCard) {
    this.inbox = inbox;
    this.card = card;
  }

  async getAgentCard(): Promise<AgentCard> { return this.card; }

  async sendMessage(params: Parameters<A2ARequestHandler['sendMessage']>[0], context: ServerCallContext): Promise<Message | Task> {
    const message = params.message;
    if (!message) throw new RequestMalformedError('the request has no message');
    // Text only, in the first version: a file or data would have to be judged before it could be put where she reads.
    if (message.parts.some(part => part.content?.$case !== 'text')) throw new ContentTypeNotSupportedError('only text parts are taken');
    const text = message.parts.map(part => part.content?.$case === 'text' ? part.content.value : '').join('\n');
    let task: InboxTask;
    try {
      task = await this.inbox.receive(context.user!.userName, { text, messageId: message.messageId || randomUUID(),
        ...(message.contextId ? { contextId: message.contextId } : {}), ...(message.taskId ? { taskId: message.taskId } : {}) });
    } catch (error) {
      throw refusal(error);
    }
    return toTask(task, params.configuration?.historyLength);
  }

  async getTask(params: Parameters<A2ARequestHandler['getTask']>[0], context: ServerCallContext): Promise<Task> {
    const task = this.inbox.task(context.user!.userName, params.id);
    if (!task) throw new TaskNotFoundError('no such task');
    return toTask(task, params.historyLength);
  }

  async getAuthenticatedExtendedAgentCard(): Promise<AgentCard> { throw new UnsupportedOperationError('there is no extended card'); }
  async *sendMessageStream(): AsyncGenerator<never, void, undefined> { throw new UnsupportedOperationError('this agent does not stream'); }
  async cancelTask(): Promise<Task> { throw new UnsupportedOperationError('a task is closed by her reply or its deadline, not cancelled'); }
  async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async deleteTaskPushNotificationConfig(): Promise<void> { throw new PushNotificationNotSupportedError(); }
  async *resubscribe(): AsyncGenerator<never, void, undefined> { throw new UnsupportedOperationError('this agent does not stream'); }
  async listTasks(): Promise<never> { throw new UnsupportedOperationError('tasks are not listed'); }
}

/** A refusal of the inbox as the error A2A has for it; anything else is the server's own failure, for the sender to try again. */
function refusal(error: unknown): unknown {
  if (!(error instanceof InboxRefusal)) return error;
  switch (error.kind) {
    case 'not-found': return new TaskNotFoundError(error.message);
    case 'not-waiting':
    case 'closed': return new UnsupportedOperationError(error.message);
    default: return new RequestMalformedError(error.message);
  }
}

const STATES: Record<InboxState, TaskState> = {
  'working': TaskState.TASK_STATE_WORKING,
  'input-required': TaskState.TASK_STATE_INPUT_REQUIRED,
  'completed': TaskState.TASK_STATE_COMPLETED,
  'failed': TaskState.TASK_STATE_FAILED,
  'rejected': TaskState.TASK_STATE_REJECTED,
};

/**
 * A task as A2A writes it: her question as the status's message while it asks, the reason while it failed or was
 * rejected, and her closing words as the artifact `response`, as the agents of fraction-agents hand back theirs. A task
 * closed with no words has no artifact. The history is every message, or the last `historyLength`.
 */
function toTask(task: InboxTask, historyLength: number | undefined): Task {
  const last = task.messages.at(-1);
  const hers = last?.author === 'me' ? last : undefined;
  const said = task.state === 'input-required' && hers ? toMessage(task, hers)
    : (task.state === 'failed' || task.state === 'rejected') && task.reason
      ? toMessage(task, { author: 'me', messageId: `${task.taskId}-status`, text: task.reason, at: task.updatedAt }) : undefined;
  const history = task.messages.map(message => toMessage(task, message));
  return {
    id: task.taskId, contextId: task.contextId,
    status: { state: STATES[task.state], message: said, timestamp: new Date(task.updatedAt).toISOString() },
    artifacts: task.state === 'completed' && hers ? [{ artifactId: `${task.taskId}-response`, name: 'response', description: '',
      parts: [textPart(hers.text)], metadata: undefined, extensions: [] }] : [],
    history: historyLength === undefined ? history : historyLength > 0 ? history.slice(-historyLength) : [],
    metadata: undefined,
  };
}

function toMessage(task: InboxTask, message: InboxMessage): Message {
  return {
    messageId: message.messageId, contextId: task.contextId, taskId: task.taskId, role: message.author === 'me' ? Role.ROLE_AGENT : Role.ROLE_USER,
    parts: [textPart(message.text)], metadata: undefined, extensions: [], referenceTaskIds: [],
  };
}

function textPart(text: string): Part {
  return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

/** The card: who she is from the config, JSON-RPC 1.0 at the public URL, a bearer as the way in, and text only. */
function buildCard(publicUrl: string, card: { name: string; description: string }): AgentCard {
  return {
    name: card.name, description: card.description, version: '1', provider: undefined,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    supportedInterfaces: [{ url: publicUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    securitySchemes: {
      bearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { scheme: 'Bearer', bearerFormat: '',
        description: 'The sender\'s own token, or a ServiceAccount token for gated in front of this host.' } } },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [], signatures: [],
  };
}

/**
 * The card as served. The SDK's own form writes unions with `$case`, so it is converted here; the scopes of a
 * requirement are a plain list, which a2a-cli reads and the SDK accepts (as fraction-agents serves its card).
 */
function cardJson(card: AgentCard): Record<string, unknown> {
  return {
    ...(AgentCard.toJSON(card) as Record<string, unknown>),
    securityRequirements: card.securityRequirements.map(requirement => ({
      schemes: Object.fromEntries(Object.entries(requirement.schemes).map(([name, scopes]) => [name, scopes.list])),
    })),
  };
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

function tooLarge(response: ServerResponse): void {
  response.setHeader('connection', 'close');
  json(response, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `The request is over ${MAX_A2A_BODY_BYTES} bytes.` } });
}

/** The body, or undefined as soon as it is past the limit. */
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function digest(text: string): Buffer { return createHash('sha256').update(text).digest(); }
