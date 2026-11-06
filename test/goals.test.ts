import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { goalsPage } from '../src/server/dashboard-lists.ts';
import {
  CONSENT_HEADINGS, DEFAULT_GOAL_FILE_MAX_CHARS, DEFAULT_TODAY_PLAN_MAX_CHARS, GOAL_HEADINGS, GOALS_DIRECTORY, inGoals, isGoalFile,
  readGoalChanges, sectionOf, TODAY_FILE,
} from '../src/server/goals.ts';
import { isRewritable } from '../src/server/memory-curator.ts';
import { BASE_INSTRUCTION } from '../src/server/prompts.ts';
import { DEFAULT_FILE_MAX_CHARS, MemoryRepository } from '../src/server/memory-repository.ts';

/**
 * Goals (ADR 0090): memory's `goals/`, one file a lasting goal and `today.md` for the day's plan. The server names the
 * directory, puts limits on its files at the end of a turn, keeps the curator off it, and shows the owner from git what
 * changed in the parts that need the owner's consent.
 */

// Fictional goals only.
const goal = (why: string, routine: string, state = '- 2026-10-30: 変わりなし', short = '- まだ無し') =>
  `# クラスタを健康に保つ\n\n## なぜ\n${why}\n\n## 日課\n${routine}\n\n## 今の様子\n${state}\n\n## 短い目標\n${short}\n`;
const PLAN = '# 2026-10-31\n\n- [ ] cluster-health: アラートの一覧を見る（日課）\n';

