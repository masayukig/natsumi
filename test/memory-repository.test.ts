import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ALWAYS_FILE, HANDOFF_FILE, INDEX_FILE, MemoryRepository, PERSONALITY_FILE, revertNotice } from '../src/server/memory-repository.ts';
import { gitIdentity, type GitIdentity } from '../src/server/git.ts';
import { SERVER_UMASK } from '../src/server/permissions.ts';

// Fictional memories only.
const PASSPHRASE = 'SYNTHETIC-HERON-208';

async function setup(options: { fileMaxChars?: number; alwaysMaxChars?: number; personality?: string; identity?: GitIdentity } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-memory-repo-')));
  const data = join(root, 'data');
  const directory = join(data, 'memory');
  await mkdir(directory, { recursive: true });
  const repository = new MemoryRepository({ directory, dataDirectory: data, ...options });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', directory, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();
  return {
    root, data, directory, repository, git,
    commits: () => Number(git('rev-list', '--count', 'HEAD')),
    subject: () => git('log', '-1', '--format=%s'),
    clean: () => git('status', '--porcelain') === '',
    write: (name: string, text: string) => writeFile(join(directory, name), text),
    read: (name: string) => readFile(join(directory, name), 'utf8'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('the first start takes the memory that is there into one commit on main, unchanged', async () => {
  const f = await setup();
  try {
    const passphrase = `# 合言葉\n\n- 2026-09-15: 合言葉は ${PASSPHRASE}\n`;
    await f.write('合言葉.md', passphrase);
    await mkdir(join(f.directory, '仕事'), { recursive: true });
    await writeFile(join(f.directory, '仕事', '予定.md'), '# 予定\n\n- 2026-09-16: 歯医者は金曜\n');
    await writeFile(join(f.data, PERSONALITY_FILE), '# 性格・話し方\n\n落ち着いた話し方\n');

    await f.repository.initialize('昨夜の引き継ぎ');

    assert.equal(f.git('symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(f.commits(), 1);
    assert.equal(f.clean(), true);
    // Names and contents are untouched.
    assert.equal(await f.read('合言葉.md'), passphrase);
    assert.equal(await readFile(join(f.directory, '仕事', '予定.md'), 'utf8'), '# 予定\n\n- 2026-09-16: 歯医者は金曜\n');
    // personality.md moves out of the data directory into the repository.
    assert.match(await f.read(PERSONALITY_FILE), /落ち着いた話し方/);
    assert.deepEqual((await readdir(f.data)).sort(), ['memory']);
    assert.match(await f.read(ALWAYS_FILE), /\S/);
    assert.match(await f.read(HANDOFF_FILE), /昨夜の引き継ぎ/);
    assert.deepEqual(f.git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort(),
      [ALWAYS_FILE, HANDOFF_FILE, INDEX_FILE, PERSONALITY_FILE, '合言葉.md', '仕事/予定.md'].sort());
    // The server fixes who commits.
    const [author, committer] = f.git('log', '-1', '--format=%an <%ae>%n%cn <%ce>').split('\n');
    assert.equal(author, committer);
    assert.match(author!, /^natsumi <.+@.+>$/);
  } finally { await f.cleanup(); }
});

test('a start with nothing to take in still leaves the fixed files committed, INDEX.md among them', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    assert.equal(f.commits(), 1);
    assert.deepEqual(f.git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort(),
      [ALWAYS_FILE, HANDOFF_FILE, INDEX_FILE, PERSONALITY_FILE].sort());
    for (const name of [ALWAYS_FILE, HANDOFF_FILE, INDEX_FILE, PERSONALITY_FILE]) assert.match(await f.read(name), /\S/);
    // The template says who writes it, for whoever opens it first (ADR 0055).
    assert.match(await f.read(INDEX_FILE), /整理係/);
  } finally { await f.cleanup(); }
});

/**
 * The avatar's personality.md (ADR 0060) is where her personality starts from, and only that: it is written when the
 * repository has no personality.md and no older layout left one, and never over one that is there, since what is there
 * is what she has grown into at night. Switching the avatar does not switch the personality.
 */
const HANA_PERSONALITY = '# 性格・話し方\n\nのんびりしていて、語尾をのばす。\n';

test('the avatar\'s personality is where a new memory\'s personality starts', async () => {
  const f = await setup({ personality: HANA_PERSONALITY });
  try {
    await f.repository.initialize(undefined);
    assert.equal(await f.read(PERSONALITY_FILE), HANA_PERSONALITY);
    assert.equal(f.git('show', `HEAD:${PERSONALITY_FILE}`) + '\n', HANA_PERSONALITY);
    assert.equal(f.clean(), true);
  } finally { await f.cleanup(); }
});

test('without the avatar\'s personality the template names the avatar', async () => {
  const f = await setup({ identity: gitIdentity({ id: 'hana', name: 'はな' }) });
  try {
    await f.repository.initialize(undefined);
    assert.equal(await f.read(PERSONALITY_FILE), '# 性格・話し方\n\nはなの性格と話し方をここに書きます。夜の再構成のときだけ書き換えられます。\n');
  } finally { await f.cleanup(); }
  const plain = await setup();
  try {
    await plain.repository.initialize(undefined);
    assert.match(await plain.read(PERSONALITY_FILE), /^# 性格・話し方\n\nなつみの性格と話し方をここに書きます。/);
  } finally { await plain.cleanup(); }
});

test('a personality the older layout left wins over the avatar\'s', async () => {
  const f = await setup({ personality: HANA_PERSONALITY });
  try {
    await writeFile(join(f.data, PERSONALITY_FILE), '# 性格・話し方\n\n落ち着いた話し方\n');
    await f.repository.initialize(undefined);
    assert.equal(await f.read(PERSONALITY_FILE), '# 性格・話し方\n\n落ち着いた話し方\n');
    assert.deepEqual((await readdir(f.data)).sort(), ['memory']);
  } finally { await f.cleanup(); }
});

test('a personality the memory has is kept, whichever avatar the server starts with', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    await f.write(PERSONALITY_FILE, '# 性格・話し方\n\n夜に育った性格\n');
    f.git('-c', 'user.name=owner', '-c', 'user.email=owner@example.net', 'commit', '-am', 'grown');
    const commits = f.commits();

    // The server comes back with another avatar, one that has a personality of its own.
    await new MemoryRepository({ directory: f.directory, dataDirectory: f.data, personality: HANA_PERSONALITY }).initialize(undefined);
    assert.equal(await f.read(PERSONALITY_FILE), '# 性格・話し方\n\n夜に育った性格\n');
    assert.equal(f.commits(), commits);
    assert.equal(f.clean(), true);
  } finally { await f.cleanup(); }
});

test('an existing repository without a personality takes the avatar\'s, and keeps its history', async () => {
  const f = await setup({ personality: HANA_PERSONALITY });
  try {
    execFileSync('git', ['-C', f.directory, 'init', '-b', 'main'], { stdio: 'ignore' });
    await f.write('予定.md', '# 予定\n\n- 2026-09-16: 歯医者は金曜\n');
    f.git('add', '-A');
    f.git('-c', 'user.name=owner', '-c', 'user.email=owner@example.net', 'commit', '-m', 'my memory');
    await f.repository.initialize(undefined);
    assert.equal(f.commits(), 2);
    assert.equal(await f.read(PERSONALITY_FILE), HANA_PERSONALITY);
  } finally { await f.cleanup(); }
});

test('an existing repository keeps its history, and only the missing files are added', async () => {
  const f = await setup();
  try {
    // A repository the owner made, with memory in it and none of the three fixed files.
    execFileSync('git', ['-C', f.directory, 'init', '-b', 'main'], { stdio: 'ignore' });
    await f.write('\u5408\u8a00\u8449.md', `# \u5408\u8a00\u8449\n\n- 2026-09-15: ${PASSPHRASE}\n`);
    f.git('add', '-A');
    f.git('-c', 'user.name=owner', '-c', 'user.email=owner@example.net', 'commit', '-m', 'my memory');
    const first = f.git('rev-parse', 'HEAD');

    await f.repository.initialize('\u6700\u521d\u306e\u5f15\u304d\u7d99\u304e');

    assert.equal(f.commits(), 2);
    assert.equal(f.git('rev-parse', 'HEAD~1'), first);
    assert.deepEqual(f.git('diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').sort(),
      [ALWAYS_FILE, HANDOFF_FILE, INDEX_FILE, PERSONALITY_FILE].sort());
    assert.match(await f.read('\u5408\u8a00\u8449.md'), new RegExp(PASSPHRASE));
    assert.match(await f.read(HANDOFF_FILE), /\u6700\u521d\u306e\u5f15\u304d\u7d99\u304e/);

    // A later start changes nothing at all.
    await new MemoryRepository({ directory: f.directory, dataDirectory: f.data }).initialize('\u5225\u306e\u5f15\u304d\u7d99\u304e');
    assert.equal(f.commits(), 2);
    assert.equal(f.clean(), true);
    assert.match(await f.read(HANDOFF_FILE), /\u6700\u521d\u306e\u5f15\u304d\u7d99\u304e/);
  } finally { await f.cleanup(); }
});

test('a turn that changed nothing commits nothing; a turn that changed memory makes exactly one commit', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    const quiet = await f.repository.commit({ event: 'mac_message' });
    assert.equal(quiet.committed, false);
    assert.deepEqual(quiet.reverted, []);
    assert.equal(f.commits(), 1);

    await f.write('合言葉.md', `# 合言葉\n\n- 2026-09-19: ${PASSPHRASE}\n`);
    await f.write('予定.md', '# 予定\n\n- 2026-09-19: 歯医者は金曜\n');
    const written = await f.repository.commit({ event: 'mac_message' });
    assert.equal(written.committed, true);
    assert.deepEqual(written.reverted, []);
    assert.equal(f.commits(), 2);
    assert.equal(f.clean(), true);
    assert.match(f.subject(), /mac_message/);
    assert.match(f.subject(), /合言葉\.md/);
    assert.match(f.subject(), /予定\.md/);
  } finally { await f.cleanup(); }
});

