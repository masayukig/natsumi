import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { convertToLlm, migrateSessionEntries, parseSessionEntries, type ContextEvent,
  type SessionEntry } from '@earendil-works/pi-coding-agent';
import { routesRuntime } from '../pi/auth.ts';
import { COMPATIBLE_PROVIDER } from '../pi/compatible.ts';
import { createLoopTools, type ToolOutcome } from '../server/loop-tools.ts';
import { composeSystemPrompt } from '../server/prompts.ts';
import { MEMO_MAX_CHARS, memoLine } from '../server/turn-fold.ts';
import { sectionBody } from '../server/thinking-loop.ts';
import { percentile } from '../server/turn-stats.ts';
import { COMPATIBLE_KEY_ENV } from './auth.ts';
import { classify, contextAt, foldedContextAt, findTurns, lookups, memoContext, pickPairs, type FirstAction,
  type Turn } from './fold-replay-plan.ts';

/**
 * Replays past sessions with and without folding (ADR 0047), against the owner's own endpoint, one call at a time.
 *
 * For every chosen turn, the first call is made twice: once on the context production had, once on that context
 * folded, with a memo after every ended turn. The memos are asked for as the loop asks, on the unfolded context at
 * each turn's end. No tool is run: a response is kept as it ends, at its first tool call or without one.
 *
 * Everything written — responses, memos, numbers, the pairs for the owner to read and their key — goes under
 * `--output`, which is meant to sit beside the copies in a directory outside every repository. Only numbers are
 * printed. Responses and memos are kept there, so a run that stops picks up where it was.
 */

type AgentMessage = ContextEvent['messages'][number];
type Response = { content: { type: string; name?: string; arguments?: Record<string, unknown>; text?: string; thinking?: string }[];
  usage: { input: number; cacheRead: number; output: number }; stopReason: string; ms: number };

const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: {
  input: { type: 'string' }, output: { type: 'string' }, sessions: { type: 'string' }, turns: { type: 'string' },
  pairs: { type: 'string' }, seed: { type: 'string' }, 'memo-sample': { type: 'string' }, 'compare-memos': { type: 'string' },
  'compatible-base-url': { type: 'string' }, 'compatible-model': { type: 'string' },
} });
const apiKey = process.env[COMPATIBLE_KEY_ENV];
const { input, output } = values;
const baseUrl = values['compatible-base-url'];
const modelId = values['compatible-model'];
if (!input || !output || !baseUrl || !modelId || !apiKey) {
  process.stderr.write(`usage: ${COMPATIBLE_KEY_ENV}=... npm run probe:fold-replay -- --input <dir with sessions/ and memory/> --output <dir>\n`
    + '  --compatible-base-url <url> --compatible-model <id> [--sessions <name prefix>,...] [--turns <per session>] [--pairs 15] [--seed 1]\n');
  process.exit(2);
}
const turnsPerSession = values.turns ? Number(values.turns) : undefined;
const pairCount = Number(values.pairs ?? 15);
const seed = Number(values.seed ?? 1);

await mkdir(join(output, 'agent'), { recursive: true, mode: 0o700 });
const runtime = await routesRuntime(join(output, 'agent'), { compatible: [{ provider: COMPATIBLE_PROVIDER, apiKey, endpoint: { baseUrl, model: modelId } }] });
const model = runtime.getModel(COMPATIBLE_PROVIDER, modelId);
if (!model) throw new Error('model unavailable');

const git = promisify(execFile);
const memory = join(input, 'memory');
const outcome = (text: string): ToolOutcome => ({ ok: true, text });
const TOOLS = createLoopTools({
  reply: () => outcome(''), notify: () => outcome(''), setExpression: () => outcome(''), writeHandoff: () => outcome(''),
  writeChangeNote: () => outcome(''), scheduleSelfCheck: () => outcome(''), listSelfChecks: () => outcome(''),
  cancelSelfCheck: () => outcome(''), askAgent: () => outcome(''), runShell: () => outcome(''),
  capture: async () => ({ ok: true, exitCode: 0, stdout: '', stdoutTruncated: false }),
}).map(tool => ({ name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)) }));

