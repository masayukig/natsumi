import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAvatar, runAvatarCheck } from '../src/server/avatar.ts';
import { parseCli, UsageError } from '../src/server/cli.ts';

/**
 * `natsumi avatar check <directory>` (ADR 0057): the start's own checks, run by hand, with what stops the start, what
 * the faceless pictures fill in, and what the server's default stands in for, each under its own heading.
 */

const NATSUMI = join(import.meta.dirname, '..', 'assets', 'avatars', 'natsumi');

async function check(directory: string): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runAvatarCheck(directory, line => { lines.push(line); });
  return { code, lines };
}

test('the command line takes one directory or built-in ID to check, and nothing else', () => {
  assert.deepEqual(parseCli(['avatar', 'check', '/srv/avatars/hana']), { command: 'avatar', action: 'check', target: '/srv/avatars/hana' });
  assert.deepEqual(parseCli(['avatar', 'check', 'nanashi']), { command: 'avatar', action: 'check', target: 'nanashi' });
  for (const argv of [['avatar'], ['avatar', 'check'], ['avatar', 'check', 'a', 'b'], ['avatar', 'use', 'a'], ['avatar', 'check', 'a', '--data-dir', 'd']]) {
    assert.throws(() => parseCli(argv), UsageError, argv.join(' '));
  }
});

test('natsumi passes, by her directory or by her ID as a built-in avatar, with her version and the server\'s default params', async () => {
  assert.deepEqual(await check('natsumi'), await check(NATSUMI));
  const { code, lines } = await check(NATSUMI);
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    'avatar: natsumi (なつみ)',
    `version: ${(await loadAvatar(undefined)).version}`,
    'errors (the server does not start): none',
    'filled in with the faceless pictures: none',
    'the server\'s defaults:',
    '- sdctl-params.yaml',
    '- personality.md',
  ]);
});

test('what is broken fails the check, and what is only missing is listed apart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-avatar-cli-')));
  try {
    const dir = join(root, 'hana');
    await mkdir(dir);
    await writeFile(join(dir, 'avatar.json'), JSON.stringify({ id: 'hana', name: 'はな' }));
    const good = await check(dir);
    assert.equal(good.code, 0);
    assert.equal(good.lines[0], 'avatar: hana (はな)');
    assert.ok(good.lines.includes('filled in with the faceless pictures:'));
    assert.ok(good.lines.includes('- spritesheet'));
    assert.ok(good.lines.includes('- slack/happy'));
    assert.ok(good.lines.includes('- appearance.yaml'));
    // Without one the memory starts from the fixed template: listed with the defaults, and not an error.
    assert.ok(good.lines.includes('- personality.md'));
    await writeFile(join(dir, 'personality.md'), '# 性格・話し方\n\nのんびり\n');
    const own = await check(dir);
    assert.equal(own.code, 0);
    assert.ok(!own.lines.includes('- personality.md'), own.lines.join('\n'));

    await writeFile(join(dir, 'avatar.json'), JSON.stringify({ name: 'はな' }));
    const bad = await check(dir);
    assert.equal(bad.code, 1);
    assert.equal(bad.lines[0], 'errors (the server does not start):');
    assert.match(bad.lines[1]!, /^- avatar\.json: id /);

    const missing = await check(join(root, 'nowhere'));
    assert.equal(missing.code, 1);
    assert.deepEqual(missing.lines, ['errors (the server does not start):', '- does not exist']);

    // A name without a slash is a built-in avatar's ID; a directory beside it is named with ./.
    const unknown = await check('hana');
    assert.equal(unknown.code, 1);
    assert.deepEqual(unknown.lines, ['errors (the server does not start):', '- hana is not a built-in avatar (iori, myao, nanashi, natsumi)']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
