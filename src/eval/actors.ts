import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openPiSession } from '../pi/session.ts';
import { A2ACallError, AgentFileError, type A2AClient, type CardSummary, type SendResult, type TaskView } from '../server/a2a-client.ts';
import type { ReplyPlace, RequestPlace } from '../server/agent-replies.ts';
import { DEFAULT_A2A_GIVE_UP_AFTER_HOURS, DEFAULT_A2A_POLL_INTERVAL_SECONDS, type A2AConfig } from '../server/config.ts';
import { DOVE_NAME } from '../server/dove.ts';
import {
  requestLine, resultAttention, writeDoveRequest, writeDoveResults, type DoveRequestRecord, type DoveResultLine,
} from '../server/dove-files.ts';
import { parseDoveRequest } from '../server/dove-request.ts';
import { localDateTime } from '../server/nightly.ts';
import type { DoveEvents } from '../server/thinking-loop.ts';
import type { ToolOutcome } from '../server/loop-tools.ts';
import type { ModelFile } from './model-file.ts';
import { DOVE_RESULTS, type Actor, type DoveResult } from './scene.ts';

/**
 * The actors of a run (ADR 0052): who stands in for the outside agents and the dove. `ask_agent` reaches them through
 * the loop's own injection points, an A2A client and the dove's side, and nothing leaves the machine but, when an LLM
 * plays a part, its model call. A request is only taken at first; when the scene follows the replies, each actor
 * answers the requests of the turn, and the answers go back as production tells of them: the dove's results as lines
 * of its request's results.jsonl under /sources/agents/poppo, each told by an attention (ADR 0074).
 */

/**
 * The A2A token of a run: a file that is not there. The injected client never reads it, and anything that tried
 * would find nothing (the first guarantee of ADR 0052).
 */
export const EVAL_A2A_TOKEN_FILE = '/nonexistent/natsumi-eval-has-no-a2a-token';

/** What an actor was asked, and what it answered, if it was asked to. */
export interface ActorExchange {
  agent: string;
  /** The turn the request was made in, 1-based. */
  turn: number;
  request: string;
  /** Whether the request was taken; the dove turns back one out of shape at once, as production does. */
  taken: boolean;
  reply?: string;
  /** What became of a request to the dove. */
  result?: DoveResult;
  /** `written` for a reply the scene wrote, `llm` for one an LLM played, `dry-run` for the stand-in of a dry run. */
  by?: 'written' | 'llm' | 'dry-run';
  error?: string;
}

/** An LLM that plays an actor: given the actor and the request, it answers as that actor would. */
export interface ActorModel {
  reply(actor: Actor, request: string): Promise<{ text: string; result?: DoveResult }>;
}

/** A request to the dove as production keeps it: its directory, what was asked, and its results so far. */
interface DoveRequestKept { place: RequestPlace; record: DoveRequestRecord; results: DoveResultLine[] }

interface Pending { exchange: ActorExchange; taskId?: string; dove?: DoveRequestKept }

const later = 'は、後で同じディレクトリの results.jsonl に 1 行ずつ足され、sources_updated の attention（kind: agent_reply、agent: poppo）で届きます。'
  + '待たずに、ほかのことをしてかまいません。';

export class Stage {
  readonly exchanges: ActorExchange[] = [];
  private readonly actors: Record<string, Actor>;
  private readonly model: ActorModel | undefined;
  private readonly dryRun: boolean;
  private pending: Pending[] = [];
  private readonly answered = new Map<string, string>();
  private readonly used = new Map<string, number>();
  private readonly timeZone: string;
  private readonly now: () => number;
  /** Where the dove's requests and results are put and told, as production's: the run's own sources (ADR 0074). */
  dovePlace: ReplyPlace | undefined;
  private serial = 0;
  /** The turn requests are counted in; the run moves it on. */
  turn = 1;

  constructor(options: { actors: Record<string, Actor>; model?: ActorModel; dryRun: boolean; timeZone?: string; now?: () => number }) {
    this.actors = options.actors;
    this.model = options.model;
    this.dryRun = options.dryRun;
    this.timeZone = options.timeZone ?? 'UTC';
    this.now = options.now ?? Date.now;
  }

  /** The `a2a` of the loop: one agent per actor but the dove, at an address that is never reached, and no token. */
  a2aConfig(): A2AConfig | undefined {
    const names = Object.keys(this.actors).filter(name => name !== DOVE_NAME);
    if (names.length === 0) return undefined;
    return { tokenFile: EVAL_A2A_TOKEN_FILE, pollIntervalSeconds: DEFAULT_A2A_POLL_INTERVAL_SECONDS,
      giveUpAfterHours: DEFAULT_A2A_GIVE_UP_AFTER_HOURS,
      agents: Object.fromEntries(names.map(name => [name, { url: `https://${name}.actor.invalid/` }])) };
  }