test('natsumi may delete and rename her own files, at night or in the day, without a check', async () => {
  const f = await setup();
  try {
    await f.write('合言葉.md', `# 合言葉\n\n- 2026-09-19: ${PASSPHRASE}\n`);
    await f.write('古い話.md', '# 古い話\n\n- 2025-01-01: もう要らない\n');
    await f.repository.initialize(undefined);

    await rm(join(f.directory, '古い話.md'));
    await f.write('あいことば.md', `# 合言葉\n\n- 2026-09-19: ${PASSPHRASE}\n`);
    await rm(join(f.directory, '合言葉.md'));
    const outcome = await f.repository.commit({ event: 'nightly_review', night: true });

    assert.equal(outcome.committed, true);
    assert.deepEqual(outcome.reverted, []);
    assert.equal(f.clean(), true);
    assert.deepEqual((await readdir(f.directory)).filter(name => name !== '.git').sort(),
      [ALWAYS_FILE, HANDOFF_FILE, INDEX_FILE, PERSONALITY_FILE, 'あいことば.md'].sort());

    // A day turn is no different: what natsumi named, she may unname.
    await rm(join(f.directory, 'あいことば.md'));
    const day = await f.repository.commit({ event: 'mac_message' });
    assert.equal(day.committed, true);
    assert.deepEqual(day.reverted, []);
    assert.deepEqual((await readdir(f.directory)).filter(name => name !== '.git').sort(),
      [ALWAYS_FILE, HANDOFF_FILE, INDEX_FILE, PERSONALITY_FILE].sort());
  } finally { await f.cleanup(); }
});

