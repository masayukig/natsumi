import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { ErrorCode } from '@slack/web-api';
import { callError, connectSlack, describeFailure, SlackCallError, toSlackMessage } from '../src/server/slack-api.ts';

/** How a failure of Slack's Web API reads in the log: the call, and Slack's own code, never what was asked for. */

test('Slack\'s refusal keeps its code and the scope it lacked', () => {
  const refused = Object.assign(new Error('An API error occurred: missing_scope'), {
    code: ErrorCode.PlatformError, data: { ok: false, error: 'missing_scope', needed: 'im:history', provided: 'channels:history' },
  });
  const error = callError('conversations.history', refused);
  assert.ok(error instanceof SlackCallError);
  assert.equal(describeFailure(error), 'conversations.history: missing_scope, needed im:history');
});

test('an HTTP error, a rate limit and a request that never arrived each say what they were', () => {
  const http = Object.assign(new Error('x'), { code: ErrorCode.HTTPError, statusCode: 503 });
  assert.equal(describeFailure(callError('users.info', http)), 'users.info: http_503');
  const limited = Object.assign(new Error('x'), { code: ErrorCode.RateLimitedError, retryAfter: 30 });
  assert.equal(describeFailure(callError('conversations.replies', limited)), 'conversations.replies: ratelimited');
  const request = Object.assign(new Error('x'), { code: ErrorCode.RequestError, original: Object.assign(new Error('y'), { code: 'ECONNRESET' }) });
  assert.equal(describeFailure(callError('users.conversations', request)), 'users.conversations: ECONNRESET');
});

test('a code that is not a plain word is not copied into the log', () => {
  const odd = Object.assign(new Error('x'), { code: ErrorCode.PlatformError, data: { ok: false, error: 'hello <@U123> xoxb-secret words' } });
  assert.equal(describeFailure(callError('conversations.history', odd)), 'conversations.history: unknown');
});

test('a failure that is not Slack\'s is named by its kind, and its code when it has one', () => {
  assert.equal(describeFailure(Object.assign(new Error('EACCES: /data/secret'), { code: 'EACCES' })), 'Error: EACCES');
  assert.equal(describeFailure(new TypeError('something with text')), 'TypeError');
  assert.equal(describeFailure('a string'), 'error');
});

test('a message\'s reactions are read with who put them on, and a message without the field has none said', () => {
  const message = toSlackMessage({ ts: '1.000100', user: 'U1', text: 'x', reactions: [
    { name: '+1', users: ['U1', 'U2'], count: 5 }, { name: 'tada', count: 1 }, { users: ['U1'], count: 1 }] });
  assert.deepEqual(message.reactions, [{ name: '+1', users: ['U1', 'U2'], count: 5 }, { name: 'tada', users: [], count: 1 }]);
  assert.equal(toSlackMessage({ ts: '1.000100', user: 'U1', text: 'x' }).reactions, undefined);
});

/** Slack's Web API on loopback, as far as files.uploadV2 goes: the upload URL, the upload, and completing it. */
async function fakeWebApi(t: test.TestContext, options: { uploadStatus?: number; complete?: Record<string, unknown> } = {}) {
  const calls: { path: string; authorization?: string; body: Buffer }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({ path: request.url ?? '', ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), body });
      const json = (value: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (request.url === '/api/files.getUploadURLExternal') {
        const id = `F${calls.filter(call => call.path === request.url).length}`;
        return json({ ok: true, upload_url: `${base}/upload/${id}`, file_id: id });
      }
      if (request.url?.startsWith('/upload/')) return response.writeHead(options.uploadStatus ?? 200).end('OK');
      if (request.url === '/api/files.completeUploadExternal') return json(options.complete ?? { ok: true, files: [] });
      if (request.url === '/api/chat.postMessage') return json({ ok: true, ts: '1790000000.000200' });
      json({ ok: false, error: 'unknown_method' });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const { api } = connectSlack({ botToken: 'xoxb-fixture', appToken: 'xapp-fixture' }, { apiUrl: `${base}/api/` });
  return { calls, api };
}

