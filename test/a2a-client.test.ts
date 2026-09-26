import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { A2ACallError, AgentFileError, SdkA2AClient } from '../src/server/a2a-client.ts';
import { FakeAgent } from './support/fake-agent.ts';
import { PNG } from './support/fake-slack.ts';

async function setup(t: test.TestContext, options: ConstructorParameters<typeof SdkA2AClient>[0] extends infer O ? Partial<O> : never = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'natsumi-a2a-'));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'first-token\n');
  const agent = await FakeAgent.start({ token: 'first-token', name: 'Fake Wiki Keeper', description: 'Keeps a wiki.',
    skills: [{ id: 'query', name: '問い合わせ', description: 'Wiki の内容に答える', examples: ['〜について教えて'] }] });
  t.after(async () => { await agent.close(); await rm(directory, { recursive: true, force: true }); });
  const client = new SdkA2AClient({ tokenFile, ...options });
  return { agent, client, tokenFile };
}

// ADR 0035: the tool only says the request was taken; the answer is fetched later, so the send returns at once.
test('a message goes to the configured URL with the token as a bearer, and returns the task it started', async t => {
  const { agent, client } = await setup(t);
  const sent = await client.send(agent.url, { text: 'この記事を取り込んで' });
  assert.equal(sent.kind, 'task');
  assert.equal(sent.state, 'waiting');
  const task = agent.lastTask();
  assert.equal(sent.taskId, task.id);
  assert.equal(sent.contextId, task.contextId);
  assert.deepEqual(agent.received, [{ authorization: 'Bearer first-token', text: 'この記事を取り込んで', contextId: '', taskId: '',
    returnImmediately: true }]);
});

// ADR 0033: a projected token is replaced while the server runs, so it is read from the file on every call.
test('the token is read from its file again for every call', async t => {
  const { agent, client, tokenFile } = await setup(t);
  await client.send(agent.url, { text: '一つ目' });
  agent.token = 'second-token';
  await writeFile(tokenFile, 'second-token\n');
  await client.send(agent.url, { text: '二つ目' });
  assert.deepEqual(agent.received.map(message => message.authorization), ['Bearer first-token', 'Bearer second-token']);
});

test('a context and a task can be named, to go on with a conversation or to answer a question', async t => {
  const { agent, client } = await setup(t);
  const first = await client.send(agent.url, { text: '最初' });
  assert.equal(first.kind, 'task');
  agent.settle(first.taskId, 'input-required', 'どの記事ですか？');
  const answered = await client.send(agent.url, { text: 'index の方です', contextId: first.contextId, taskId: first.taskId });
  assert.equal(answered.kind, 'task');
  assert.equal(answered.taskId, first.taskId);
  assert.equal(answered.state, 'waiting');
  assert.equal(agent.received[1]!.contextId, first.contextId);
  assert.equal(agent.received[1]!.taskId, first.taskId);
});

test('a task is read back as waiting, completed with its answer, failed, or asking a question', async t => {
  const { agent, client } = await setup(t);
  const sent = await client.send(agent.url, { text: '教えて' });
  assert.equal(sent.kind, 'task');
  assert.deepEqual(await client.getTask(agent.url, sent.taskId), { state: 'waiting', text: '' });
  agent.settle(sent.taskId, 'input-required', 'どの記事ですか？');
  assert.deepEqual(await client.getTask(agent.url, sent.taskId), { state: 'input-required', text: 'どの記事ですか？' });
  agent.settle(sent.taskId, 'completed', '答えはこれです。');
  assert.deepEqual(await client.getTask(agent.url, sent.taskId), { state: 'completed', text: '答えはこれです。' });
  agent.settle(sent.taskId, 'failed', 'モデルの呼び出しに失敗しました。');
  assert.deepEqual(await client.getTask(agent.url, sent.taskId), { state: 'failed', text: 'モデルの呼び出しに失敗しました。' });
  agent.settle(sent.taskId, 'rejected');
  assert.deepEqual(await client.getTask(agent.url, sent.taskId), { state: 'failed', text: '' });
});