async function setup(options: { goalFileMaxChars?: number; todayPlanMaxChars?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-goals-')));
  const data = join(root, 'data');
  const directory = join(data, 'memory');
  await mkdir(directory, { recursive: true });
  const repository = new MemoryRepository({ directory, dataDirectory: data, ...options });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', directory, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();
  const write = async (name: string, text: string) => {
    await mkdir(join(directory, name, '..'), { recursive: true });
    await writeFile(join(directory, name), text);
  };
  return {
    root, directory, repository, git, write,
    read: (name: string) => readFile(join(directory, name), 'utf8'),
    /** The owner's commit over ssh, under the owner's name, at a time of the test's. */
    ownerCommit(message: string, at = '2026-10-31T09:00:00+09:00', name = 'owner') {
      const env = { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
      execFileSync('git', ['-C', directory, '-c', `user.name=${name}`, '-c', 'user.email=owner@example.invalid', 'add', '-A'], { env });
      execFileSync('git', ['-C', directory, '-c', `user.name=${name}`, '-c', 'user.email=owner@example.invalid', 'commit', '-q',
        '--allow-empty', '-m', message], { env });
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('the server names goals/, today.md in it, and the four sections; two of them need the owner\'s consent', () => {
  assert.equal(GOALS_DIRECTORY, 'goals');
  assert.equal(TODAY_FILE, 'goals/today.md');
  assert.deepEqual(Object.values(GOAL_HEADINGS), ['なぜ', '日課', '今の様子', '短い目標']);
  assert.deepEqual(CONSENT_HEADINGS, ['なぜ', '日課']);
  for (const path of ['goals', 'goals/today.md', 'goals/cluster-health.md', 'goals/sub/x.md']) assert.equal(inGoals(path), true, path);
  for (const path of ['goalsx.md', 'my-goals/a.md', '目標.md']) assert.equal(inGoals(path), false, path);
  // A lasting goal is any Markdown file directly in goals/ but today.md.
  assert.equal(isGoalFile('goals/cluster-health.md'), true);
  for (const path of ['goals/today.md', 'goals/sub/x.md', 'goals/notes.txt', 'cluster-health.md']) assert.equal(isGoalFile(path), false, path);
  // Both limits sit well below one memory file's.
  assert.ok(DEFAULT_GOAL_FILE_MAX_CHARS < DEFAULT_FILE_MAX_CHARS);
  assert.ok(DEFAULT_TODAY_PLAN_MAX_CHARS < DEFAULT_GOAL_FILE_MAX_CHARS);
});

test('a section is the lines under its ## heading up to the next heading, or undefined when there is none', () => {
  const text = goal('マスターの仕事が止まらないように。', '- アラートを見る\n- ノードの数を見る');
  assert.equal(sectionOf(text, 'なぜ'), 'マスターの仕事が止まらないように。');
  assert.equal(sectionOf(text, '日課'), '- アラートを見る\n- ノードの数を見る');
  assert.equal(sectionOf(text, '短い目標'), '- まだ無し');
  assert.equal(sectionOf('# 目標\n\n本文だけ\n', 'なぜ'), undefined);
  // A deeper heading is part of the section; a heading of the same level ends it.
  assert.equal(sectionOf('## 日課\n- a\n### 補足\n- b\n## 今の様子\n- c\n', '日課'), '- a\n### 補足\n- b');
});

// MARK: - The check at the end of a turn

test('a goal file and today.md past their limits go back, each with its own limit in the reason', async () => {
  const f = await setup({ goalFileMaxChars: 400, todayPlanMaxChars: 200 });
  try {
    await f.repository.initialize(undefined);
    await f.write('goals/cluster-health.md', goal('理由', '- 見る'));
    await f.write('goals/today.md', PLAN);
    assert.deepEqual((await f.repository.commit({ event: 'ping' })).files.sort(), ['goals/cluster-health.md', 'goals/today.md']);

    await f.write('goals/cluster-health.md', goal('理由', '- 見る', `- 2026-10-31: ${'様子'.repeat(200)}`));
    await f.write('goals/today.md', `${PLAN}${'- [ ] もっと\n'.repeat(40)}`);
    // A topic as long is fine: the goals' limits are for goals/ alone.
    await f.write('暮らし.md', `# 暮らし\n\n${'あ'.repeat(600)}\n`);
    const outcome = await f.repository.commit({ event: 'ping' });
    assert.deepEqual(outcome.files, ['暮らし.md']);
    assert.deepEqual(outcome.reverted.map(file => file.path).sort(), ['goals/cluster-health.md', 'goals/today.md']);
    const reason = (path: string) => outcome.reverted.find(file => file.path === path)!.reason;
    assert.match(reason('goals/cluster-health.md'), /長く続く目標のファイルの上限（400 文字）/);
    assert.match(reason('goals/today.md'), /今日の計画の上限（200 文字）/);
    // Back to what was committed.
    assert.equal(await f.read('goals/today.md'), PLAN);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally { await f.cleanup(); }
});

test('the limits default to the goals\' own, below one memory file\'s', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    await f.write('goals/today.md', `# 2026-10-31\n\n${'あ'.repeat(DEFAULT_TODAY_PLAN_MAX_CHARS)}\n`);
    await f.write('goals/cluster-health.md', goal('理由', '- 見る', 'い'.repeat(DEFAULT_GOAL_FILE_MAX_CHARS)));
    const outcome = await f.repository.commit({ event: 'ping' });
    assert.equal(outcome.committed, false);
    assert.match(outcome.reverted.find(file => file.path === 'goals/today.md')!.reason, new RegExp(`${DEFAULT_TODAY_PLAN_MAX_CHARS} 文字`));
    assert.match(outcome.reverted.find(file => file.path === 'goals/cluster-health.md')!.reason, new RegExp(`${DEFAULT_GOAL_FILE_MAX_CHARS} 文字`));
  } finally { await f.cleanup(); }
});

test('a directory under goals/ goes back, whatever is in it; a goal file may be added and removed', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    await f.write('goals/cluster-health.md', goal('理由', '- 見る'));
    await f.write('goals/done/old.md', goal('古い', '- 無し'));
    await f.write('goals/today/2026-10-31.md', PLAN);
    const outcome = await f.repository.commit({ event: 'ping' });
    assert.deepEqual(outcome.files, ['goals/cluster-health.md']);
    assert.deepEqual(outcome.reverted.map(file => file.path).sort(), ['goals/done/old.md', 'goals/today/2026-10-31.md']);
    for (const file of outcome.reverted) assert.match(file.reason, /goals\/ の下にはディレクトリを作れません/);
    assert.equal(f.git('status', '--porcelain'), '');
    // Removing a lasting goal is hers to do once the owner agrees: the server does not refuse it (ADR 0090).
    await rm(join(f.directory, 'goals', 'cluster-health.md'));
    assert.deepEqual((await f.repository.commit({ event: 'mac_message' })).files, ['goals/cluster-health.md']);
  } finally { await f.cleanup(); }
});

test('the curator may not change, add, move or take away anything in goals/: the whole stage is thrown away', async () => {
  const cases: [string, (f: Awaited<ReturnType<typeof setup>>) => Promise<void>][] = [
    ['a goal rewritten', f => f.write('goals/cluster-health.md', goal('言い換えた理由', '- 見る'))],
    ['the plan rewritten', f => f.write('goals/today.md', `${PLAN}- [ ] 足した\n`)],
    ['a goal removed', f => rm(join(f.directory, 'goals', 'cluster-health.md'))],
    ['a goal added', f => f.write('goals/new.md', goal('新しい', '- 無し'))],
    ['a goal moved out', async f => {
      await f.write('クラスタ.md', await f.read('goals/cluster-health.md'));
      await rm(join(f.directory, 'goals', 'cluster-health.md'));
    }],
  ];
  for (const [label, act] of cases) {
    const f = await setup();
    try {
      await f.write('goals/cluster-health.md', goal('理由', '- 見る'));
      await f.write('goals/today.md', PLAN);
      await f.repository.initialize(undefined);
      const head = f.git('rev-parse', 'HEAD');
      await act(f);
      const outcome = await f.repository.commitCuration({ message: '整理した' });
      assert.equal(outcome.committed, false, label);
      assert.ok(outcome.rejected.some(file => file.path.startsWith('goals/') && /目標/.test(file.reason)), `${label}: ${JSON.stringify(outcome.rejected)}`);
      assert.equal(f.git('rev-parse', 'HEAD'), head, label);
    } finally { await f.cleanup(); }
  }
});

test('the curator is never given a file of goals/ to rewrite', () => {
  for (const path of ['goals/cluster-health.md', 'goals/today.md']) assert.equal(isRewritable(path), false, path);
});

// MARK: - The plan as HEAD holds it

test('today.md is read from HEAD alone: never the working tree, and nothing when it is missing, empty or no file', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    assert.equal(await f.repository.committedTodayPlan(), undefined);
    await f.write('goals/today.md', PLAN);
    assert.equal(await f.repository.committedTodayPlan(), undefined, 'written but not committed');
    await f.repository.commit({ event: 'ping' });
    assert.equal(await f.repository.committedTodayPlan(), PLAN);
    await f.write('goals/today.md', `${PLAN}- [ ] まだコミットしていない\n`);
    assert.equal(await f.repository.committedTodayPlan(), PLAN);
    // The owner's commit is not checked; a link or a blank plan is still no plan.
    await rm(join(f.directory, 'goals', 'today.md'));
    await f.write('goals/plan.md', PLAN);
    await symlink('plan.md', join(f.directory, 'goals', 'today.md'));
    f.ownerCommit('link');
    assert.equal(await f.repository.committedTodayPlan(), undefined);
    await rm(join(f.directory, 'goals', 'today.md'));
    await f.write('goals/today.md', '\n  \n');
    f.ownerCommit('blank');
    assert.equal(await f.repository.committedTodayPlan(), undefined);
  } finally { await f.cleanup(); }
});