test('the three fixed files cannot be deleted or renamed away, by day or by night', async () => {
  const f = await setup();
  try {
    await f.repository.initialize('\u6628\u591c\u306e\u5f15\u304d\u7d99\u304e');
    const before = Object.fromEntries(await Promise.all(
      [ALWAYS_FILE, PERSONALITY_FILE, HANDOFF_FILE].map(async name => [name, await f.read(name)] as const)));

    // A day turn: one removed outright, one renamed away, one moved into a folder.
    await rm(join(f.directory, ALWAYS_FILE));
    await rename(join(f.directory, PERSONALITY_FILE), join(f.directory, '\u5225\u540d.md'));
    await mkdir(join(f.directory, '\u53e4\u3044\u8a71'), { recursive: true });
    await rename(join(f.directory, HANDOFF_FILE), join(f.directory, '\u53e4\u3044\u8a71', HANDOFF_FILE));

    const day = await f.repository.commit({ event: 'mac_message' });

    assert.deepEqual(day.reverted.map(file => file.path).sort(), [ALWAYS_FILE, HANDOFF_FILE, PERSONALITY_FILE].sort());
    for (const file of day.reverted) assert.match(file.reason, /\u56fa\u5b9a/);
    for (const [name, text] of Object.entries(before)) assert.equal(await f.read(name), text);
    assert.equal(f.clean(), true);

    // The night may rewrite them, but not take them away either.
    await rm(join(f.directory, PERSONALITY_FILE));
    await rm(join(f.directory, HANDOFF_FILE));
    const night = await f.repository.commit({ event: 'nightly_review', night: true });

    assert.deepEqual(night.reverted.map(file => file.path).sort(), [HANDOFF_FILE, PERSONALITY_FILE].sort());
    assert.equal(await f.read(PERSONALITY_FILE), before[PERSONALITY_FILE]!);
    assert.equal(await f.read(HANDOFF_FILE), before[HANDOFF_FILE]!);
    assert.equal(f.clean(), true);
  } finally { await f.cleanup(); }
});

