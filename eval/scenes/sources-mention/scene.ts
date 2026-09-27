import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SetupContext } from '../../../src/eval/hooks.ts';
import type { RunRecord, ToolRecord } from '../../../src/eval/record.ts';

/**
 * The made-up Slack archive of the scene, its history for sources-diff (ADR 0050), and the manual of each variant. Every
 * person, channel and line is fictional. The lines have the fields of PR #94's archive: `at`, `from`, `reply_to` (the
 * parent's line in the same file, counted from 0 as `jq -s` does), `text`, `images`, `reactions`, `deleted`.
 */

const run = promisify(execFile);
const DATE = '2026-09-27';

interface Line {
  at: string; from: string; reply_to?: number; text?: string; images?: string[];
  reactions?: { name: string; by: string[] }[]; deleted?: true;
}
type Draft = [from: string, text: string, replyTo?: number];

const DEV: Draft[] = [
  ['佐藤', 'おはようございます。今日もよろしくお願いします'], ['鈴木', 'おはようございます'],
  ['伊藤', 'CI のテストがまた不安定です。e2e の 3 本目がたまに落ちます'], ['高橋', '昨日のデプロイ、問題なく終わってました'],
  ['渡辺', '午後の定例の資料は共有フォルダに置きました'], ['佐藤', 'タイムアウトを延ばしてみますか？', 2],
  ['田中', '渡辺さん、資料ありがとうございます'], ['鈴木', 'ログを見ると DB の起動待ちっぽいです', 2],
  ['高橋', '今日の夕方、社内勉強会があります'], ['渡辺', '勉強会のテーマは何ですか'],
  ['伊藤', '起動待ちに retry を入れる PR を出しました', 2], ['高橋', '型の話です'], ['渡辺', '私も参加します'], ['鈴木', '勉強会、参加します'],
  ['田中', 'リリースの段取り、案が 2 つあります。A: 金曜の夕方に全部まとめて出す。B: 月曜の朝から 3 回に分けて出す。みなさんの意見をください'],
  ['佐藤', 'A だと、週末に何かあったときに対応できる人がいないのが心配です', 14], ['伊藤', 'PR のレビューをお願いします'], ['高橋', '見ます'],
  ['鈴木', 'B は手間ですが、問題が出たときの切り戻しは楽です', 14], ['田中', 'お昼に行ってきます'], ['渡辺', ''],
  ['佐藤', '会議室の予約、明日の分も取っておきました'], ['高橋', '監視の当番表だと、金曜の夜は私ひとりです', 14],
  ['伊藤', 'レビューありがとうございます、直しました'], ['鈴木', '今日のお菓子は北海道のです'], ['渡辺', 'いただきます'],
  ['伊藤', '月曜の朝は定例とかぶるので、10 時以降なら B でもいけます', 14], ['高橋', 'マージしました'],
  ['佐藤', 'ビルドの時間が少し延びている気がします'], ['田中', '戻りました'], ['鈴木', 'ビルドのキャッシュが効いていないのかも'],
  ['渡辺', '来週の大阪出張、宿はどこにしますか'], ['高橋', '金曜のリリースの件、どうなりました？'],
  ['佐藤', '駅前のビジネスホテルが空いていました', 31], ['伊藤', 'キャッシュの設定、見てみます'], ['渡辺', 'じゃあそこで取ります', 31],
  ['田中', '<@natsumi> さっきの件、なつみさんはどっちがいいと思う？', 14], ['鈴木', '定例の議事録を書きました'],
  ['高橋', '私も同じホテルでお願いします', 31], ['伊藤', 'キャッシュのキーがずれていました。直します'], ['佐藤', '私は B 寄りです', 14],
  ['渡辺', '了解です、2 部屋取ります', 31], ['鈴木', '明日は在宅です'], ['田中', '了解です'], ['高橋', '勉強会の資料ができました'],
  ['伊藤', '新しい linter を入れませんか。設定の案を書きました'], ['渡辺', '資料ありがとうございます'],
  ['佐藤', 'いいですね。ルールは少なめがいいです', 45], ['鈴木', '今日の勉強会、何時からでしたっけ'], ['高橋', '17 時からです'],
  ['鈴木', '自動で直せるルールだけにしませんか', 45], ['田中', '勉強会の部屋が変わりました。3 階です'], ['渡辺', 'ありがとうございます'],
  ['伊藤', 'ビルドが速くなりました'], ['佐藤', 'おー'], ['高橋', '賛成です', 45], ['鈴木', 'お先に失礼します'], ['渡辺', 'お疲れさまでした'],
  ['伊藤', '来週入れます', 45], ['田中', 'お疲れさまでした'],
];