// MARK: - What changed in the parts that need consent, from git (ADR 0090)

test('the changes are the goal files made and removed and the sections なぜ and 日課 changed, newest first, from git', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    await f.write('goals/cluster-health.md', goal('マスターの仕事が止まらないように。', '- アラートを見る'));
    f.ownerCommit('made', '2026-10-29T09:00:00+09:00', 'owner');
    // Her free parts change: the state, the short goals, and the plan. None of it is listed.
    await f.write('goals/cluster-health.md', goal('マスターの仕事が止まらないように。', '- アラートを見る', '- 2026-10-30: 静か', '- [ ] OS を上げる'));
    await f.write('goals/today.md', PLAN);
    f.ownerCommit('state', '2026-10-30T09:00:00+09:00', 'なつみ');
    // The routine changes, after the owner agreed.
    await f.write('goals/cluster-health.md', goal('マスターの仕事が止まらないように。', '- アラートを見る\n- ノードの数を見る', '- 2026-10-30: 静か', '- [ ] OS を上げる'));
    f.ownerCommit('routine', '2026-10-31T10:00:00+09:00', 'なつみ');
    await f.write('goals/reading.md', goal('マスターが読みたい本を忘れないように。', '- 新刊を見る'));
    await rm(join(f.directory, 'goals', 'cluster-health.md'));
    f.ownerCommit('swap', '2026-10-31T11:00:00+09:00', 'なつみ');
    // A directory under goals/ the owner committed is not a goal.
    await f.write('goals/old/x.md', goal('古い', '- 無し'));
    f.ownerCommit('dir', '2026-10-31T12:00:00+09:00', 'owner');

    const changes = await readGoalChanges(f.directory);
    assert.deepEqual(changes.map(change => [change.path, change.kind, change.author, change.at]), [
      ['goals/cluster-health.md', 'deleted', 'なつみ', '2026-10-31T11:00:00+09:00'],
      ['goals/reading.md', 'created', 'なつみ', '2026-10-31T11:00:00+09:00'],
      ['goals/cluster-health.md', 'changed', 'なつみ', '2026-10-31T10:00:00+09:00'],
      ['goals/cluster-health.md', 'created', 'owner', '2026-10-29T09:00:00+09:00'],
    ]);
    const [deleted, created, changed, first] = changes;
    // A change shows only the consent sections that moved, line by line.
    assert.deepEqual(changed!.sections, [{ heading: '日課', lines: [
      { sign: ' ', text: '- アラートを見る' }, { sign: '+', text: '- ノードの数を見る' }] }]);
    // A goal made or removed shows its whole なぜ and 日課.
    assert.deepEqual(created!.sections, [
      { heading: 'なぜ', lines: [{ sign: '+', text: 'マスターが読みたい本を忘れないように。' }] },
      { heading: '日課', lines: [{ sign: '+', text: '- 新刊を見る' }] }]);
    assert.deepEqual(deleted!.sections.map(section => [section.heading, section.lines.map(line => line.sign)]),
      [['なぜ', ['-']], ['日課', ['-', '-']]]);
    assert.equal(first!.commit.length, 40);
    // The limit keeps the newest.
    assert.deepEqual((await readGoalChanges(f.directory, { limit: 2 })).map(change => change.kind), ['deleted', 'created']);
  } finally { await f.cleanup(); }
});

