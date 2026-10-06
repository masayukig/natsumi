import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import WebSocket from 'ws';
import { DECODABLE_PNG } from './support/fake-slack.ts';
import { approveAtGitHub, login, PUBLIC_ORIGIN, startFixture, type Fixture, type FixtureOptions } from './support/server-fixture.ts';

/**
 * Files attached to a message in the chat (ADR 0071): taken by `POST /v1/uploads` with the app's bearer or the browser's
 * cookie and our Origin, named by their IDs in `conversation.send`, shown to her by their places under /sources/uploads
 * with the images beside the line, and fetched back by the devices with `GET /v1/uploads/<id>`.
 */

const COOKIE = 'natsumi_session';

async function withFixture(fn: (f: Fixture) => Promise<void>, options: FixtureOptions = {}) {
  const f = await startFixture(options);
  try { await fn(f); } finally { await f.cleanup(); }
}

/** The whole browser login from `/`; returns the session cookie's value. */
async function browserLogin(f: Fixture): Promise<string> {
  const start = await f.fetch('/');
  const authorize = new URL(start.headers.get('location')!);
  const res = await f.fetch(await approveAtGitHub(f, authorize));
  const line = res.headers.getSetCookie().find(cookie => cookie.startsWith(`${COOKIE}=`));
  assert.ok(line, 'the callback sets the session cookie');
  return line.slice(COOKIE.length + 1).split(';')[0]!;
}