test('a changed file that fails a check goes back to the previous commit, and a new one is removed', async () => {
  const f = await setup({ fileMaxChars: 100 });
  try {
    const kept = `# 合言葉\n\n- 2026-09-15: ${PASSPHRASE}\n`;
    await f.write('合言葉.md', kept);
    await f.repository.initialize(undefined);

    // One good change rides along; every bad one goes back.
    await f.write('予定.md', '# 予定\n\n- 2026-09-19: 歯医者は金曜\n');
    await f.write('合言葉.md', '# 合言葉\n\n- 2026-09-19: 这个是简体字\n');
    await f.write('空.md', '   \n\n');
    await f.write('長い.md', `# 長い\n\n${'あ'.repeat(200)}\n`);
    await f.write('制御.md', '# 制御\n\n<tool_call>\n');
    await f.write('文字.md', '# 文字\n\n\u0007 ベル\n');
    await f.write('memo.txt', 'これは Markdown ではありません\n');
    await symlink('/etc/hostname', join(f.directory, 'よそ.md'));

    const outcome = await f.repository.commit({ event: 'mac_message' });

    assert.equal(outcome.committed, true);
    assert.deepEqual(outcome.reverted.map(file => file.path).sort(),
      ['memo.txt', '制御.md', '合言葉.md', '文字.md', '空.md', '長い.md', 'よそ.md'].sort());
    const reasons = Object.fromEntries(outcome.reverted.map(file => [file.path, file.reason]));
    assert.match(reasons['合言葉.md']!, /日本語以外/);
    assert.match(reasons['空.md']!, /空/);
    assert.match(reasons['長い.md']!, /100/);
    assert.match(reasons['制御.md']!, /制御文字列/);
    assert.match(reasons['文字.md']!, /制御文字/);
    assert.match(reasons['memo.txt']!, /\.md/);
    assert.match(reasons['よそ.md']!, /symlink/i);

    // The one that existed is back as it was; the new ones are gone.
    assert.equal(await f.read('合言葉.md'), kept);
    assert.deepEqual((await readdir(f.directory)).filter(name => name !== '.git').sort(),
      [ALWAYS_FILE, HANDOFF_FILE, INDEX_FILE, PERSONALITY_FILE, '予定.md', '合言葉.md'].sort());
    assert.equal(f.clean(), true);
    assert.equal(f.commits(), 2);
    assert.match(await f.read('予定.md'), /歯医者/);
  } finally { await f.cleanup(); }
});

test('a turn whose every change failed the check commits nothing', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    await f.write('だめ.txt', 'Markdown ではない\n');
    const outcome = await f.repository.commit({ event: 'ping' });
    assert.equal(outcome.committed, false);
    assert.equal(outcome.reverted.length, 1);
    assert.equal(f.commits(), 1);
    assert.equal(f.clean(), true);
  } finally { await f.cleanup(); }
});

test('always.md and personality.md go back when a day turn changed them, and are kept at night', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    const always = await f.read(ALWAYS_FILE);

    await f.write(ALWAYS_FILE, '# 常時記憶\n\n昼に書き換えた\n');
    await f.write(PERSONALITY_FILE, '# 性格・話し方\n\n昼に書き換えた\n');
    await f.write('予定.md', '# 予定\n\n- 2026-09-19: 歯医者は金曜\n');
    const day = await f.repository.commit({ event: 'mac_message' });
    assert.deepEqual(day.reverted.map(file => file.path).sort(), [ALWAYS_FILE, PERSONALITY_FILE].sort());
    for (const file of day.reverted) assert.match(file.reason, /夜/);
    assert.equal(await f.read(ALWAYS_FILE), always);
    assert.equal(day.committed, true);

    await f.write(ALWAYS_FILE, '# 常時記憶\n\n夜に書き直した\n');
    await f.write(PERSONALITY_FILE, '# 性格・話し方\n\n夜に書き直した\n');
    const night = await f.repository.commit({ event: 'nightly_review', night: true });
    assert.deepEqual(night.reverted, []);
    assert.equal(night.committed, true);
    assert.match(await f.read(ALWAYS_FILE), /夜に書き直した/);
    assert.match(await f.read(PERSONALITY_FILE), /夜に書き直した/);
  } finally { await f.cleanup(); }
});

/**
 * The always-memory goes into every prompt, so the limit is put on the writing rather than on the reading: a night
 * that writes past it is put back, and the state where it is too long is never made (ADR 0020).
 */
test('always.md has a smaller limit of its own, counted in code points, and a night past it goes back', async () => {
  const f = await setup({ fileMaxChars: 4000, alwaysMaxChars: 100 });
  try {
    await f.repository.initialize(undefined);

    // Exactly at the limit is kept.
    const head = '# 常時記憶\n\n';
    const exact = head + 'あ'.repeat(100 - [...head].length);
    assert.equal([...exact].length, 100);
    await f.write(ALWAYS_FILE, exact);
    assert.deepEqual((await f.repository.commit({ event: 'nightly_review', night: true })).reverted, []);
    assert.equal(await f.read(ALWAYS_FILE), exact);

    // One code point more goes back, and the reason names the always-memory's limit rather than one file's.
    await f.write(ALWAYS_FILE, `${exact}あ`);
    // A memory file of the same size is fine: the small limit is always.md's alone.
    await f.write('長め.md', `# 長め\n\n${'あ'.repeat(500)}\n`);
    const over = await f.repository.commit({ event: 'nightly_review', night: true });
    assert.deepEqual(over.reverted.map(file => file.path), [ALWAYS_FILE]);
    assert.match(over.reverted[0]!.reason, /常時記憶/);
    assert.match(over.reverted[0]!.reason, /100/);
    assert.equal(await f.read(ALWAYS_FILE), exact);
    assert.equal(over.committed, true);
    assert.match(await f.read('長め.md'), /あ/);
    assert.equal(f.clean(), true);
  } finally { await f.cleanup(); }
});