  /** The A2A client of the loop: the actors, in this process. */
  readonly client: A2AClient = {
    send: async (url, input): Promise<SendResult> => {
      const agent = this.agentAt(url);
      const taskId = `actor-task-${++this.serial}`;
      const exchange: ActorExchange = { agent, turn: this.turn, request: input.text, taken: true };
      this.exchanges.push(exchange);
      this.pending.push({ exchange, taskId });
      return { kind: 'task', taskId, contextId: input.contextId ?? `actor-context-${this.serial}`, state: 'waiting', text: '' };
    },
    getTask: async (_url, taskId): Promise<TaskView> => {
      const text = this.answered.get(taskId);
      if (text !== undefined) { this.answered.delete(taskId); return { state: 'completed', text }; }
      if (this.pending.some(entry => entry.taskId === taskId)) return { state: 'waiting', text: '' };
      // A task of the snapshot's, which no actor knows: it stays as it was, and no event is made of it.
      throw new A2ACallError('unavailable', 'not a task of this run');
    },
    card: async (url): Promise<CardSummary> => {
      const actor = this.actors[this.agentAt(url)]!;
      return { name: actor.name, description: actor.card, skills: [] };
    },
    fetchFile: async () => { throw new AgentFileError('unavailable', 'actors hand back no files'); },
  };

  /**
   * The dove's side of the loop: a request is read as production reads it, put in a directory of its own, taken, and
   * answered later if followed. Where it goes is not matched against a record: the scene has none.
   */
  readonly dove: DoveEvents = {
    ask: async (message: string): Promise<ToolOutcome> => {
      const parsed = parseDoveRequest(message);
      const exchange: ActorExchange = { agent: DOVE_NAME, turn: this.turn, request: message, taken: parsed.ok };
      this.exchanges.push(exchange);
      if (!parsed.ok) return { ok: false, text: parsed.text };
      const place = this.dovePlace;
      if (!place) { exchange.taken = false; return { ok: false, text: '頼んでいません。結果を置く場所を用意できていません。' }; }
      const { kind, to, expression, body, images } = parsed.request;
      const at = this.now();
      const record: DoveRequestRecord = { kind, to, ...(expression ? { face: expression } : {}),
        ...(kind === 'reaction' ? { emoji: body } : body !== '' ? { text: body } : {}), ...(images ? { images } : {}),
        asked_at: localDateTime(at, this.timeZone), target: { channel: channelOf(to.file) } };
      const made = await writeDoveRequest(place.directory, DOVE_NAME, at, record);
      this.pending.push({ exchange, dove: { place: made, record, results: [] } });
      const asked = `頼んだことは ${made.path}/request.json に置きました。`;
      return { ok: true, text: kind === 'reaction' ? `ポッポさんがリアクションの依頼を受け付けました。${asked}付けたかどうか${later}`
        : `ポッポさんが投稿の依頼を受け付けました。${asked}届けたか、本人に回したか、突き返したか${later}` };
    },
  };

  hasPending(): boolean { return this.pending.length > 0; }

  /** Forgets what was asked so far: the turns before the one evaluated are not its. */
  forget(): void {
    this.exchanges.length = 0;
    this.pending = [];
  }

  /**
   * Every request still waiting gets its actor's reply. The dove's results are put and told here, as production's
   * are; the agents' are handed out when the loop fetches their tasks.
   */
  async answerPending(): Promise<void> {
    const place = this.dovePlace;
    let told = false;
    const pending = this.pending;
    this.pending = [];
    for (const entry of pending) {
      const actor = this.actors[entry.exchange.agent] ?? { name: entry.exchange.agent, card: '', replies: [] };
      let answer: { text: string; result?: DoveResult };
      try { answer = await this.answer(actor, entry.exchange); } catch (error) {
        entry.exchange.error = (error as Error).message;
        answer = { text: '', result: 'not_sent' };
      }
      entry.exchange.reply = answer.text;
      if (entry.taskId) { this.answered.set(entry.taskId, answer.text); continue; }
      const result = answer.result ?? 'sent';
      entry.exchange.result = result;
      const kept = entry.dove;
      if (!kept || !place) continue;
      const line: DoveResultLine = { at: localDateTime(this.now(), this.timeZone), state: result, text: answer.text };
      kept.results.push(line);
      await writeDoveResults(kept.place.directory, kept.results);
      place.record(resultAttention(kept.place.path, DOVE_NAME, kept.results.length - 1, line,
        { line: requestLine(kept.record), askedAt: kept.record.asked_at }));
      told = true;
    }
    if (told) place?.notify();
  }