/** The system prompt a session started with: its memory at the last commit before it began, assembled as the loop does. */
async function rebuiltPrompt(startedAt: string): Promise<string> {
  const { stdout } = await git('git', ['-C', memory, 'rev-list', '-1', `--before=${startedAt}`, 'HEAD']);
  const commit = stdout.trim() || (await git('git', ['-C', memory, 'rev-list', '--max-parents=0', 'HEAD'])).stdout.trim().split('\n')[0]!;
  const show = async (file: string) => {
    try { return sectionBody((await git('git', ['-C', memory, 'show', `${commit}:${file}`], { maxBuffer: 1 << 24 })).stdout); } catch { return ''; }
  };
  return `${composeSystemPrompt({ workspace: true, personality: await show('personality.md'), always: await show('always.md'),
    handoff: await show('handoff.md') })}\n\n<cwd>\n/data\n</cwd>`;
}

/** The prompt and tools a turn is replayed with: those the session recorded, when it recorded them, else rebuilt. */
function recordedPrompt(entries: SessionEntry[], turn: Turn): { prompt: string; tools: typeof TOOLS } | undefined {
  const index = entries.findIndex(entry => entry.id === turn.startEntryId);
  let found: { sections?: Record<string, string>; toolsAdded?: typeof TOOLS } | undefined;
  for (const entry of entries.slice(0, index)) {
    const message = entry.type === 'message' ? (entry as { message: { role: string } }).message : undefined;
    if (message?.role === 'system') found = message as never;
  }
  if (!found?.sections?.preamble) return undefined;
  const tools = found.toolsAdded ?? [];
  // The read tool of this version joins the recorded ones, as it would on a restart, so both sides have the same tools.
  const read = TOOLS.find(tool => tool.name === 'read')!;
  return { prompt: [found.sections.preamble, found.sections.cwd].filter(Boolean).join('\n\n'),
    tools: tools.some(tool => tool.name === 'read') ? tools : [...tools, read] };
}

async function cached<T>(file: string, make: () => Promise<T>): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { /* not made yet */ }
  const made = await make();
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(made), { mode: 0o600 });
  return made;
}

async function call(prompt: string, tools: typeof TOOLS, messages: AgentMessage[]): Promise<Response> {
  const started = Date.now();
  const stream = runtime.streamSimple(model!, { systemPrompt: prompt, tools, messages: convertToLlm(messages) },
    { reasoning: 'medium', apiKey, signal: AbortSignal.timeout(20 * 60_000) });
  const message = await stream.result();
  return { content: message.content as Response['content'], stopReason: message.stopReason, ms: Date.now() - started,
    usage: { input: message.usage.input, cacheRead: message.usage.cacheRead, output: message.usage.output } };
}

const stat = (values: number[]) => ({ p50: percentile(values, 50) ?? null, p90: percentile(values, 90) ?? null });
const memoText = (response: Response) => response.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('').trim();

interface Side { prompt: number; input: number; cacheRead: number; output: number; ms: number; stop: string; action: FirstAction;
  lookups: number; repeated: number }
interface Row { key: string; session: string; turn: number; promptSource: 'recorded' | 'rebuilt'; eventKinds: string;
  production: FirstAction; unfolded: Side; folded: Side }

const side = (entries: SessionEntry[], turns: Turn[], index: number, response: Response): Side => ({
  prompt: response.usage.input + response.usage.cacheRead, input: response.usage.input, cacheRead: response.usage.cacheRead,
  output: response.usage.output, ms: response.ms, stop: response.stopReason, action: classify(response),
  ...lookups(entries, turns, index, response),
});

/**
 * `--memo-sample N`: only the memos, asked again with the request as it is now, for N turns spread over the chosen
 * sessions; with `--compare-memos <dir>`, the memos an earlier run made for the same turns are measured beside them.
 * Prints lengths and counts only.
 */
