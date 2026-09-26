import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentCard, Role, TaskState, type Message, type Task } from '@a2a-js/sdk';
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { defaultServerCallContextBuilder, JsonRpcTransportHandler, type A2ARequestHandler } from '@a2a-js/sdk/server';

/** A message the agent received, as it arrived: who sent it, and where it was meant to go. */
export interface Received {
  authorization: string | undefined;
  text: string;
  /** Empty when the caller left it for the agent to number. */
  contextId: string;
  taskId: string;
  returnImmediately: boolean;
}

export type FakeTaskState = 'working' | 'completed' | 'failed' | 'input-required' | 'rejected';

const STATES: Record<FakeTaskState, TaskState> = {
  working: TaskState.TASK_STATE_WORKING,
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  'input-required': TaskState.TASK_STATE_INPUT_REQUIRED,
  rejected: TaskState.TASK_STATE_REJECTED,
};

export interface FakeAgentOptions {
  /** The bearer token the agent accepts. Anything else gets a 401, as the real host answers a failed TokenReview. */
  token?: string;
  name?: string;
  description?: string;
  skills?: { id: string; name: string; description: string; examples?: string[] }[];
  /** Answer with a message instead of a task, as an agent that replies at once may. */
  replyWithMessage?: string;
}

/**
 * A file a finished task hands back as an artifact of its own, with one FilePart (the contract with fraction-agents).
 * With `data` the agent serves it at `/artifacts/<ID>`, under the same token as the calls; `uri` points it elsewhere.
 */
export interface FakeFile {
  name: string;
  mimeType: string;
  description?: string;
  data?: Buffer;
  uri?: string;
}

/**
 * A stand-in for an agent of `yuanying/fraction-agents`, served through the SDK's own JSON-RPC handler so what goes
 * over the wire is the real protocol. It keeps the rules the real host has: contexts are numbered by the agent, a
 * contextId must be one it gave out, a taskId is accepted only on a task waiting for input, and one context runs
 * one task at a time. What a task becomes is up to the test (`settle`).
 */
export class FakeAgent {
  readonly received: Received[] = [];
  readonly tasks = new Map<string, Task>();
  /** Requests for the Agent Card, and whether each carried a token. */
  readonly cardRequests: (string | undefined)[] = [];
  /** GetTask calls, by task ID. */
  readonly polls: string[] = [];
  /** While set, every JSON-RPC call gets this HTTP status instead of an answer. */
  failWith: number | undefined;
  /** Requests for the files of artifacts, by ID, and the Authorization header each carried. */
  readonly fileRequests: { id: string; authorization: string | undefined }[] = [];
  /** While set, every request for a file gets this HTTP status instead of the file. */
  fileFailWith: number | undefined;
  /** Leaves Content-Length off the files, as a host streaming them might. */
  chunkedFiles = false;
  private readonly files = new Map<string, { data: Buffer; mimeType: string }>();
  token: string;
  private readonly options: FakeAgentOptions;
  private readonly server: Server;
  private readonly contexts = new Set<string>();
  private port = 0;
  /** The Authorization header of the call being handled. */
  private authorization: string | undefined;