const RANDOM: Draft[] = [
  ['高橋', 'コーヒーマシン、直ったみたいです'], ['渡辺', 'やった'], ['佐藤', '近くに新しいラーメン屋ができてました'], ['鈴木', '何系ですか'],
  ['佐藤', '魚介系です', 2], ['伊藤', '今度行きましょう', 2], ['田中', '週末は天気が崩れるらしいです'], ['渡辺', '洗濯物が…'],
  ['高橋', '猫の写真を貼ります'], ['鈴木', 'かわいい', 8], ['伊藤', 'うちの猫も似てます', 8], ['佐藤', '観葉植物に水をあげました'],
  ['田中', 'ありがとうございます'], ['渡辺', '給湯室のお茶、補充しておきました'],
  // Shown before up to here; the last six came since.
  ['高橋', 'ラーメン屋、行ってきました'], ['鈴木', 'どうでした？', 14], ['高橋', 'スープがおいしかったです', 14],
  ['伊藤', '今度みんなで行きましょう'], ['渡辺', '賛成'], ['佐藤', '来週の水曜はどうですか'],
];

const DEV_YESTERDAY: Draft[] = [['佐藤', 'お疲れさまです'], ['伊藤', '明日のリリースの話、明日しましょう'], ['高橋', '了解です'],
  ['鈴木', '勉強会の日程、明日で確定です'], ['渡辺', '資料作ります'], ['田中', 'よろしくお願いします']];
const RANDOM_YESTERDAY: Draft[] = [['渡辺', '雨ですね'], ['高橋', '傘を忘れました'], ['鈴木', '置き傘があります', 1]];

const MENTION_INDEX = 36;
const PARENT_INDEX = 14;
const THREAD_REPLY_INDICES = [15, 18, 22, 26, 36, 40];
/** Lines shown in an earlier event; sources-diff shows the rest. */
const SEEN_DEV = 30;
const SEEN_RANDOM = 14;

