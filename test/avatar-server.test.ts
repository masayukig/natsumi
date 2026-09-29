import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { loadAvatar } from '../src/server/avatar.ts';
import { login, startFixture, type Fixture } from './support/server-fixture.ts';

/**
 * The avatar through the running server (ADR 0057, docs/client-contract.md): the bundle the apps fetch without a
 * login, its version in the snapshot, the Slack icons, the page and the params written for the workspace, and the
 * name in her instructions.
 */

const NATSUMI = join(import.meta.dirname, '..', 'assets', 'avatars', 'natsumi');
const FALLBACK = join(import.meta.dirname, '..', 'assets', 'avatars', 'nanashi');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'avatar');
const HANA_PERSONALITY = '# 性格・話し方\n\nのんびりしていて、語尾をのばす。\n';

async function withServer(fn: (f: Fixture) => Promise<void>, avatar?: (root: string) => Promise<Record<string, unknown>>) {
  const f = await startFixture(avatar ? { avatar } : {});
  try { await fn(f); } finally { await f.cleanup(); }
}

/** Sends the owner's message over a socket of its own, and waits until it is accepted. */
async function say(f: Fixture, text: string): Promise<void> {
  const { token } = await login(f);
  const ws = new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${token}` } });
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    let deviceId: string | undefined;
    const accepted = new Promise<void>(resolve => ws.on('message', data => {
      const envelope = JSON.parse(String(data));
      if (envelope.type === 'session.snapshot') {
        deviceId = envelope.payload.deviceId;
        ws.send(JSON.stringify({ v: 1, requestId: 'send', deviceId, type: 'conversation.send', payload: { text } }));
      }
      if (envelope.type === 'command.accepted' && envelope.requestId === 'send') resolve();
    }));
    ws.send(JSON.stringify({ v: 1, requestId: 'sync', type: 'session.sync', payload: { resume: null } }));
    await accepted;
  } finally { ws.close(); }
}

async function snapshot(f: Fixture): Promise<Record<string, unknown>> {
  const { token } = await login(f);
  const ws = new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${token}` } });
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const answer = new Promise<Record<string, any>>(resolve => ws.on('message', data => {
      const envelope = JSON.parse(String(data));
      if (envelope.type === 'session.snapshot' || envelope.type === 'service.unavailable') resolve(envelope);
    }));
    ws.send(JSON.stringify({ v: 1, requestId: 'sync', type: 'session.sync', payload: { resume: null } }));
    const envelope = await answer;
    assert.equal(envelope.type, 'session.snapshot');
    return envelope.payload;
  } finally { ws.close(); }
}