// ADR 0044: files.uploadV2's three steps, each image uploaded to the URL Slack gave for it, then one message for all.
test('images are uploaded in three steps: a URL for each, the bytes to it, and one completion with the comment and the thread', async t => {
  const f = await fakeWebApi(t);
  const cat = Buffer.from('cat-bytes');
  const dog = Buffer.from('dog-bytes-longer');
  await f.api.uploadFiles('C1', [{ filename: 'cat.png', data: cat }, { filename: 'dog.jpg', data: dog }],
    { initialComment: '描いたよ', threadTs: '1790000000.000100' });
  assert.deepEqual(f.calls.map(call => call.path.replace(/F\d/, 'F')), [
    '/api/files.getUploadURLExternal', '/api/files.getUploadURLExternal', '/upload/F', '/upload/F', '/api/files.completeUploadExternal']);
  const asked = f.calls.slice(0, 2).map(call => Object.fromEntries(new URLSearchParams(call.body.toString())));
  assert.deepEqual(asked.map(form => [form.filename, form.length]), [['cat.png', String(cat.length)], ['dog.jpg', String(dog.length)]]);
  assert.ok(f.calls.slice(0, 2).every(call => call.authorization === 'Bearer xoxb-fixture'));
  const uploaded = Object.fromEntries(f.calls.slice(2, 4).map(call => [call.path, call.body.toString()]));
  assert.deepEqual(uploaded, { '/upload/F1': 'cat-bytes', '/upload/F2': 'dog-bytes-longer' });
  assert.ok(f.calls.slice(2, 4).every(call => call.authorization === undefined), 'the token goes to Slack\'s API only, not to the upload URL');
  const completed = Object.fromEntries(new URLSearchParams(f.calls[4]!.body.toString()));
  assert.deepEqual(JSON.parse(completed.files!), [{ id: 'F1', title: 'cat.png' }, { id: 'F2', title: 'dog.jpg' }]);
  assert.equal(completed.channel_id, 'C1');
  assert.equal(completed.initial_comment, '描いたよ');
  assert.equal(completed.thread_ts, '1790000000.000100');
});

test('without a comment or a thread, completing names only the files and the channel', async t => {
  const f = await fakeWebApi(t);
  await f.api.uploadFiles('C1', [{ filename: 'cat.png', data: Buffer.from('x') }], {});
  const completed = Object.fromEntries(new URLSearchParams(f.calls.at(-1)!.body.toString()));
  assert.deepEqual(Object.keys(completed).filter(key => key !== 'token').sort(), ['channel_id', 'files']);
});

// Fork (ADR F01): the same upload, completed in no channel, for image blocks to show.
test('images uploaded unshared are completed without a channel, and their IDs come back in order', async t => {
  const f = await fakeWebApi(t);
  const ids = await f.api.uploadUnshared([{ filename: 'cat.png', data: Buffer.from('c') }, { filename: 'dog.jpg', data: Buffer.from('d') }]);
  assert.deepEqual(ids, ['F1', 'F2']);
  const completed = Object.fromEntries(new URLSearchParams(f.calls.at(-1)!.body.toString()));
  assert.deepEqual(Object.keys(completed).filter(key => key !== 'token').sort(), ['files']);
  assert.deepEqual(JSON.parse(completed.files!), [{ id: 'F1', title: 'cat.png' }, { id: 'F2', title: 'dog.jpg' }]);
});

test('an upload that fails stops before completing, and says which step failed', async t => {
  const f = await fakeWebApi(t, { uploadStatus: 500 });
  await assert.rejects(f.api.uploadFiles('C1', [{ filename: 'cat.png', data: Buffer.from('x') }], {}),
    (error: unknown) => error instanceof SlackCallError && describeFailure(error) === 'files.upload: http_500');
  assert.ok(!f.calls.some(call => call.path === '/api/files.completeUploadExternal'));
});

test('Slack refusing the completion is named by the call and its code', async t => {
  const f = await fakeWebApi(t, { complete: { ok: false, error: 'channel_not_found' } });
  await assert.rejects(f.api.uploadFiles('C1', [{ filename: 'cat.png', data: Buffer.from('x') }], {}),
    (error: unknown) => error instanceof SlackCallError && describeFailure(error) === 'files.completeUploadExternal: channel_not_found');
});

// ADR 0059: a reply placed in the channel is a reply in its thread, shown in the channel too.
test('a post in a thread may be shown in the channel too, and a post without a thread never carries reply_broadcast', async t => {
  const f = await fakeWebApi(t);
  const form = () => Object.fromEntries(new URLSearchParams(f.calls.at(-1)!.body.toString()));
  assert.equal(await f.api.postMessage('C1', '了解です', { threadTs: '1790000000.000100', replyBroadcast: true, iconUrl: 'https://natsumi.example.test/avatar/happy.png' }),
    '1790000000.000200');
  assert.deepEqual([form().thread_ts, form().reply_broadcast], ['1790000000.000100', 'true']);
  await f.api.postMessage('C1', '了解です', { threadTs: '1790000000.000100', iconUrl: 'https://natsumi.example.test/avatar/happy.png' });
  assert.equal(form().reply_broadcast, undefined);
  await f.api.postMessage('C1', 'おはよう', { replyBroadcast: true, iconUrl: 'https://natsumi.example.test/avatar/happy.png' });
  assert.deepEqual([form().thread_ts, form().reply_broadcast], [undefined, undefined]);
});