  private constructor(options: FakeAgentOptions) {
    this.options = options;
    this.token = options.token ?? 'fake-agent-token';
    const handler = new JsonRpcTransportHandler(this.handler());
    this.server = createServer((request, response) => {
      void (async () => {
        const path = new URL(request.url ?? '/', 'http://fake').pathname;
        if (request.method === 'GET' && path === '/agent/.well-known/agent-card.json') {
          this.cardRequests.push(request.headers.authorization);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(AgentCard.toJSON(this.card())));
          return;
        }
        if (request.method === 'GET' && path.startsWith('/artifacts/')) {
          this.serveFile(path.slice('/artifacts/'.length), request.headers.authorization, response);
          return;
        }
        if (request.method !== 'POST' || (path !== '/agent/' && path !== '/agent')) {
          response.writeHead(404).end();
          return;
        }
        if (request.headers.authorization !== `Bearer ${this.token}`) {
          response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="a2a"' });
          response.end(JSON.stringify({ error: 'unauthenticated' }));
          return;
        }
        if (this.failWith) {
          response.writeHead(this.failWith).end();
          return;
        }
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        this.authorization = request.headers.authorization;
        const context = defaultServerCallContextBuilder({ extensions: undefined, user: undefined, headers: request.headers,
          requestedVersion: header(request, 'a2a-version') });
        let answer: unknown;
        try {
          answer = await handler.handle(body, context);
        } catch (error) {
          answer = { jsonrpc: '2.0', id: body.id ?? null, error: JsonRpcTransportHandler.mapToJSONRPCError(error) };
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer));
      })().catch(() => { if (!response.headersSent) response.writeHead(500).end(); });
    });
  }

  static async start(options: FakeAgentOptions = {}): Promise<FakeAgent> {
    const agent = new FakeAgent(options);
    await new Promise<void>(resolve => agent.server.listen(0, '127.0.0.1', resolve));
    agent.port = (agent.server.address() as AddressInfo).port;
    return agent;
  }

  /** Where the agent answers, as a config names it. */
  get url(): string { return `http://127.0.0.1:${this.port}/agent/`; }

  /** Where the agent serves the file of an artifact with this ID. */
  fileUrl(id: string): string { return `http://127.0.0.1:${this.port}/artifacts/${id}`; }

  /**
   * Moves a task on, as the agent's work would. `text` is the answer, the failure, or the question. A finished task
   * also hands back `files`, each as an artifact of its own after the text.
   */
  settle(taskId: string, state: FakeTaskState, text = '', options: { files?: FakeFile[] } = {}): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    const message = text && state !== 'completed' ? agentMessage(text, task) : undefined;
    task.status = { state: STATES[state], message, timestamp: new Date().toISOString() };
    if (state === 'completed' && text) {
      task.artifacts = [{ artifactId: randomUUID(), name: 'response', description: '', parts: [textPart(text)], metadata: undefined, extensions: [] }];
    }
    if (state === 'completed') {
      for (const file of options.files ?? []) {
        const id = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
        if (file.data) this.files.set(id, { data: file.data, mimeType: file.mimeType });
        task.artifacts.push({ artifactId: randomUUID(), name: file.name, description: file.description ?? '', metadata: undefined,
          extensions: [], parts: [{ content: { $case: 'url', value: file.uri ?? this.fileUrl(id) }, metadata: undefined,
            filename: file.name, mediaType: file.mimeType }] });
      }
    }
  }

  /** The newest task the agent took. */
  lastTask(): Task {
    const task = [...this.tasks.values()].at(-1);
    if (!task) throw new Error('no task yet');
    return task;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  /** `GET /artifacts/<ID>`: the file itself, under the token of the calls; 401 without it, 404 for an ID it does not know. */
  private serveFile(id: string, authorization: string | undefined, response: ServerResponse): void {
    this.fileRequests.push({ id, authorization });
    if (authorization !== `Bearer ${this.token}`) {
      response.writeHead(401, { 'www-authenticate': 'Bearer realm="a2a"' }).end();
      return;
    }
    if (this.fileFailWith) {
      response.writeHead(this.fileFailWith).end();
      return;
    }
    const file = this.files.get(id);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': file.mimeType,
      ...(this.chunkedFiles ? {} : { 'content-length': String(file.data.length) }) });
    response.end(file.data);
  }

  private card(): AgentCard {
    return {
      name: this.options.name ?? 'Fake Wiki Keeper',
      description: this.options.description ?? 'Answers questions about a wiki that is not real.',
      version: '0.0.0',
      supportedInterfaces: [{ url: this.url, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
      provider: undefined,
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: (this.options.skills ?? []).map(skill => ({ id: skill.id, name: skill.name, description: skill.description,
        tags: [], examples: skill.examples ?? [], inputModes: [], outputModes: [], securityRequirements: [] })),
      signatures: [],
    };
  }

  private handler(): A2ARequestHandler {
    const unsupported = () => { throw new UnsupportedOperationError('not in the fake'); };
    return {
      getAgentCard: async () => this.card(),
      getAuthenticatedExtendedAgentCard: async () => unsupported(),
      sendMessage: async params => this.sendMessage(params.message!, params.configuration?.returnImmediately ?? false),
      sendMessageStream: () => unsupported(),
      getTask: async params => {
        this.polls.push(params.id);
        const task = this.tasks.get(params.id);
        if (!task) throw new TaskNotFoundError(`no task ${params.id}`);
        return structuredClone(task);
      },
      cancelTask: async () => unsupported(),
      createTaskPushNotificationConfig: async () => unsupported(),
      getTaskPushNotificationConfig: async () => unsupported(),
      listTaskPushNotificationConfigs: async () => unsupported(),
      deleteTaskPushNotificationConfig: async () => unsupported(),
      resubscribe: () => unsupported(),
      listTasks: async () => unsupported(),
    };
  }

  private sendMessage(message: Message, returnImmediately: boolean): Message | Task {
    const text = message.parts.map(part => part.content?.$case === 'text' ? part.content.value : '').join('');
    this.received.push({ authorization: this.authorization, text, contextId: message.contextId, taskId: message.taskId, returnImmediately });
    if (message.contextId && !this.contexts.has(message.contextId)) throw new RequestMalformedError(`unknown context ${message.contextId}`);
    if (message.taskId) {
      const waiting = this.tasks.get(message.taskId);
      if (!waiting || waiting.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
        throw new RequestMalformedError(`task ${message.taskId} is not waiting for input`);
      }
      waiting.status = { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() };
      return structuredClone(waiting);
    }
    const contextId = message.contextId || randomUUID();
    this.contexts.add(contextId);
    if (this.options.replyWithMessage) return agentMessage(this.options.replyWithMessage, { id: '', contextId });
    const busy = [...this.tasks.values()].some(task => task.contextId === contextId
      && task.status?.state === TaskState.TASK_STATE_WORKING);
    const task: Task = { id: randomUUID(), contextId, status: {
      state: busy ? TaskState.TASK_STATE_REJECTED : TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString(),
    }, artifacts: [], history: [message], metadata: undefined };
    this.tasks.set(task.id, task);
    return structuredClone(task);
  }
}

function textPart(text: string) {
  return { content: { $case: 'text' as const, value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

function agentMessage(text: string, task: { id: string; contextId: string }): Message {
  return { messageId: randomUUID(), contextId: task.contextId, taskId: task.id, role: Role.ROLE_AGENT, parts: [textPart(text)],
    metadata: undefined, extensions: [], referenceTaskIds: [] };
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