/** The night's own commit message: what natsumi wrote about the night, or the machine-made one when she wrote none. */
test('a commit message given to the commit is used as it stands, and without one the server makes it', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);

    await f.write('予定.md', '# 予定\n\n- 2026-09-19: 歯医者は金曜\n');
    await f.repository.commit({ event: 'nightly_review', night: true, message: '予定をまとめ直した\n\n歯医者の件を 1 行にした。' });
    assert.equal(f.subject(), '予定をまとめ直した');
    assert.match(f.git('log', '-1', '--format=%B'), /歯医者の件を 1 行にした。/);

    await f.write('予定.md', '# 予定\n\n- 2026-09-20: 歯医者は金曜の午後\n');
    await f.repository.commit({ event: 'nightly_review', night: true });
    assert.equal(f.subject(), 'nightly_review: 予定.md');
  } finally { await f.cleanup(); }
});

test('nothing is ever pushed, even with a remote', async () => {
  const f = await setup();
  try {
    const bare = join(f.root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    await f.write('合言葉.md', `# 合言葉\n\n- 2026-09-19: ${PASSPHRASE}\n`);
    await f.repository.initialize('引き継ぎ');
    f.git('remote', 'add', 'origin', bare);

    await f.write('予定.md', '# 予定\n\n- 2026-09-19: 歯医者は金曜\n');
    await f.repository.commit({ event: 'mac_message' });
    await f.write('予定.md', '# 予定\n\n- 2026-09-19: 歯医者は土曜\n');
    await f.repository.commit({ event: 'nightly_review', night: true });

    assert.equal(execFileSync('git', ['-C', bare, 'for-each-ref'], { encoding: 'utf8' }).trim(), '');
    assert.equal(f.commits(), 3);
  } finally { await f.cleanup(); }
});

test('hooks left in the repository never run', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    const hook = join(f.directory, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, `#!/bin/sh\ntouch "${join(f.root, 'hook-ran')}"\nexit 1\n`, { mode: 0o755 });

    await f.write('予定.md', '# 予定\n\n- 2026-09-19: 歯医者は金曜\n');
    const outcome = await f.repository.commit({ event: 'mac_message' });

    assert.equal(outcome.committed, true);
    assert.equal(f.commits(), 2);
    await assert.rejects(stat(join(f.root, 'hook-ran')));
  } finally { await f.cleanup(); }
});

test('the note handed to the next turn names every reverted file with its reason', async () => {
  const notice = revertNotice([{ path: '合言葉.md', reason: '日本語以外の文字（这）が含まれています' }]);
  assert.match(notice, /合言葉\.md/);
  assert.match(notice, /日本語以外の文字/);
  assert.match(notice, /戻しました/);
  assert.equal(revertNotice([]), '');
});

// `/work` and `/home/natsumi` are never inspected, so a memory written by mistake leaves no trace. This line is the
// only hint natsumi gets that memory itself moved, and it rides on every shell command (ADR 0019).
test('the line about what changed in memory names the files and how they changed', async () => {
  const f = await setup();
  try {
    await f.write('合言葉.md', `# 合言葉\n\n- 2026-09-15: ${PASSPHRASE}\n`);
    await f.repository.initialize();
    assert.equal(await f.repository.changeSummary(), '', 'a clean repository has nothing to say');

    await f.write('合言葉.md', `# 合言葉\n\n- 2026-09-16: ${PASSPHRASE}\n`);
    await f.write('予定.md', '# 予定\n\n- 2026-09-16: 歯医者は金曜\n');
    await rm(join(f.directory, ALWAYS_FILE));
    const summary = await f.repository.changeSummary();
    assert.match(summary, /合言葉\.md（変更）/);
    assert.match(summary, /予定\.md（追加）/);
    assert.match(summary, new RegExp(`${ALWAYS_FILE}（削除）`));
    assert.equal(summary.includes('\n'), false, 'it is one line at the end of a tool result');

    // Committing them leaves nothing to report again.
    await f.repository.commit({ event: 'mac_message', night: true });
    assert.equal(await f.repository.changeSummary(), '');
  } finally { await f.cleanup(); }
});

test('a long list of changes is shortened rather than filling the result', async () => {
  const f = await setup();
  try {
    await f.repository.initialize();
    for (let i = 0; i < 9; i++) await f.write(`話題${i}.md`, `# 話題${i}\n\n- 2026-09-16: ${PASSPHRASE}\n`);
    const summary = await f.repository.changeSummary();
    assert.match(summary, /ほか 4 件/);
    assert.ok([...summary].length < 200, summary);
  } finally { await f.cleanup(); }
});

/**
 * The handoff is a file now (ADR 0020), and what SQLite held has to reach it. A repository made before the upgrade
 * already has handoff.md, but only the template the first start wrote, so the seed would otherwise never land.
 */