test('an agent that answers with a message at once is read as a reply, with no task to wait for', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'natsumi-a2a-'));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'fake-agent-token');
  const agent = await FakeAgent.start({ replyWithMessage: 'すぐ答えます。' });
  t.after(async () => { await agent.close(); await rm(directory, { recursive: true, force: true }); });
  const sent = await new SdkA2AClient({ tokenFile }).send(agent.url, { text: 'やあ' });
  assert.equal(sent.kind, 'message');
  assert.equal(sent.text, 'すぐ答えます。');
  assert.ok(sent.contextId);
});

// ADR 0036: the card is public, so no token goes with it.
test('the Agent Card is fetched without the token and read as a name, a description and skills', async t => {
  const { agent, client } = await setup(t);
  assert.deepEqual(await client.card(agent.url), {
    name: 'Fake Wiki Keeper', description: 'Keeps a wiki.',
    skills: [{ name: '問い合わせ', description: 'Wiki の内容に答える', examples: ['〜について教えて'] }],
  });
  assert.deepEqual(agent.cardRequests, [undefined]);
});

test('failures are told apart: no token, an agent out of reach, a refusal, and a task it does not know', async t => {
  const { agent, client, tokenFile } = await setup(t);
  const kind = async (call: Promise<unknown>) => {
    try { await call; } catch (error) {
      assert.ok(error instanceof A2ACallError, String(error));
      return error.kind;
    }
    assert.fail('the call did not fail');
  };
  assert.equal(await kind(client.getTask(agent.url, 'no-such-task')), 'not-found');
  assert.equal(await kind(client.send(agent.url, { text: 'x', contextId: 'not-one-of-yours' })), 'refused');
  agent.token = 'another-token';
  assert.equal(await kind(client.send(agent.url, { text: 'x' })), 'unavailable');
  agent.token = 'first-token';
  agent.failWith = 503;
  assert.equal(await kind(client.send(agent.url, { text: 'x' })), 'unavailable');
  agent.failWith = undefined;
  await rm(tokenFile);
  assert.equal(await kind(client.send(agent.url, { text: 'x' })), 'no-token');
  await writeFile(tokenFile, '  \n');
  assert.equal(await kind(client.send(agent.url, { text: 'x' })), 'no-token');
  await writeFile(tokenFile, 'first-token');
  const url = agent.url;
  await agent.close();
  assert.equal(await kind(client.send(url, { text: 'x' })), 'unavailable');
  assert.equal(await kind(client.card(url)), 'unavailable');
});

test('a call that hangs is given up after the time limit', async t => {
  const { agent, client: _ } = await setup(t);
  const hanging = new SdkA2AClient({ tokenFile: '/dev/null', timeoutMs: 50,
    fetch: () => new Promise<Response>(() => {}) });
  await assert.rejects(hanging.card(agent.url), (error: unknown) => error instanceof A2ACallError && error.kind === 'unavailable');
});

// The contract with fraction-agents: a finished task hands each image back as an artifact of its own with one FilePart,
// which A2A 1.0 writes as `{ url, mediaType, filename }`. The file is fetched later, under the same token.
test('a finished task reads back the files of its artifacts, each with its URL, type, name and description', async t => {
  const { agent, client } = await setup(t);
  const sent = await client.send(agent.url, { text: 'スクリーンショットを撮って' });
  assert.equal(sent.kind, 'task');
  agent.settle(sent.taskId, 'completed', '撮りました。', { files: [
    { name: 'screenshot-1.png', mimeType: 'image/png', description: 'トップページ', data: PNG },
    { name: 'elsewhere.png', mimeType: 'image/png', uri: 'https://elsewhere.example/artifacts/x' },
  ] });
  const view = await client.getTask(agent.url, sent.taskId);
  assert.equal(view.state, 'completed');
  assert.equal(view.text, '撮りました。', 'the files are not read as text');
  assert.equal(view.files?.length, 2);
  assert.match(view.files![0]!.uri, /^http:\/\/127\.0\.0\.1:\d+\/artifacts\/[0-9a-f]{64}$/);
  assert.deepEqual({ ...view.files![0], uri: undefined },
    { uri: undefined, mediaType: 'image/png', name: 'screenshot-1.png', description: 'トップページ' });
  assert.deepEqual(view.files![1], { uri: 'https://elsewhere.example/artifacts/x', mediaType: 'image/png', name: 'elsewhere.png',
    description: '' });
});