function upload(f: Fixture, data: Buffer, name: string, headers: Record<string, string>) {
  return f.fetch(`/v1/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...headers },
    body: new Uint8Array(data) });
}

interface Envelope { type: string; requestId?: string; payload: Record<string, any> }

async function device(f: Fixture, headers: Record<string, string>) {
  const ws = new WebSocket(f.wsUrl, { headers });
  const messages: Envelope[] = [];
  ws.on('message', data => { messages.push(JSON.parse(String(data)) as Envelope); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let counter = 0;
  let deviceId: string | undefined;
  const until = async (predicate: (message: Envelope) => boolean, from = 0) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = messages.slice(from).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out; received ${messages.map(m => m.type).join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const request = async (type: string, payload: Record<string, unknown> = {}, requestId = `request-${++counter}`) => {
    const from = messages.length;
    ws.send(JSON.stringify({ v: 1, requestId, deviceId, type, payload }));
    return until(message => message.requestId === requestId, from);
  };
  const sync = async () => {
    const reply = await request('session.sync', { resume: null });
    deviceId = reply.payload.deviceId;
    return reply;
  };
  return { messages, until, request, sync, close: () => new Promise(resolve => { ws.once('close', resolve); ws.close(); }) };
}

const userText = (context: Context) => {
  const message = context.messages.filter(item => item.role === 'user').at(-1) as { content: string | { type: string; text?: string }[] };
  return typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('');
};
const userImages = (context: Context) => {
  const message = context.messages.filter(item => item.role === 'user').at(-1) as { content: string | { type: string; data?: string }[] };
  return typeof message.content === 'string' ? [] : message.content.filter(part => part.type === 'image').map(part => part.data);
};

test('a file is taken with the app’s bearer, or with the browser’s cookie and our Origin only', () => withFixture(async f => {
  const { token } = await login(f);
  const byApp = await upload(f, Buffer.from('%PDF-1.7'), '報告書.pdf', { authorization: `Bearer ${token}` });
  assert.equal(byApp.status, 201, byApp.text);
  const taken = byApp.json();
  assert.match(String(taken.uploadId), /^upload-/);
  assert.deepEqual({ ...taken, uploadId: '' }, { uploadId: '', name: '報告書.pdf', bytes: 8 });
  const [directory] = await readdir(join(f.data, 'sources', 'uploads'));
  assert.deepEqual(await readFile(join(f.data, 'sources', 'uploads', directory!, '報告書.pdf')), Buffer.from('%PDF-1.7'));

  const cookie = await browserLogin(f);
  assert.equal((await upload(f, Buffer.from('x'), 'x.txt', { cookie: `${COOKIE}=${cookie}`, origin: PUBLIC_ORIGIN })).status, 201);
  assert.equal((await upload(f, Buffer.from('x'), 'x.txt', { cookie: `${COOKIE}=${cookie}` })).status, 403, 'no Origin');
  assert.equal((await upload(f, Buffer.from('x'), 'x.txt', { cookie: `${COOKIE}=${cookie}`, origin: 'https://elsewhere.example.test' })).status, 403);
  assert.equal((await upload(f, Buffer.from('x'), 'x.txt', { cookie: `${COOKIE}=fixture-unknown-token`, origin: PUBLIC_ORIGIN })).status, 401);
  assert.equal((await upload(f, Buffer.from('x'), 'x.txt', {})).status, 401);
  assert.equal((await upload(f, Buffer.from('x'), 'x.txt', { authorization: 'Bearer fixture-unknown-token' })).status, 401);
  assert.equal((await f.fetch('/v1/uploads', { headers: { authorization: `Bearer ${token}` } })).status, 404, 'nothing is listed');
  assert.equal((await readdir(join(f.data, 'sources', 'uploads'))).length, 2);
}));

test('a file past the limit is refused before it is kept', () => withFixture(async f => {
  const { token } = await login(f);
  const res = await upload(f, Buffer.alloc(2048), 'big.bin', { authorization: `Bearer ${token}` });
  assert.deepEqual([res.status, res.json().error], [413, 'too-large']);
  assert.deepEqual(await readdir(join(f.data, 'sources', 'uploads')).catch(() => []), []);
}, { uploads: { maxFileBytes: 1024, maxFiles: 2 } }));

test('a message carries its files: she is told where they are, and sees the images beside it', () => withFixture(async f => {
  const { token } = await login(f);
  const auth = { authorization: `Bearer ${token}` };
  const pdf = (await upload(f, Buffer.from('%PDF-1.7 body'), '報告書.pdf', auth)).json();
  const png = (await upload(f, DECODABLE_PNG, 'shot.png', auth)).json();
  assert.equal(png.mimeType, 'image/png');
  const app = await device(f, auth);
  const snapshot = await app.sync();
  assert.deepEqual(snapshot.payload.uploads, { maxFileBytes: 25 * 1024 * 1024, maxFiles: 10 }, 'the devices are told the limits');
  f.model.auto = context => context.messages.at(-1)?.role === 'user'
    ? { calls: [{ name: 'reply_to_mac', arguments: { text: '見たよ', expression: 'happy' } }] } : {};
  const sent = await app.request('conversation.send', { text: 'これ見て', uploadIds: [pdf.uploadId, png.uploadId] });
  assert.equal(sent.type, 'command.accepted', JSON.stringify(sent.payload));
  const message = await app.until(item => item.type === 'conversation.message' && item.payload.role === 'owner');
  assert.deepEqual(message.payload.attachments.map((item: { name: string }) => item.name), ['報告書.pdf', 'shot.png']);
  await app.until(item => item.type === 'conversation.message' && item.payload.text === '見たよ');

  const context = f.model.contexts.find(item => userText(item).includes('mac_message'))!;
  const text = userText(context);
  assert.match(text, /"attachments":\[\{"path":"\/sources\/uploads\/\d{8}T\d{6}Z-[0-9a-f]{4}\/報告書\.pdf","bytes":13\},\{"path":"\/sources\/uploads\/\d{8}T\d{6}Z-[0-9a-f]{4}\/shot\.png","bytes":\d+,"shown_as_image":true\}\]/);
  assert.doesNotMatch(text, /upload-/, 'the IDs are never shown to her (ADR 0024)');
  assert.deepEqual(userImages(context), [DECODABLE_PNG.toString('base64')]);

  // The files come back to the devices by their IDs, and are kept in the history.
  const image = await fetch(`${f.base}/v1/uploads/${png.uploadId}`, { headers: auth });
  assert.deepEqual([image.status, image.headers.get('content-type')], [200, 'image/png']);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), DECODABLE_PNG);
  const file = await fetch(`${f.base}/v1/uploads/${pdf.uploadId}`, { headers: auth });
  assert.deepEqual([file.status, file.headers.get('content-type'), file.headers.get('x-content-type-options')],
    [200, 'application/octet-stream', 'nosniff']);
  assert.equal(file.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('報告書.pdf')}`);
  assert.equal(await file.text(), '%PDF-1.7 body');
  const cookie = await browserLogin(f);
  assert.equal((await f.fetch(`/v1/uploads/${png.uploadId}`, { headers: { cookie: `${COOKIE}=${cookie}` } })).status, 200, 'a GET takes the cookie');
  assert.equal((await f.fetch(`/v1/uploads/${png.uploadId}`)).status, 401);
  assert.equal((await f.fetch('/v1/uploads/upload-unknown', { headers: auth })).status, 404);
  const again = await device(f, auth);
  const later = await again.sync();
  const owner = later.payload.messages.find((item: { role: string }) => item.role === 'owner');
  assert.deepEqual(owner.attachments.map((item: { uploadId: string }) => item.uploadId), [pdf.uploadId, png.uploadId]);
  await again.close();
  await app.close();
}));

