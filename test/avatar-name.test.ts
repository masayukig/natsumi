import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAvatar } from '../src/server/avatar.ts';
import { ConfigError, parseConfig } from '../src/server/config.ts';
import { gitIdentity, runGit } from '../src/server/git.ts';
import { curationBrief } from '../src/server/memory-curator.ts';
import { MemoryRepository } from '../src/server/memory-repository.ts';
import { compactionInstructions, composeSystemPrompt, curatorSystemPrompt, DEFAULT_SELF } from '../src/server/prompts.ts';
import { pushAlert } from '../src/server/push.ts';

/**
 * Where the avatar's name goes (ADR 0057): the display name and the ID side by side in her instructions, the display
 * name on the lock screen, to the curator and in the memory commits, whose e-mail is made from the ID.
 */

const HANA = { id: 'hana', name: 'はな' };
const parts = { workspace: true, personality: '', always: '', handoff: '' };

const base = () => ({
  pi: { agentDirectory: '/srv/pi/agent', sessionDirectory: '/srv/pi/sessions', authPath: '/srv/pi/agent/auth.json',
    model: { provider: 'openai-codex', id: 'gpt-5.5' }, voiceEnabled: false },
  publicOrigin: 'https://natsumi.example.test', listen: { host: '127.0.0.1', port: 0, tls: false },
  github: { clientId: 'Iv1.fixtureclient', clientSecretEnv: 'NATSUMI_GITHUB_CLIENT_SECRET',
    callbackUrl: 'https://natsumi.example.test/auth/github/callback', allowedUserId: 1 },
});

test('the config chooses a built-in avatar by its ID or adds one by its absolute path, never both', () => {
  assert.equal(parseConfig(base()).avatar, undefined);
  assert.deepEqual(parseConfig({ ...base(), avatar: { id: 'natsumi' } }).avatar, { id: 'natsumi' });
  assert.deepEqual(parseConfig({ ...base(), avatar: { directory: '/var/lib/natsumi-avatars/hana' } }).avatar,
    { directory: '/var/lib/natsumi-avatars/hana' });
  assert.deepEqual(parseConfig({ ...base(), avatar: { id: 'iori', appearance: '/etc/natsumi/appearance.yaml' } }).avatar,
    { id: 'iori', appearance: '/etc/natsumi/appearance.yaml' });
  assert.deepEqual(parseConfig({ ...base(), avatar: { id: 'natsumi', sdctlParams: '/etc/natsumi/sdctl-params.yaml' } }).avatar,
    { id: 'natsumi', sdctlParams: '/etc/natsumi/sdctl-params.yaml' });
  assert.deepEqual(parseConfig({ ...base(), avatar: { directory: '/var/lib/natsumi-avatars/hana', appearance: '/etc/natsumi/appearance.yaml',
    sdctlParams: '/etc/natsumi/sdctl-params.yaml' } }).avatar,
    { directory: '/var/lib/natsumi-avatars/hana', appearance: '/etc/natsumi/appearance.yaml', sdctlParams: '/etc/natsumi/sdctl-params.yaml' });
  for (const [avatar, path] of [
    [{ directory: 'avatars/hana' }, 'avatar.directory'],
    [{}, 'avatar'],
    [{ id: 'natsumi', directory: '/a' }, 'avatar'],
    [{ id: 'Natsumi' }, 'avatar.id'],
    [{ id: '../natsumi' }, 'avatar.id'],
    [{ directory: '/a', name: 'はな' }, 'avatar.name'],
    [{ id: 'iori', appearance: 'appearance.yaml' }, 'avatar.appearance'],
    [{ appearance: '/a.yaml' }, 'avatar'],
    [{ id: 'iori', sdctlParams: 'sdctl-params.yaml' }, 'avatar.sdctlParams'],
    [{ sdctlParams: '/a.yaml' }, 'avatar'],
    ['/a', 'avatar'],
  ] as const) {
    assert.throws(() => parseConfig({ ...base(), avatar }), (error: unknown) => error instanceof ConfigError && error.path === path,
      JSON.stringify(avatar));
  }
});

test('the default self is natsumi, the same as the avatar in the image', async () => {
  const avatar = await loadAvatar(undefined);
  assert.deepEqual(DEFAULT_SELF, { id: avatar.id, name: avatar.name });
});

test('her instructions open with the display name and the ID side by side', () => {
  assert.ok(composeSystemPrompt(parts).startsWith('あなたはなつみ (natsumi)。あなたのオーナー（持ち主）であるマスター専属の秘書で、'));
  const hana = composeSystemPrompt({ ...parts, self: HANA });
  assert.ok(hana.startsWith('あなたははな (hana)。あなたのオーナー（持ち主）であるマスター専属の秘書で、'));
  assert.ok(!hana.includes('natsumi。'));
  assert.ok(compactionInstructions(HANA).startsWith('これははな (hana)（マスター専属の秘書）の思考の記録です。'));
  assert.ok(compactionInstructions(DEFAULT_SELF).startsWith('これはなつみ (natsumi)（マスター専属の秘書）の思考の記録です。'));
});

test('the curator is told whose memory it keeps by the display name', () => {
  const prompt = curatorSystemPrompt('はな');
  assert.ok(prompt.startsWith('あなたは記憶の整理係です。ある個人秘書（はな）の長期記憶を、夜の間に組み直します。\nあなたははなではありません。'));
  assert.ok(!prompt.includes('なつみ'));
  assert.ok(curatorSystemPrompt('なつみ').includes('あなたはなつみではありません。'));
  const brief = curationBrief({ name: 'はな', date: '2026-09-28', fileMaxChars: 100,
    files: [{ path: 'always.md', chars: 3, headings: [] }], changed: [], rotated: [] });
  assert.match(brief, /always\.md（3 文字・はなのもの、変えない）/);
});

test('the lock screen shows the display name', () => {
  assert.deepEqual(pushAlert('reply', 'はな'), { title: 'はな', body: '返事があります' });
  assert.deepEqual(pushAlert('notice', 'なつみ'), { title: 'なつみ', body: '知らせがあります' });
  assert.deepEqual(pushAlert('approval', 'はな'), { title: 'はな', body: '承認待ちがあります' });
  assert.equal(pushAlert('other', 'はな'), undefined);
});

test('memory commits carry the display name and an address made from the ID', async () => {
  assert.deepEqual(gitIdentity(HANA), { name: 'はな', email: 'hana@natsumi.invalid' });
  assert.deepEqual(gitIdentity(DEFAULT_SELF), { name: 'なつみ', email: 'natsumi@natsumi.invalid' });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-avatar-git-')));
  try {
    const repository = new MemoryRepository({ directory: join(root, 'memory'), dataDirectory: root, identity: gitIdentity(HANA) });
    await repository.initialize();
    const { stdout } = await runGit(join(root, 'memory'), ['log', '-1', '--format=%an <%ae>|%cn <%ce>']);
    assert.equal(stdout.trim(), 'はな <hana@natsumi.invalid>|はな <hana@natsumi.invalid>');
  } finally { await rm(root, { recursive: true, force: true }); }
});