test('the apps fetch the default avatar without a login: the list, then each file under its version', () => withServer(async f => {
  const avatar = await loadAvatar(undefined);
  const listed = await fetch(`${f.base}/v1/avatar`);
  assert.equal(listed.status, 200);
  assert.match(listed.headers.get('content-type') ?? '', /application\/json/);
  const manifest = await listed.json() as { version: string; id: string; name: string; files: { path: string; bytes: number; sha256: string }[] };
  assert.equal(manifest.version, avatar.version);
  assert.equal(manifest.id, 'natsumi');
  assert.equal(manifest.name, 'なつみ');
  for (const file of manifest.files) {
    const res = await fetch(`${f.base}/v1/avatar/${manifest.version}/${file.path}`);
    assert.equal(res.status, 200, file.path);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.length, file.bytes, file.path);
    assert.equal(createHash('sha256').update(body).digest('hex'), file.sha256, file.path);
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
  }
  const sheet = await fetch(`${f.base}/v1/avatar/${manifest.version}/spritesheet.webp`);
  assert.equal(sheet.headers.get('content-type'), 'image/webp');
  assert.deepEqual(Buffer.from(await sheet.arrayBuffer()), await readFile(join(NATSUMI, 'spritesheet.webp')));
  for (const path of [`/v1/avatar/0123456789abcdef0123456789abcdef/pet.json`, `/v1/avatar/${manifest.version}/appearance.yaml`,
    `/v1/avatar/${manifest.version}/README.md`, `/v1/avatar/${manifest.version}/../package.json`,
    `/v1/avatar/${manifest.version}/%2e%2e/package.json`, `/v1/avatar/${manifest.version}/`, `/v1/avatar/${manifest.version}`]) {
    assert.equal((await fetch(`${f.base}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`${f.base}/v1/avatar`, { method: 'POST' })).status, 404);
}));

test('the snapshot carries the version of the avatar', () => withServer(async f => {
  const payload = await snapshot(f);
  assert.equal(payload.avatarVersion, (await loadAvatar(undefined)).version);
}));

test('the page on drawing and the params are written to the data directory for the workspace', () => withServer(async f => {
  assert.equal(await readFile(join(f.data, 'avatar', 'images.md'), 'utf8'), await readFile(join(FIXTURES, 'natsumi-images.md'), 'utf8'));
  assert.equal(await readFile(join(f.data, 'avatar', 'sdctl-params.yaml'), 'utf8'),
    await readFile(join(FALLBACK, 'sdctl-params.yaml'), 'utf8'));
}));

test('an avatar the config names gives its name, its faceless fill-ins and its version everywhere', () => withServer(async f => {
  const manifest = await (await fetch(`${f.base}/v1/avatar`)).json() as { id: string; name: string; version: string };
  assert.equal(manifest.id, 'hana');
  assert.equal(manifest.name, 'はな');
  const icon = await fetch(`${f.base}/avatar/happy.png`);
  assert.equal(icon.status, 200);
  assert.deepEqual(Buffer.from(await icon.arrayBuffer()), await readFile(join(FALLBACK, 'slack', 'happy.png')));
  assert.ok(f.logs.includes('avatar: hana (はな), version ' + manifest.version), f.logs.join('\n'));
  assert.ok(f.logs.includes('avatar: filled with the faceless spritesheet'), f.logs.join('\n'));
  assert.ok(f.logs.includes('avatar: filled with the faceless slack/happy'), f.logs.join('\n'));
  assert.equal((await snapshot(f)).avatarVersion, manifest.version);
  const page = await readFile(join(f.data, 'avatar', 'images.md'), 'utf8');
  assert.ok(!page.includes('kutara'), page);
  // Her instructions, as the session was made with them.
  f.model.auto = () => '';
  await say(f, 'こんにちは');
  const deadline = Date.now() + 5_000;
  while (f.model.contexts.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(f.model.contexts[0]?.systemPrompt?.startsWith('あなたははな (hana)。'), f.model.contexts[0]?.systemPrompt?.slice(0, 40));
  // Her personality starts from the avatar's (ADR 0060), and the session is made with it.
  assert.equal(await readFile(join(f.data, 'memory', 'personality.md'), 'utf8'), HANA_PERSONALITY);
  assert.ok(f.model.contexts[0]?.systemPrompt?.includes('語尾をのばす'), f.model.contexts[0]?.systemPrompt);
}, async root => {
  const dir = join(root, 'avatars', 'hana');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'avatar.json'), JSON.stringify({ id: 'hana', name: 'はな' }));
  await writeFile(join(dir, 'personality.md'), HANA_PERSONALITY);
  return { directory: dir };
}));

test('an avatar directory that is broken stops the start with the setting\'s name', async () => {
  await assert.rejects(startFixture({ avatar: async root => ({ directory: join(root, 'nowhere') }) }),
    /avatar\.directory: .*does not exist/);
});

test('the config may choose natsumi by her ID', () => withServer(async f => {
  const manifest = await (await fetch(`${f.base}/v1/avatar`)).json() as { id: string; version: string };
  assert.equal(manifest.id, 'natsumi');
  assert.equal(manifest.version, (await loadAvatar(undefined)).version);
}, async () => ({ id: 'natsumi' })));

test('an ID that is no built-in avatar stops the start with the setting\'s name', async () => {
  await assert.rejects(startFixture({ avatar: async () => ({ id: 'hana' }) }), /avatar\.id: .*not a built-in avatar/);
});
