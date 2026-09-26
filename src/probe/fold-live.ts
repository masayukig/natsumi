import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { routesRuntime } from '../pi/auth.ts';
import { COMPATIBLE_PROVIDER } from '../pi/compatible.ts';
import { LOOP_DEFAULTS } from '../server/config.ts';
import { STATE_DIRECTORY } from '../server/data-directory.ts';
import { writeFoldChoice } from '../server/fold-setting.ts';
import { MIGRATIONS } from '../server/migrations.ts';
import { REFLECTION_REQUEST } from '../server/prompts.ts';
import { migrate, openStateDatabase } from '../server/state-db.ts';
import { ThinkingLoop } from '../server/thinking-loop.ts';
import { COMPATIBLE_KEY_ENV } from './auth.ts';

/**
 * A live check of ADR 0047 against the owner's own OpenAI-compatible endpoint: the real thinking loop, in a temporary
 * data directory, with no workspace. Three turns — the first two unfolded, the third folded — and the memo after
 * each. What it prints is numbers and fixed words only: per model call, whether it was a turn's or a memo's, the
 * thinking level, and the tokens the endpoint reported, of which the cached share shows whether the prefix cache held.
 * The key comes from the environment only; the URL and the model from the command line, and neither is printed.
 */

const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: {
  'compatible-base-url': { type: 'string' }, 'compatible-model': { type: 'string' },
} });
const baseUrl = values['compatible-base-url'];
const model = values['compatible-model'];
const apiKey = process.env[COMPATIBLE_KEY_ENV];
if (!baseUrl || !model || !apiKey) {
  process.stderr.write(`usage: ${COMPATIBLE_KEY_ENV}=... npm run probe:fold -- --compatible-base-url <url> --compatible-model <id>\n`);
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), 'natsumi-fold-probe-'));
const data = join(root, 'data');
await mkdir(join(data, STATE_DIRECTORY), { recursive: true, mode: 0o700 });
await mkdir(join(root, 'sessions'));
await mkdir(join(root, 'agent'));
const db = openStateDatabase(join(root, 'state.sqlite'));
migrate(db, MIGRATIONS);
const calls: { kind: 'turn' | 'memo'; thinking: string; input: number; cacheRead: number; output: number; stop: string }[] = [];
let session: AgentSession | undefined;
let loop: ThinkingLoop | undefined;
let exitCode = 0;
try {
  loop = await ThinkingLoop.open({
    db, dataDirectory: data, sessionDirectory: join(root, 'sessions'), agentDirectory: join(root, 'agent'),
    target: { provider: COMPATIBLE_PROVIDER, model }, thinking: 'on',
    runtime: () => routesRuntime(join(root, 'agent'), { compatible: [{ provider: COMPATIBLE_PROVIDER, apiKey,
      endpoint: { baseUrl, model } }] }),
    loop: { ...LOOP_DEFAULTS, timeZone: 'Asia/Tokyo' },
    configureSession: opened => {
      session = opened;
      const stream = opened.agent.streamFunction;
      opened.agent.streamFunction = async (target, context, options) => {
        const last = context.messages.at(-1);
        const text = last?.role === 'user' ? (typeof last.content === 'string' ? last.content
          : last.content.map(part => part.type === 'text' ? part.text : '').join('')) : '';
        const kind = text === REFLECTION_REQUEST ? 'memo' as const : 'turn' as const;
        const result = await stream(target, context, options);
        void result.result().then(message => {
          calls.push({ kind, thinking: options?.reasoning ?? 'off', input: message.usage.input, cacheRead: message.usage.cacheRead,
            output: message.usage.output, stop: message.stopReason });
        });
        return result;
      };
    },
  });
  if (loop.unavailable) throw new Error(`loop unavailable: ${loop.unavailable}`);
  const replies: string[] = [];
  loop.subscribe(event => { if (event.type === 'conversation.message' && event.payload.role === 'natsumi') replies.push(String(event.payload.text)); });
  const turns = [
    { fold: 'off' as const, text: '明日の 10 時に歯医者の予約があるの。覚えておいてね。' },
    { fold: 'off' as const, text: 'ありがとう。ところで、今日はちょっと疲れたな。' },
    { fold: 'on' as const, text: 'さっき話した予約、何時だったっけ？' },
  ];
  const report: Record<string, unknown>[] = [];
  for (const [index, turn] of turns.entries()) {
    await writeFoldChoice(data, turn.fold, Date.now());
    const before = { calls: calls.length, replies: replies.length };
    const sent = loop.send({ requestId: `probe-${index}`, deviceId: 'probe', text: turn.text });
    if (sent.kind !== 'accepted') throw new Error(`not accepted: ${sent.kind}`);
    await loop.idle();
    await new Promise(resolve => setTimeout(resolve, 200));
    const said = replies.slice(before.replies);
    report.push({
      turn: index + 1, fold: turn.fold, replied: said.length > 0,
      // Only for the last turn, whose answer depends on the folded first turn: whether it names the time.
      ...(index === 2 ? { remembers10: said.some(line => /10\s*時|10:00|十時/.test(line)) } : {}),
      calls: calls.slice(before.calls).map(call => ({ ...call,
        cachedShare: call.input + call.cacheRead === 0 ? null : Math.round((call.cacheRead / (call.input + call.cacheRead)) * 100) })),
    });
  }
  process.stdout.write(`${JSON.stringify({ thinkingLevelAfter: session?.thinkingLevel, turns: report }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ failed: error instanceof Error ? error.name : 'error' })}\n`);
  exitCode = 1;
} finally {
  await loop?.close();
  db.close();
  await rm(root, { recursive: true, force: true });
}
process.exit(exitCode);