test('a heading renamed reads as its section gone, and a repository without goals lists nothing', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    assert.deepEqual(await readGoalChanges(f.directory), []);
    await f.write('goals/cluster-health.md', goal('理由', '- 見る'));
    f.ownerCommit('made');
    await f.write('goals/cluster-health.md', (await f.read('goals/cluster-health.md')).replace('## 日課', '## 毎日'));
    f.ownerCommit('renamed');
    const [change] = await readGoalChanges(f.directory);
    assert.equal(change!.kind, 'changed');
    assert.deepEqual(change!.sections, [{ heading: '日課', lines: [{ sign: '-', text: '- 見る' }] }]);
  } finally { await f.cleanup(); }
});

test('the goals page lists each change with its time, writer, file and lines, and escapes what it shows', () => {
  const page = goalsPage([
    { commit: 'a'.repeat(40), at: '2026-10-31T10:00:00+09:00', author: 'なつみ', path: 'goals/cluster-health.md', kind: 'changed',
      sections: [{ heading: '日課', lines: [{ sign: ' ', text: '- アラートを見る' }, { sign: '+', text: '- <img src=x>' }] }] },
    { commit: 'b'.repeat(40), at: '2026-10-29T09:00:00+09:00', author: 'owner', path: 'goals/reading.md', kind: 'created',
      sections: [{ heading: 'なぜ', lines: [{ sign: '+', text: '本を忘れないように。' }] }] },
  ], 'Asia/Tokyo').text;
  assert.match(page, /<section id="goals">/);
  assert.match(page, /2026-10-31 10:00/);
  assert.match(page, /なつみ/);
  assert.match(page, /goals\/cluster-health\.md/);
  assert.match(page, /「日課」を変えた/);
  assert.match(page, /作った/);
  assert.match(page, /\+ - &lt;img src=x&gt;/);
  assert.ok(!page.includes('<img src=x>'));
  const section = page.slice(page.indexOf('<section id="goals">'), page.indexOf('</section>', page.indexOf('<section id="goals">')));
  assert.ok(!section.includes('<form'), 'the page only shows');
  assert.match(goalsPage([], 'Asia/Tokyo').text, /まだ変更はありません/);
});

// MARK: - What she is told

test('the ping is described in fixed words that send her to the plan, the goals and the manual', () => {
  const prompt = BASE_INSTRUCTION('');
  const line = prompt.split('\n').find(text => text.startsWith('- ping:'))!;
  assert.ok(line, prompt);
  assert.doesNotMatch(line, /何かしたいことは/);
  for (const words of ['today_plan', '/memory/goals/today.md', '/manual/goals.md', 'reply_to_mac', 'notify_owner', 'unacknowledged_notices', 'read']) {
    assert.ok(line.includes(words), words);
  }
  // A plan done, or a reply awaited, is no reason to speak to the owner; what waits on a reply waits for it.
  assert.match(line, /済んだことや返事を待っていることだけでは、マスターに話しかけません/);
  assert.match(line, /返事が来るまで進めません/);
  // The tools of the night are not for a ping, as their own descriptions say.
  assert.match(line, /write_change_note・write_handoff_note は夜の振り返りと昼寝でだけ使うので、ping では呼びません/);
  // The same words whoever the avatar is: nothing in it is built from a setting or from memory.
  assert.equal(BASE_INSTRUCTION('', { id: 'hana', name: 'はな' }).split('\n').find(text => text.startsWith('- ping:')), line);
});

test('the manual names the four sections as the server reads them, and the date that heads today.md', async () => {
  const manual = await readFile(new URL('../manual/goals.md', import.meta.url), 'utf8');
  for (const heading of Object.values(GOAL_HEADINGS)) assert.match(manual, new RegExp(`^## ${heading}$`, 'm'), heading);
  assert.match(manual, /^# 2026-10-31$/m);
  assert.match(manual, /goals\/today\.md/);
  // Done things and things awaiting a reply are not reported; what awaits a reply is not pressed or done ahead.
  assert.match(manual, /済んだことや返事を待っていることだけでは、マスターに話しかけません/);
  assert.match(manual, /重ねて聞かず、先回りして作りません/);
  assert.match(manual, /write_change_note・write_handoff_note/);
  const index = await readFile(new URL('../manual/INDEX.md', import.meta.url), 'utf8');
  assert.match(index, /\/manual\/goals\.md/);
});