async function sampleMemos(count: number, files: string[]): Promise<void> {
  const all: { file: string; name: string; entries: SessionEntry[]; turns: Turn[]; turn: Turn; rebuilt: string }[] = [];
  for (const file of files) {
    const parsed = parseSessionEntries(await readFile(join(input!, 'sessions', file), 'utf8'));
    migrateSessionEntries(parsed);
    const header = parsed.find(entry => entry.type === 'session') as { id: string; timestamp: string } | undefined;
    if (!header) continue;
    const entries = parsed.filter(entry => entry.type !== 'session') as SessionEntry[];
    const turns = findTurns(entries);
    const rebuilt = await rebuiltPrompt(header.timestamp);
    for (const turn of turns) all.push({ file, name: header.id.slice(-8), entries, turns, turn, rebuilt });
  }
  const picked = Array.from({ length: Math.min(count, all.length) }, (_, index) => all[Math.floor((index * all.length) / Math.min(count, all.length))]!);
  const measure = (texts: string[]) => {
    const kept = texts.map(memoLine).filter(Boolean).map(line => [...line].length);
    const raw = texts.map(text => [...text.trim()].length);
    return { memos: texts.length, leftNoLine: texts.length - kept.length, emptyText: texts.filter(text => !text.trim()).length,
      rawChars: stat(raw), keptChars: stat(kept), overLimit: raw.filter(length => length > MEMO_MAX_CHARS).length };
  };
  const fresh: string[] = [];
  const earlier: string[] = [];
  for (const item of picked) {
    const setup = recordedPrompt(item.entries, item.turn) ?? { prompt: item.rebuilt, tools: TOOLS };
    const memo = await cached(join(output!, 'memos-sample', item.name, `${item.turn.index}.json`),
      () => call(setup.prompt, setup.tools, memoContext(item.entries, item.turn)));
    fresh.push(memoText(memo));
    if (values['compare-memos']) {
      try { earlier.push(memoText(JSON.parse(await readFile(join(values['compare-memos'], item.name, `${item.turn.index}.json`), 'utf8')) as Response)); } catch { /* not made then */ }
    }
    process.stderr.write(`  memo ${fresh.length}/${picked.length}\n`);
  }
  const report = { now: measure(fresh), ...(earlier.length ? { before: measure(earlier) } : {}) };
  await writeFile(join(output!, 'memo-sample.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const files = (await readdir(join(input, 'sessions'))).filter(name => name.endsWith('.jsonl')).sort();
const chosen = values.sessions ? files.filter(name => values.sessions!.split(',').some(prefix => name.startsWith(prefix))) : files.slice(-3);
if (values['memo-sample']) {
  await sampleMemos(Number(values['memo-sample']), chosen);
  process.exit(0);
}
const rows: Row[] = [];
const responses = new Map<string, { unfolded: Response; folded: Response; prompt: AgentMessage }>();
for (const file of chosen) {
  const all = parseSessionEntries(await readFile(join(input, 'sessions', file), 'utf8'));
  migrateSessionEntries(all);
  const header = all.find(entry => entry.type === 'session') as { id: string; timestamp: string } | undefined;
  const entries = all.filter(entry => entry.type !== 'session') as SessionEntry[];
  if (!header) continue;
  const name = header.id.slice(-8);
  const turns = findTurns(entries);
  const candidates = turns.slice(1).map(turn => turn.index);
  const targets = turnsPerSession && turnsPerSession < candidates.length
    ? [...new Set(Array.from({ length: turnsPerSession }, (_, index) => candidates[Math.floor(((index + 1) * candidates.length) / (turnsPerSession + 1))]!))]
    : candidates;
  const last = Math.max(...targets, 0);
  const rebuilt = await rebuiltPrompt(header.timestamp);
  const memos = new Map<number, string>();
  const unfolded = new Map<number, Response>();
  process.stderr.write(`${name}: ${turns.length} turns, replaying ${targets.length}\n`);
  // Along the unfolded record first, so each call extends the one before it on the prefix, as production's did.
  for (const turn of turns.slice(0, last + 1)) {
    const setup = recordedPrompt(entries, turn) ?? { prompt: rebuilt, tools: TOOLS };
    if (targets.includes(turn.index)) {
      unfolded.set(turn.index, await cached(join(output, 'responses', name, `${turn.index}-unfolded.json`),
        () => call(setup.prompt, setup.tools, contextAt(entries, turn.startEntryId))));
    }
    if (turn.index < last) {
      const memo = await cached(join(output, 'memos', name, `${turn.index}.json`), () => call(setup.prompt, setup.tools, memoContext(entries, turn)));
      memos.set(turn.index, memoText(memo));
    }
  }
  // Then along the folded one.
  for (const index of targets) {
    const turn = turns[index]!;
    const recorded = recordedPrompt(entries, turn);
    const setup = recorded ?? { prompt: rebuilt, tools: TOOLS };
    const context = foldedContextAt(entries, turns, index, memos);
    const folded = await cached(join(output, 'responses', name, `${index}-folded.json`), () => call(setup.prompt, setup.tools, context));
    const key = `${name}-${index}`;
    rows.push({ key, session: name, turn: index, promptSource: recorded ? 'recorded' : 'rebuilt', eventKinds: turn.eventKinds,
      production: turn.production, unfolded: side(entries, turns, index, unfolded.get(index)!), folded: side(entries, turns, index, folded) });
    responses.set(key, { unfolded: unfolded.get(index)!, folded, prompt: context.at(-1)! });
    process.stderr.write(`  turn ${index} done\n`);
  }
}

await writeFile(join(output, 'results.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });

// The numbers.
const summarize = (pick: (row: Row) => Side) => ({
  promptTokens: stat(rows.map(row => pick(row).prompt)),
  cacheRead: stat(rows.map(row => pick(row).cacheRead)),
  uncachedInput: stat(rows.map(row => pick(row).input)),
  outputTokens: stat(rows.map(row => pick(row).output)),
  seconds: stat(rows.map(row => pick(row).ms / 1000)),
  actions: rows.reduce<Record<string, number>>((counts, row) => ({ ...counts, [pick(row).action.category]: (counts[pick(row).action.category] ?? 0) + 1 }), {}),
  lookups: rows.reduce((sum, row) => sum + pick(row).lookups, 0),
  repeatedLookups: rows.reduce((sum, row) => sum + pick(row).repeated, 0),
  sameAsProduction: rows.filter(row => pick(row).action.category === row.production.category).length,
  macMessageTurnsReplyingFirst: rows.filter(row => row.eventKinds.includes('mac_message') && pick(row).action.category === 'reply').length,
});
const summary = {
  turns: rows.length, sessions: chosen.length,
  promptSource: { recorded: rows.filter(row => row.promptSource === 'recorded').length, rebuilt: rows.filter(row => row.promptSource === 'rebuilt').length },
  macMessageTurns: rows.filter(row => row.eventKinds.includes('mac_message')).length,
  sameFirstAction: rows.filter(row => row.unfolded.action.category === row.folded.action.category).length,
  sameFirstTool: rows.filter(row => row.unfolded.action.tool === row.folded.action.tool).length,
  unfolded: summarize(row => row.unfolded), folded: summarize(row => row.folded),
};
await writeFile(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

// The pairs for the owner: the folded side hidden as A or B, the key apart.
const pairs = pickPairs(rows.map(row => ({ key: row.key, differs: row.unfolded.action.tool !== row.folded.action.tool })), pairCount, seed);
const render = (response: Response) => response.content.map(block => block.type === 'thinking' ? `**思考**\n\n${block.thinking ?? ''}`
  : block.type === 'text' ? `**地の文**\n\n${block.text ?? ''}`
  : block.type === 'toolCall' ? `**ツール** \`${block.name}\`\n\n\`\`\`json\n${JSON.stringify(block.arguments, null, 2)}\n\`\`\`` : '').filter(Boolean).join('\n\n');
const promptText = (message: AgentMessage) => message.role === 'user' ? (typeof message.content === 'string' ? message.content
  : message.content.map(part => part.type === 'text' ? part.text : '[画像]').join('')) : '';
const markdown = ['# 畳み込みの再生: 読み比べ', '', 'A と B の片方が畳んだ文脈、もう片方が畳まない文脈（本番と同じ形）での、なつみの最初の 1 回の応答です。',
  'どちらが畳んだ側かは `pairs-key.json` にあります。読み終えてから開いてください。', ''];
pairs.forEach((pair, index) => {
  const { unfolded, folded, prompt } = responses.get(pair.key)!;
  const [a, b] = pair.foldedIs === 'A' ? [folded, unfolded] : [unfolded, folded];
  markdown.push(`## ${index + 1}. ${pair.key}`, '', '### 届いた出来事', '', '```', promptText(prompt), '```', '',
    '### A', '', render(a), '', '### B', '', render(b), '', '### 判定', '', '- よいほう: A / B / 同じ', '- 理由: ', '');
});
await writeFile(join(output, 'pairs.md'), markdown.join('\n'), { mode: 0o600 });
await writeFile(join(output, 'pairs-key.json'), `${JSON.stringify(Object.fromEntries(pairs.map((pair, index) => [`${index + 1}. ${pair.key}`, `folded=${pair.foldedIs}`])), null, 2)}\n`, { mode: 0o600 });

process.stdout.write(`${JSON.stringify(summary, null, 2)}\npairs: ${pairs.length}\n`);