const clock = (seconds: number) => [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
  .map(n => String(n).padStart(2, '0')).join(':');

/** 09:05 onwards every nine minutes until the mention at 14:32:05, then a busy afternoon of 80 seconds a line. */
function devTime(index: number): string {
  if (index === MENTION_INDEX) return '14:32:05';
  const base = index < MENTION_INDEX ? 9 * 3600 + 5 * 60 + index * 9 * 60 : 14 * 3600 + 32 * 60 + 5 + (index - MENTION_INDEX) * 80;
  return clock(base + ((index * 17 + 3) % 40));
}

function build(date: string, drafts: Draft[], time: (index: number) => string, extras: Record<number, Partial<Line>> = {}): Line[] {
  return drafts.map(([from, text, replyTo], index) => {
    const base: Line = { at: `${date} ${time(index)}`, from, ...(replyTo === undefined ? {} : { reply_to: replyTo }) };
    const extra = extras[index] ?? {};
    return extra.deleted ? { ...base, deleted: true } : { ...base, text, ...extra };
  });
}

const devLines = build(DATE, DEV, devTime, {
  14: { reactions: [{ name: 'eyes', by: ['佐藤', '鈴木'] }] }, 20: { deleted: true },
  27: { reactions: [{ name: 'tada', by: ['伊藤'] }] }, 53: { reactions: [{ name: '+1', by: ['高橋', '田中'] }] },
});
const randomLines = build(DATE, RANDOM, index => clock(10 * 3600 + index * 13 * 60 + ((index * 7) % 50)),
  { 8: { images: [`/sources/slack/work/random/files/${DATE}-100000-000100-1.png`] } });
const jsonl = (lines: Line[]) => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`;

const INDEX_MD = `# Slack

サーバーが書いている Slack の記録の目次です。チャンネルごとに、最後に発言が記録された時刻と、いちばん新しいファイルがあります。
読み方は /manual/slack.md にあります。

| チャンネル | 最後の発言 | いちばん新しいファイル |
| --- | --- | --- |
| work/#dev | ${devLines.at(-1)!.at} | /sources/slack/work/dev/${DATE}.jsonl |
| work/#random | ${randomLines.at(-1)!.at} | /sources/slack/work/random/${DATE}.jsonl |
`;

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');

/**
 * The archive, and the history the server keeps of it (PR #94): one commit with what was shown before and one with now,
 * `refs/before/<hex(dir)>` and `refs/seen/<hex(dir)>` on them, and `natsumi-last-event` naming both directories.
 * INDEX.md stays out of the history, as the Slack source leaves it. Then the manual of the variant.
 */
export async function prepare(context: SetupContext): Promise<void> {
  const sources = join(context.data, 'sources');
  const dev = join(sources, 'slack', 'work', 'dev');
  const random = join(sources, 'slack', 'work', 'random');
  for (const dir of [dev, random]) await mkdir(dir, { recursive: true });
  await writeFile(join(sources, 'slack', 'INDEX.md'), INDEX_MD);
  await writeFile(join(dev, '2026-09-26.jsonl'), jsonl(build('2026-09-26', DEV_YESTERDAY, index => clock(16 * 3600 + index * 11 * 60 + 12))));
  await writeFile(join(random, '2026-09-26.jsonl'), jsonl(build('2026-09-26', RANDOM_YESTERDAY, index => clock(12 * 3600 + index * 31 * 60 + 40))));

  const gitDir = join(context.data, 'sources.git');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_DIR: gitDir, GIT_WORK_TREE: sources, GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'natsumi', GIT_AUTHOR_EMAIL: 'natsumi@example.invalid', GIT_COMMITTER_NAME: 'natsumi',
    GIT_COMMITTER_EMAIL: 'natsumi@example.invalid' };
  const git = (args: string[], date?: string) => run('git', args, { cwd: sources,
    env: date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env });
  // Bare, so that no path of this machine is written into its config: in the workspace it is /sources.git.
  await run('git', ['init', '-q', '--bare', gitDir], { env: { PATH: env.PATH } });
  await git(['config', 'core.bare', 'false']);
  const commit = async (devShown: number, randomShown: number, date: string) => {
    await writeFile(join(dev, `${DATE}.jsonl`), jsonl(devLines.slice(0, devShown)));
    await writeFile(join(random, `${DATE}.jsonl`), jsonl(randomLines.slice(0, randomShown)));
    await git(['add', '-A', '--', '.', ':(exclude)slack/INDEX.md']);
    await git(['commit', '-q', '--no-gpg-sign', '-m', 'sources'], date);
    return (await git(['rev-parse', 'HEAD'])).stdout.trim();
  };
  const before = await commit(SEEN_DEV, SEEN_RANDOM, '2026-09-27T12:40:00+09:00');
  const seen = await commit(devLines.length, randomLines.length, '2026-09-27T15:08:30+09:00');
  const dirs = ['slack/work/dev', 'slack/work/random'];
  for (const dir of dirs) {
    await git(['update-ref', `refs/before/${hex(dir)}`, before]);
    await git(['update-ref', `refs/seen/${hex(dir)}`, seen]);
  }
  await writeFile(join(gitDir, 'natsumi-last-event'), `${dirs.join('\n')}\n`);

  const [location, manual] = context.variant.split('/') as [string, string];
  const page = join(context.manual, 'slack.md');
  await writeFile(page, slackManual(await readFile(page, 'utf8'), location, manual));
}

// ── The manual: PR #94's page, with the location sentences of the variant, and without how to read for `without` ──

const ARRIVES_LOCATION = '  - `file` がその発言のあるファイル、`path` がファイルの中の場所（`jq -s` のパス）です。';
const STEP_ONE = "1. 発言そのものを読みます: `jq -s '.[12]' /sources/slack/work/dev/2026-09-25.jsonl`（`.[12]` は出来事の `path`）。";
const TO_STEPS = '  - 本文も前後の流れも出来事には載っていません。次の「メンションに応える」の手順で読みます。';
const COUNTING = "  - 行の番号は 0 から数えます。`jq -s '.[N]'` が N 番目の行です。行はあとで動きません。";
const SEARCH = /^- 探すときは `rg` か `jq` が便利です.*\n/m;
const EXAMPLE_FILE = '/sources/slack/work/dev/2026-09-25.jsonl';

function arrivesLocation(location: string): string {
  const head = '  - `file` がその発言のあるファイル、';
  switch (location) {
    case 'A': return `${head}\`jq\` がその発言を読むコマンドです（そのまま run_shell で動かせます）。`;
    case 'B': return `${head}\`jq_slurp_path\` がファイルの中の場所（\`jq -s\` のパス）です。`;
    case 'C': return `${head}\`line\` がファイルの中の場所（何行目か。1 から数える）です。`;
    case 'AC': return `${head}\`line\` がファイルの中の場所（何行目か。1 から数える）、\`jq\` がその発言を読むコマンドです。`;
    default: return ARRIVES_LOCATION;
  }
}