test('a file of an artifact is fetched with the token of the calls', async t => {
  const { agent, client } = await setup(t);
  const sent = await client.send(agent.url, { text: '撮って' });
  assert.equal(sent.kind, 'task');
  agent.settle(sent.taskId, 'completed', '撮りました。', { files: [{ name: 'a.png', mimeType: 'image/png', data: PNG }] });
  const [file] = (await client.getTask(agent.url, sent.taskId)).files!;
  assert.deepEqual(await client.fetchFile(agent.url, file!.uri, 1024), PNG);
  assert.deepEqual(agent.fileRequests.map(r => r.authorization), ['Bearer first-token']);

  agent.chunkedFiles = true;
  assert.deepEqual(await client.fetchFile(agent.url, file!.uri, 1024), PNG, 'a file without Content-Length is read too');
});

test('a file is refused before any request when it is elsewhere, and its failures are told apart', async t => {
  const { agent, client, tokenFile } = await setup(t);
  const sent = await client.send(agent.url, { text: '撮って' });
  assert.equal(sent.kind, 'task');
  const big = Buffer.concat([PNG, Buffer.alloc(2048)]);
  agent.settle(sent.taskId, 'completed', '撮りました。', { files: [{ name: 'a.png', mimeType: 'image/png', data: PNG },
    { name: 'big.png', mimeType: 'image/png', data: big }] });
  const [small, large] = (await client.getTask(agent.url, sent.taskId)).files!;
  const kind = async (call: Promise<unknown>) => {
    try { await call; } catch (error) {
      assert.ok(error instanceof AgentFileError, String(error));
      return error.kind;
    }
    assert.fail('the fetch did not fail');
  };
  // Another origin never sees the token: not another host, not another port, not another scheme.
  const port = new URL(agent.url).port;
  for (const uri of [`http://localhost:${port}/artifacts/x`, `http://127.0.0.1:${Number(port) + 1}/artifacts/x`,
    `https://127.0.0.1:${port}/artifacts/x`, 'file:///etc/passwd']) {
    assert.equal(await kind(client.fetchFile(agent.url, uri, 1024)), 'elsewhere', uri);
  }
  assert.equal(agent.fileRequests.length, 0);

  assert.equal(await kind(client.fetchFile(agent.url, large!.uri, 1024)), 'too-large');
  agent.chunkedFiles = true;
  assert.equal(await kind(client.fetchFile(agent.url, large!.uri, 1024)), 'too-large', 'counted as it arrives, too');
  assert.equal(await kind(client.fetchFile(agent.url, agent.fileUrl('no-such-file'), 1024)), 'not-found');
  agent.fileFailWith = 401;
  assert.equal(await kind(client.fetchFile(agent.url, small!.uri, 1024)), 'unauthorized');
  agent.fileFailWith = 503;
  assert.equal(await kind(client.fetchFile(agent.url, small!.uri, 1024)), 'unavailable');
  agent.fileFailWith = undefined;
  await rm(tokenFile);
  assert.equal(await kind(client.fetchFile(agent.url, small!.uri, 1024)), 'no-token');
  await writeFile(tokenFile, 'first-token');
  const url = agent.url;
  await agent.close();
  assert.equal(await kind(client.fetchFile(url, small!.uri, 1024)), 'unavailable');
});