test('the seed replaces the untouched handoff template and leaves a written one alone', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    const template = await f.read(HANDOFF_FILE);
    assert.equal(f.commits(), 1);

    // A second start, this time with the handoff SQLite carried over: the template makes way for it.
    await new MemoryRepository({ directory: f.directory, dataDirectory: f.data }).initialize('あしたの自分へ');
    assert.notEqual(await f.read(HANDOFF_FILE), template);
    assert.match(await f.read(HANDOFF_FILE), /あしたの自分へ/);
    assert.equal(f.commits(), 2);
    assert.equal(f.clean(), true);

    // What is written is never overwritten, however often a start carries something else.
    await new MemoryRepository({ directory: f.directory, dataDirectory: f.data }).initialize('別の引き継ぎ');
    assert.match(await f.read(HANDOFF_FILE), /あしたの自分へ/);
    assert.equal(f.commits(), 2);
  } finally { await f.cleanup(); }
});

test('the handoff is written into the working tree and the turn commits it, and head names that commit', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    const before = await f.repository.head();

    await f.repository.writeHandoff('明日は資料の続き');
    assert.match(await f.read(HANDOFF_FILE), /明日は資料の続き/);
    assert.equal(f.clean(), false);

    const outcome = await f.repository.commit({ event: 'nightly_review', night: true });
    assert.equal(outcome.committed, true);
    assert.deepEqual(outcome.files, [HANDOFF_FILE]);
    const head = await f.repository.head();
    assert.notEqual(head, before);
    assert.equal(head, f.git('rev-parse', 'HEAD'));
    assert.match(f.git('show', `${head}:${HANDOFF_FILE}`), /明日は資料の続き/);
  } finally { await f.cleanup(); }
});

test('the handoff may be written on an ordinary day, unlike the two files that ride in every prompt', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    await f.repository.writeHandoff('昼間に書き直した');
    await f.write(ALWAYS_FILE, '# 常時記憶\n\n昼間の書き換え\n');

    const outcome = await f.repository.commit({ event: 'mac_message' });

    assert.deepEqual(outcome.files, [HANDOFF_FILE]);
    assert.deepEqual(outcome.reverted.map(file => file.path), [ALWAYS_FILE]);
    assert.match(await f.read(HANDOFF_FILE), /昼間に書き直した/);
  } finally { await f.cleanup(); }
});

test('under the server umask, memory is shared with the group the workspace writes through (ADR 0033)', async () => {
  const f = await setup();
  const previous = process.umask(SERVER_UMASK);
  try {
    // A repository placed with loop.memoryRepository, made by the repository itself.
    const directory = join(f.root, 'elsewhere', 'memory');
    const repository = new MemoryRepository({ directory, dataDirectory: f.data });
    await repository.initialize(undefined);
    assert.equal((await stat(directory)).mode & 0o7777, 0o2770);
    for (const name of [ALWAYS_FILE, HANDOFF_FILE, PERSONALITY_FILE]) {
      assert.equal((await stat(join(directory, name))).mode & 0o777, 0o660, name);
    }
    // What git puts back is written the same way.
    await rm(join(directory, ALWAYS_FILE));
    await repository.commit({ event: 'mac_message' });
    assert.equal((await stat(join(directory, ALWAYS_FILE))).mode & 0o777, 0o660);
    await repository.writeHandoff('あしたの自分へ');
    assert.equal((await stat(join(directory, HANDOFF_FILE))).mode & 0o777, 0o660);
  } finally {
    process.umask(previous);
    await f.cleanup();
  }
});

test('the server commits memory that git sees as owned by another user (ADR 0033)', async () => {
  const f = await setup();
  const bin = join(f.root, 'bin');
  const path = process.env.PATH;
  try {
    // The workspace runs as another UID, so the working tree is not the server's. git's own test switch makes it
    // treat every repository that way, which is what ownership checks see once the UIDs differ.
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    await mkdir(bin);
    await writeFile(join(bin, 'git'), `#!/bin/sh\nGIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec ${real} "$@"\n`, { mode: 0o755 });
    // Like the server, read no system or global config: a machine that trusts every directory (safe.directory=*,
    // as CI runners do) would otherwise hide the refusal this test needs.
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    execFileSync(real, ['-C', f.directory, 'init', '-q', '-b', 'main'], { env });
    assert.throws(() => execFileSync(join(bin, 'git'), ['-C', f.directory, 'status'], { stdio: 'pipe', env }), /dubious ownership/);

    process.env.PATH = `${bin}:${path}`;
    await f.repository.initialize(undefined);
    await f.write('予定.md', '# 予定\n\n- 2026-09-24: 歯医者は金曜\n');
    const outcome = await f.repository.commit({ event: 'mac_message' });
    process.env.PATH = path;

    assert.equal(outcome.committed, true);
    assert.equal(f.commits(), 2);
    assert.equal(f.clean(), true);
  } finally {
    process.env.PATH = path;
    await f.cleanup();
  }
});

