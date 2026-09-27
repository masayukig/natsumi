import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openPiSession } from '../pi/session.ts';
import type { Judge } from './checks.ts';
import type { ModelFile } from './model-file.ts';
import type { RunRecord } from './record.ts';

/** The judge when none is given (ADR 0051): the ChatGPT Plus route. Its login is the model file's `pi.authPath`. */
export const DEFAULT_JUDGE = { provider: 'openai-codex', model: 'gpt-6-sol' };
const JUDGE_TIMEOUT_MS = 180_000;
const CUT = 1500;

const INSTRUCTIONS = `あなたは評価の判定役です。AI のキャラクター「なつみ」が、出来事を 1 つ受け取って動いた 1 ターンの記録を読み、
与えられた基準を満たしているかだけを判定します。記録にないことは推測しません。
答えは JSON の 1 行だけにします: {"pass": true または false, "reason": "理由を日本語で 1〜2 文"}`;

/**
 * An LLM judging a rubric through Pi (ADR 0051), with the same kind of model file as the model evaluated. Each rubric is
 * asked in a session of its own, with no tools, and answered with one line of JSON.
 */
export class PiJudge implements Judge {
  private readonly file: ModelFile;
  private readonly runtime: ModelRuntime;
  private readonly root: string;

  constructor(options: { file: ModelFile; runtime: ModelRuntime; root: string }) {
    this.file = options.file; this.runtime = options.runtime; this.root = options.root;
  }

  async judge(rubric: string, record: RunRecord): Promise<{ pass: boolean | null; detail: string }> {
    const cwd = join(this.root, 'judge');
    const sessionDir = join(cwd, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    const session = await openPiSession({ cwd, agentDir: this.root, sessionDir, modelRuntime: this.runtime, target: this.file.target,
      systemPrompt: INSTRUCTIONS, thinkingLevel: this.file.thinking === 'on' ? 'medium' : 'off', tools: { names: [], definitions: [] } });
    const timer = setTimeout(() => { void session.abort(); }, JUDGE_TIMEOUT_MS);
    try {
      await session.prompt(`## 基準\n${rubric}\n\n## 記録\n${transcript(record)}`, { expandPromptTemplates: false });
      const last = session.messages.filter(message => message.role === 'assistant').at(-1);
      const text = last && last.role === 'assistant'
        ? last.content.map(block => block.type === 'text' ? block.text : '').join('') : '';
      return verdict(text);
    } finally {
      clearTimeout(timer);
      session.dispose();
    }
  }
}

/** A dry run's judge: every rubric passes, so the path through the checks and the summary is exercised without a model. */
export const DRY_JUDGE: Judge = { judge: async () => ({ pass: true, detail: 'ドライラン（判定役は呼んでいません）' }) };

/** The judge's answer, read leniently: the first JSON object in it. */
export function verdict(text: string): { pass: boolean | null; detail: string } {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { pass?: unknown; reason?: unknown };
      if (typeof parsed.pass === 'boolean') return { pass: parsed.pass, detail: typeof parsed.reason === 'string' ? parsed.reason : '' };
    } catch { /* below */ }
  }
  return { pass: null, detail: `判定できません: 判定役の答えを読めませんでした（${cut(text.trim(), 200)}）` };
}

/** What the judge reads of a run: the events, each call's text and tools, what the owner was shown, and the requests. */
export function transcript(record: RunRecord): string {
  const lines = ['### 届いた出来事', ...record.events.map(event => JSON.stringify(event)), '', '### なつみの動き'];
  record.calls.forEach((call, index) => {
    const number = index + 1;
    lines.push(`- 呼び出し ${number}${call.text ? `: 「${cut(call.text, CUT)}」` : ''}`);
    for (const tool of record.tools.filter(candidate => candidate.call === number)) {
      lines.push(`  - ${tool.name} ${cut(JSON.stringify(tool.args), CUT)}`, `    → ${tool.isError ? '（エラー）' : ''}${cut(tool.result, CUT).replace(/\n/g, '\n      ')}`);
    }
  });
  lines.push('', '### 本人に見せたもの', ...(record.replies.length > 0
    ? record.replies.map(reply => `- ${reply.kind === 'reply' ? '返事' : '知らせ'}（${reply.expression ?? '-'}）: ${reply.text}`) : ['- なし']));
  lines.push('', '### ポッポさんへの依頼', ...(record.dove.length > 0
    ? record.dove.map(request => `- ${request.ok ? '受け付けられた' : '断られた'}: ${request.message.replace(/\n/g, ' / ')}`) : ['- なし']));
  const answered = (record.actors ?? []).filter(exchange => exchange.reply !== undefined);
  if (answered.length > 0) {
    lines.push('', '### 相手役の返事（評価のために立てた相手）', ...answered.map(exchange =>
      `- ${exchange.agent}${exchange.result ? `（${exchange.result}）` : ''}: ${cut(exchange.reply ?? '', CUT).replace(/\n/g, ' / ')}`));
  }
  lines.push('', `終わり方: ${record.outcome}（${record.turns && record.turns > 1 ? `${record.turns} ターン、` : ''}モデルの呼び出し ${record.modelCalls} 回）`);
  return lines.join('\n');
}

function cut(text: string, max: number): string {
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : text;
}