test('a file goes with one message only, of the account that sent it, and only what was sent is fetched', () => withFixture(async f => {
  const { token } = await login(f);
  const auth = { authorization: `Bearer ${token}` };
  const one = (await upload(f, Buffer.from('1'), 'one.txt', auth)).json();
  const unsent = (await upload(f, Buffer.from('2'), 'two.txt', auth)).json();
  const app = await device(f, auth);
  await app.sync();
  f.model.auto = () => ({});
  const unknown = await app.request('conversation.send', { text: 'x', uploadIds: ['upload-unknown'] });
  assert.deepEqual([unknown.type, unknown.payload.code], ['command.rejected', 'upload-not-found']);
  const first = await app.request('conversation.send', { text: '', uploadIds: [one.uploadId] }, 'request-first');
  assert.equal(first.type, 'command.accepted', 'a message may be its files alone');
  const repeated = await app.request('conversation.send', { text: '', uploadIds: [one.uploadId] }, 'request-first');
  assert.deepEqual([repeated.type, repeated.payload.messageId], ['command.accepted', first.payload.messageId], 'the same request is answered the same');
  const conflict = await app.request('conversation.send', { text: '', uploadIds: [unsent.uploadId] }, 'request-first');
  assert.deepEqual([conflict.type, conflict.payload.code], ['command.rejected', 'request-conflict']);
  const reused = await app.request('conversation.send', { text: 'もう一度', uploadIds: [one.uploadId] });
  assert.deepEqual([reused.type, reused.payload.code], ['command.rejected', 'upload-not-found']);
  for (const payload of [{ text: '' }, { text: '', uploadIds: [] }, { text: 'x', uploadIds: 'upload-1' }, { text: 'x', uploadIds: [1] }]) {
    const refused = await app.request('conversation.send', payload);
    assert.deepEqual([refused.type, refused.payload.code], ['command.rejected', 'invalid-request'], JSON.stringify(payload));
  }
  assert.equal((await f.fetch(`/v1/uploads/${unsent.uploadId}`, { headers: auth })).status, 404, 'a file no message carries is not fetched');
  await app.close();
}, { uploads: { maxFiles: 2 } }));

test('more files than a message may carry are refused', () => withFixture(async f => {
  const { token } = await login(f);
  const auth = { authorization: `Bearer ${token}` };
  const ids: string[] = [];
  for (const name of ['a', 'b', 'c']) ids.push(String((await upload(f, Buffer.from(name), name, auth)).json().uploadId));
  const app = await device(f, auth);
  await app.sync();
  const refused = await app.request('conversation.send', { text: 'x', uploadIds: ids });
  assert.deepEqual([refused.type, refused.payload.code], ['command.rejected', 'too-many-uploads']);
  await app.close();
}, { uploads: { maxFiles: 2 } }));

test('a message with an image that comes while she is thinking waits for the next turn, where the image goes beside it', () => withFixture(async f => {
  const { token } = await login(f);
  const auth = { authorization: `Bearer ${token}` };
  const app = await device(f, auth);
  await app.sync();
  await app.request('conversation.send', { text: 'まず' });
  const first = await f.model.next();
  const png = (await upload(f, DECODABLE_PNG, 'shot.png', auth)).json();
  const text = (await upload(f, Buffer.from('memo'), 'memo.txt', auth)).json();
  const withText = await app.request('conversation.send', { text: 'メモも', uploadIds: [text.uploadId] });
  assert.equal(withText.payload.state, 'processing', 'a file with no image to show is steered in as before');
  const withImage = await app.request('conversation.send', { text: 'これも', uploadIds: [png.uploadId] });
  assert.equal(withImage.payload.state, 'queued');
  f.model.auto = () => ({});
  first.finish();
  const deadline = Date.now() + 5_000;
  while (!f.model.contexts.some(context => userText(context).includes('これも')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const later = f.model.contexts.find(context => userText(context).includes('これも'))!;
  assert.ok(later, 'the message is handed to her');
  assert.deepEqual(userImages(later), [DECODABLE_PNG.toString('base64')]);
  await app.close();
}));