// ── ADR 0055: INDEX.md, and the curator's commit ──

test('INDEX.md is the curator\'s: natsumi\'s change to it goes back by day and by night, and it cannot be taken away', async () => {
  const f = await setup();
  try {
    await f.repository.initialize(undefined);
    const index = await f.read(INDEX_FILE);
    await f.write(INDEX_FILE, '# 索引\n\n- 昼に書いた\n');
    await f.write('予定.md', '# 予定\n\n- 歯医者は金曜\n');
    const day = await f.repository.commit({ event: 'mac_message' });
    assert.deepEqual(day.reverted.map(file => file.path), [INDEX_FILE]);
    assert.match(day.reverted[0]!.reason, /整理係/);
    assert.equal(await f.read(INDEX_FILE), index);
    assert.equal(day.committed, true);

    await f.write(INDEX_FILE, '# 索引\n\n- 夜に書いた\n');
    const night = await f.repository.commit({ event: 'nightly_review', night: true });
    assert.deepEqual(night.reverted.map(file => file.path), [INDEX_FILE]);
    assert.equal(await f.read(INDEX_FILE), index);

    await rm(join(f.directory, INDEX_FILE));
    const removed = await f.repository.commit({ event: 'mac_message' });
    assert.deepEqual(removed.reverted.map(file => file.path), [INDEX_FILE]);
    assert.equal(await f.read(INDEX_FILE), index);
    assert.equal(f.clean(), true);
  } finally { await f.cleanup(); }
});

test('the curator\'s reorganization is one commit under its own note: moves, merges and a new index together', async () => {
  const f = await setup();
  try {
    await f.write('予定.md', '# 予定\n\n- 歯医者は金曜\n');
    await f.write('予定2.md', '# 予定\n\n- 散髪は土曜\n');
    await f.repository.initialize(undefined);
    const before = f.commits();
    await mkdir(join(f.directory, '暮らし'));
    await f.write('暮らし/予定.md', '# 予定\n\n- 歯医者は金曜\n- 散髪は土曜\n');
    await rm(join(f.directory, '予定.md'));
    await rm(join(f.directory, '予定2.md'));
    await f.write(INDEX_FILE, '# 記憶の索引\n\n- 暮らし/予定.md: 近い予定\n');

    const outcome = await f.repository.commitCuration({ message: '予定をまとめた\n\n- 予定2.md: 予定.md と重複していたので統合' });

    assert.equal(outcome.committed, true);
    assert.deepEqual(outcome.rejected, []);
    assert.deepEqual([...outcome.files].sort(), [INDEX_FILE, '予定.md', '予定2.md', '暮らし/予定.md'].sort());
    assert.equal(f.commits(), before + 1);
    assert.equal(f.git('log', '-1', '--format=%B').trim(), '予定をまとめた\n\n- 予定2.md: 予定.md と重複していたので統合');
    assert.equal(f.clean(), true);

    // Nothing to do makes no commit, and a missing note gets the server's own line.
    assert.equal((await f.repository.commitCuration({})).committed, false);
    await f.write('暮らし/予定.md', '# 予定\n\n- 歯医者は金曜\n');
    await f.repository.commitCuration({});
    assert.match(f.subject(), /^memory_curator: 暮らし\/予定\.md$/);
  } finally { await f.cleanup(); }
});