function stepOne(location: string): string {
  switch (location) {
    case 'A': return `1. 発言そのものを読みます: 出来事の \`jq\` をそのまま run_shell で動かします（例: \`jq -s '.[12]' ${EXAMPLE_FILE}\`）。`;
    case 'B': return `1. 発言そのものを読みます: \`jq -s '.[12]' ${EXAMPLE_FILE}\`（\`.[12]\` は出来事の \`jq_slurp_path\`）。`;
    case 'C': return `1. 発言そのものを読みます: \`sed -n '13p' ${EXAMPLE_FILE}\`（\`13\` は出来事の \`line\`）。`;
    case 'AC': return `1. 発言そのものを読みます: 出来事の \`jq\` をそのまま run_shell で動かすか、\`sed -n '13p' ${EXAMPLE_FILE}\`（\`13\` は出来事の \`line\`）で読みます。`;
    default: return STEP_ONE;
  }
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}`);
  if (start < 0) throw new Error(`/manual/slack.md has no section ${heading}`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

function replaceOnce(text: string, from: string | RegExp, to: string): string {
  if (!(typeof from === 'string' ? text.includes(from) : from.test(text))) throw new Error(`/manual/slack.md: ${String(from)} not found`);
  return text.replace(from, to);
}

function slackManual(page: string, location: string, manual: string): string {
  let text = replaceOnce(page, ARRIVES_LOCATION, arrivesLocation(location));
  text = replaceOnce(text, STEP_ONE, stepOne(location));
  if (manual !== 'without') return text;
  text = text.replace(section(text, 'メンションに応える'), '').replace(section(text, '差分を見る（sources-diff）'), '');
  text = replaceOnce(text, TO_STEPS, '  - 本文も前後の流れも出来事には載っていません。ファイルから読みます。');
  text = replaceOnce(text, `${COUNTING}\n`, '');
  return replaceOnce(text, SEARCH, '');
}

// ── A check the rule parts cannot express ──

const MENTION_MARK = 'なつみさんはどっちがいいと思う';
/** Lines worth pointing at, 1-based: the mention, the parent and the thread. */
const RELEVANT_LINES = new Set([MENTION_INDEX + 1, PARENT_INDEX + 1, ...THREAD_REPLY_INDICES.map(index => index + 1)]);

const command = (tool: ToolRecord) => tool.name === 'run_shell' ? String(tool.args.command ?? '') : '';
const slurps = (text: string) => /\bjq\b[^|;&]*?(\s--slurp\b|\s-[a-zA-Z]*s[a-zA-Z]*\b)/.test(text);

function pointedLines(text: string): number[] {
  const lines: number[] = [];
  for (const match of text.matchAll(/sed\s+-n\s+['"]?(\d+)p/g)) lines.push(Number(match[1]));
  for (const match of text.matchAll(/NR\s*==\s*(\d+)/g)) lines.push(Number(match[1]));
  if (/\bjq\b/.test(text)) for (const match of text.matchAll(/\.\[(\d+)\]/g)) lines.push(Number(match[1]) + 1);
  return lines;
}

/**
 * The mention was read, and nothing missed before it: jq without -s pointing at a line, a command pointing at an
 * unrelated line of #dev, or a path that is not there.
 */
export function mentionWithoutMiss(record: RunRecord): { pass: boolean; detail: string } {
  let misses = 0;
  for (const tool of record.tools) {
    const text = command(tool);
    if (text === '' && tool.name !== 'read') continue;
    const shows = tool.result.includes(MENTION_MARK);
    if (shows) return { pass: misses === 0, detail: `メンションを読むまでの空振り ${misses} 回（${tool.call} 回目の呼び出しで読んだ）` };
    const lines = pointedLines(text);
    if ((/\bjq\b/.test(text) && /\.\[\d+\]/.test(text) && !slurps(text))
      || (text.includes('/dev/') && lines.length > 0 && lines.every(line => !RELEVANT_LINES.has(line)))
      || /No such file|まだ更新として見せたことがありません|の下ではありません|ファイルが見つかりません|読んでいません（/.test(tool.result)) {
      misses += 1;
    }
  }
  return { pass: false, detail: `メンションを読んでいない（空振り ${misses} 回）` };
}