  private async answer(actor: Actor, exchange: ActorExchange): Promise<{ text: string; result?: DoveResult }> {
    if (actor.replies.length > 0) {
      const index = this.used.get(actor.name) ?? 0;
      this.used.set(actor.name, index + 1);
      exchange.by = 'written';
      return actor.replies[Math.min(index, actor.replies.length - 1)]!;
    }
    if (this.model) {
      exchange.by = 'llm';
      return this.model.reply(actor, exchange.request);
    }
    if (this.dryRun) {
      exchange.by = 'dry-run';
      return { text: `（ドライラン: ${actor.name} の返事）`, ...(actor.name === DOVE_NAME ? { result: 'sent' as const } : {}) };
    }
    throw new Error(`no one plays ${actor.name}`);
  }

  private agentAt(url: string): string {
    const name = /^https:\/\/([a-z0-9-]+)\.actor\.invalid\/$/.exec(url)?.[1];
    if (!name || !this.actors[name]) throw new A2ACallError('unavailable', 'not an actor of this run');
    return name;
  }
}

/** The actors' LLM when none is given (ADR 0052): the ChatGPT Plus route, as the judge's. */
export const DEFAULT_ACTOR = { provider: 'openai-codex', model: 'gpt-6-sol' };
const ACTOR_TIMEOUT_MS = 180_000;

/** An LLM playing an actor through Pi, one session per reply, with no tools. */
export class PiActor implements ActorModel {
  private readonly file: ModelFile;
  private readonly runtime: ModelRuntime;
  private readonly root: string;

  constructor(options: { file: ModelFile; runtime: ModelRuntime; root: string }) {
    this.file = options.file; this.runtime = options.runtime; this.root = options.root;
  }

  async reply(actor: Actor, request: string): Promise<{ text: string; result?: DoveResult }> {
    const cwd = join(this.root, 'actor');
    const sessionDir = join(cwd, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    const dove = actor.name === DOVE_NAME;
    const session = await openPiSession({ cwd, agentDir: this.root, sessionDir, modelRuntime: this.runtime, target: this.file.target,
      systemPrompt: actorInstructions(actor), thinkingLevel: this.file.thinking === 'on' ? 'low' : 'off', tools: { names: [], definitions: [] } });
    const timer = setTimeout(() => { void session.abort(); }, ACTOR_TIMEOUT_MS);
    try {
      await session.prompt(`## なつみからの依頼\n${request}`, { expandPromptTemplates: false });
      const last = session.messages.filter(message => message.role === 'assistant').at(-1);
      const text = last && last.role === 'assistant' ? last.content.map(block => block.type === 'text' ? block.text : '').join('').trim() : '';
      if (!text) throw new Error(`the actor of ${actor.name} gave no answer`);
      return dove ? doveAnswer(text) : { text };
    } finally {
      clearTimeout(timer);
      session.dispose();
    }
  }
}

/** What an actor is told: who it plays, and the scene's instructions for it. */
export function actorInstructions(actor: Actor): string {
  const scene = actor.instructions ? `\n\n場面の指示:\n${actor.instructions}` : '';
  if (actor.name === DOVE_NAME) {
    return `あなたは評価のための相手役で、Slack への送信役の鳩「ポッポさん」を演じます。
ポッポさんは、AI のキャラクター「なつみ」から Slack への投稿やリアクションの依頼を受け取り、下書きを判定にかけます。
判定が通せば届け、迷うものは本人の承認に回し、問題があれば理由を添えて突き返します。本人が承認・却下することもあります。
依頼がどうなったかを決め、ポッポさんの台詞（短く、「ポッポ！」で始まる明るい口調）を書きます。${scene}

答えは JSON の 1 行だけにします: {"result": "${DOVE_RESULTS.join('" | "')}" のどれか, "text": "ポッポさんの台詞"}`;
  }
  return `あなたは評価のための相手役で、外のエージェント「${actor.name}」を演じます。
AI のキャラクター「なつみ」から、A2A で依頼が届きました。${actor.name} の説明（Agent Card）: ${actor.card}${scene}

依頼への ${actor.name} の返事の本文だけを、日本語で書きます。前置きや、相手役であることの説明は書きません。`;
}

/** The dove's answer, read leniently: the first JSON object with a known result, or the whole text as sent. */
export function doveAnswer(text: string): { text: string; result: DoveResult } {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { result?: unknown; text?: unknown };
      if (DOVE_RESULTS.includes(parsed.result as DoveResult) && typeof parsed.text === 'string') {
        return { text: parsed.text, result: parsed.result as DoveResult };
      }
    } catch { /* below */ }
  }
  return { text, result: 'sent' };
}

/** A channel as she reads it, from the place she named: `/sources/slack/work/dev` is `work/#dev`. */
function channelOf(file: string): string {
  const [workspace = '', directory = ''] = file.replace(/^\/sources\/slack\//, '').split('/');
  return `${workspace}/${directory.startsWith('@') ? directory : `#${directory}`}`;
}