test('one change the curator may not make throws the whole night away, new files and folders included', async () => {
  const cases: [string, (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, RegExp][] = [
    ['a fixed file changed', f => f.write(ALWAYS_FILE, '# 常時記憶\n\n係が書いた\n'), /always\.md/],
    ['the handoff removed', f => rm(join(f.directory, HANDOFF_FILE)), /handoff\.md/],
    ['personality renamed', f => rename(join(f.directory, PERSONALITY_FILE), join(f.directory, '性格.md')), /personality\.md/],
    ['a diary changed', f => f.write('diary/2026-09-26.md', '# 2026-09-26\n\n書き換えた\n'), /diary\/2026-09-26\.md/],
    ['a diary moved', f => rename(join(f.directory, 'diary'), join(f.directory, '日記')), /diary\//],
    ['the index removed', f => rm(join(f.directory, INDEX_FILE)), /INDEX\.md/],
    ['a file too long', f => f.write('長い.md', `# 長い\n\n${'あ'.repeat(1200)}\n`), /長い\.md/],
    ['not Markdown', f => f.write('メモ.txt', 'メモ\n'), /メモ\.txt/],
  ];
  for (const [label, act, named] of cases) {
    const f = await setup({ fileMaxChars: 1000 });
    try {
      await mkdir(join(f.directory, 'diary'));
      await f.write('diary/2026-09-26.md', '# 2026-09-26\n\n日記\n');
      await f.write('予定.md', '# 予定\n\n- 歯医者は金曜\n');
      await f.repository.initialize(undefined);
      const head = f.git('rev-parse', 'HEAD');
      // Good work alongside the bad: it is thrown away too.
      await mkdir(join(f.directory, '暮らし'));
      await rename(join(f.directory, '予定.md'), join(f.directory, '暮らし', '予定.md'));
      await f.write(INDEX_FILE, '# 記憶の索引\n\n- 暮らし/予定.md\n');
      await act(f);

      const outcome = await f.repository.commitCuration({ message: '整理した' });

      assert.equal(outcome.committed, false, label);
      assert.ok(outcome.rejected.some(file => named.test(file.path)), `${label}: ${JSON.stringify(outcome.rejected)}`);
      assert.equal(f.git('rev-parse', 'HEAD'), head, label);
      assert.equal(f.clean(), true, label);
      assert.match(await f.read('予定.md'), /歯医者/, label);
      await assert.rejects(stat(join(f.directory, '暮らし')), label);
    } finally { await f.cleanup(); }
  }
});

test('the uncommitted changes can be thrown away, and a clean tree says so', async () => {
  const f = await setup();
  try {
    await f.write('予定.md', '# 予定\n\n- 歯医者は金曜\n');
    await f.repository.initialize(undefined);
    assert.equal(await f.repository.isClean(), true);
    await f.write('予定.md', '# 予定\n\n書きかけ\n');
    await mkdir(join(f.directory, '新しい/奥'), { recursive: true });
    await f.write('新しい/奥/メモ.md', '# メモ\n');
    await rm(join(f.directory, ALWAYS_FILE));
    assert.equal(await f.repository.isClean(), false);

    await f.repository.discardChanges();

    assert.equal(await f.repository.isClean(), true);
    assert.match(await f.read('予定.md'), /歯医者/);
    await assert.rejects(stat(join(f.directory, '新しい')));
    assert.match(await f.read(ALWAYS_FILE), /\S/);
  } finally { await f.cleanup(); }
});

test('the files memory holds are listed with their size and sections, and the files changed since a commit are named', async () => {
  const f = await setup();
  try {
    await mkdir(join(f.directory, '暮らし'));
    await f.write('暮らし/予定.md', '# 予定\n\n## 歯医者\n- 金曜\n### 細かい\n## 散髪\n- 土曜\n');
    await f.write('本人.md', '本文だけ\n');
    await f.repository.initialize(undefined);
    const files = await f.repository.listFiles();
    const plans = files.find(file => file.path === '暮らし/予定.md');
    assert.deepEqual(plans, { path: '暮らし/予定.md', chars: [...'# 予定\n\n## 歯医者\n- 金曜\n### 細かい\n## 散髪\n- 土曜\n'].length,
      sections: [{ heading: '# 予定', lines: 0 }, { heading: '## 歯医者', lines: 1 }, { heading: '### 細かい', lines: 0 },
        { heading: '## 散髪', lines: 1 }] });
    // Lines before any heading are a section too, with no heading: a file with none is one flat section.
    assert.deepEqual(files.find(file => file.path === '本人.md')?.sections, [{ heading: '', lines: 1 }]);
    assert.ok(files.some(file => file.path === INDEX_FILE));
    assert.deepEqual(files.map(file => file.path), [...files.map(file => file.path)].sort());

    const base = await f.repository.head();
    assert.deepEqual(await f.repository.changedSince(base), []);
    await f.write('本人.md', '本文だけ。書き足した\n');
    await f.write('新しい.md', '# 新しい\n');
    await f.repository.commit({ event: 'mac_message' });
    await rm(join(f.directory, '暮らし/予定.md'));
    await f.repository.commit({ event: 'mac_message' });
    // Only what is still there: a removed file has nothing left to rewrite.
    assert.deepEqual(await f.repository.changedSince(base), ['新しい.md', '本人.md']);
    // A base the history does not know is taken as the last day, which here is the whole of it.
    assert.deepEqual((await f.repository.changedSince('0'.repeat(40))).sort(),
      [ALWAYS_FILE, HANDOFF_FILE, INDEX_FILE, PERSONALITY_FILE, '新しい.md', '本人.md'].sort());
  } finally { await f.cleanup(); }
});

test('each file is dated by the last commit that changed it', async () => {
  const f = await setup();
  try {
    await f.write('予定.md', '# 予定\n\n- 歯医者は金曜\n');
    await f.repository.initialize(undefined);
    await f.write('本人.md', '# 本人\n');
    await f.repository.commit({ event: 'mac_message' });
    const dates = await f.repository.lastChanged(['予定.md', '本人.md', '無い.md']);
    assert.equal(dates.get('予定.md'), f.git('log', '-1', '--format=%cI', 'HEAD~1'));
    assert.equal(dates.get('本人.md'), f.git('log', '-1', '--format=%cI', 'HEAD'));
    assert.equal(dates.has('無い.md'), false, 'a file the history does not hold has no date');
  } finally { await f.cleanup(); }
});
