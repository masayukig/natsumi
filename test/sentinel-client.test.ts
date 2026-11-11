import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SentinelClient } from '../src/server/sentinel-client.ts';
import { FakeSentinel, fakeApproval } from './support/fake-sentinel.ts';

/**
 * The server's side of the sentinel's approvals socket (ADR 0096, natsumi-sentinel `docs/approvals-api.md`): what it asks,
 * how it reads the answers, and what it makes of a refusal and of a socket that is not there.
 */

async function withSentinel(fn: (fake: FakeSentinel, client: SentinelClient) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-sentinel-'));
  const fake = await new FakeSentinel(join(root, 'approvals.sock')).start();
  try { await fn(fake, new SentinelClient({ socketPath: fake.socketPath })); } finally {
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test('the open approvals are read from the socket, oldest first, with their facts and choices as the sentinel gave them', () => withSentinel(async (fake, client) => {
  fake.create(fakeApproval(), false);
  fake.create(fakeApproval({ id: 'ap-0002', summary: '二つ目' }), false);
  const listed = await client.approvals();
  assert.equal(listed.kind, 'ok');
  if (listed.kind !== 'ok') return;
  assert.deepEqual(listed.value.map(approval => approval.id), ['ap-0001', 'ap-0002']);
  const [first] = listed.value;
  assert.equal(first!.summary, 'github.example.test の pulls.merge（owner=example repo=widgets number=7）');
  assert.deepEqual(first!.choices.map(choice => [choice.id, choice.scope, choice.seconds, choice.label]),
    [['once', 'once', 600, 'この要求を 1 回だけ'], ['1h', 'timed', 3600, 'example/widgets の pulls.merge を 1 時間']]);
  assert.equal(first!.items[0]!.operation, 'pulls.merge');
  assert.deepEqual(first!.items[0]!.params, [{ name: 'owner', value: 'example' }, { name: 'repo', value: 'widgets' }, { name: 'number', value: '7' }]);
  assert.equal(first!.items[0]!.body?.text, '{"merge_method":"merge"}');
  assert.equal(fake.requests.at(-1), 'GET /v1/approvals?state=open&limit=1000');

  const one = await client.approval('ap-0002');
  assert.equal(one.kind === 'ok' && one.value.summary, '二つ目');
}));

test('an answer is posted as the sentinel takes it, and a refusal comes back with its status and its words', () => withSentinel(async (fake, client) => {
  fake.create(fakeApproval(), false);
  const allowed = await client.answer('ap-0001', { answer: 'allow', choice: '1h' });
  assert.equal(allowed.kind === 'ok' && allowed.value.state, 'allowed');
  assert.deepEqual(fake.bodies.at(-1), { answer: 'allow', choice: '1h' });
  assert.equal(fake.requests.at(-1), 'POST /v1/approvals/ap-0001/answer');

  const again = await client.answer('ap-0001', { answer: 'deny' });
  assert.deepEqual(again, { kind: 'refused', status: 409, error: 'ap-0001 is already allowed' });
  assert.deepEqual(fake.bodies.at(-1), { answer: 'deny' }, 'a denial carries no choice');
  assert.deepEqual(await client.answer('ap-9999', { answer: 'deny' }), { kind: 'refused', status: 404, error: 'no such approval' });
}));

test('the grants are listed and one is revoked by its id', () => withSentinel(async (fake, client) => {
  fake.create(fakeApproval(), false);
  fake.close('ap-0001', 'allowed', '1h', false);
  const grants = await client.grants();
  assert.equal(grants.kind, 'ok');
  if (grants.kind !== 'ok') return;
  assert.deepEqual(grants.value.map(grant => [grant.id, grant.approval, grant.scope, grant.expires, grant.target]),
    [['gr-0001', 'ap-0001', 'timed', '2026-01-01T01:05:00Z', 'owner=example repo=widgets']]);
  const revoked = await client.revoke('gr-0001');
  assert.equal(revoked.kind === 'ok' && revoked.value.id, 'gr-0001');
  assert.equal(fake.requests.at(-1), 'DELETE /v1/grants/gr-0001');
  assert.deepEqual(await client.revoke('gr-0001'), { kind: 'refused', status: 404, error: 'no such grant' });
}));

test('the records are read a page at a time, newest first, by the id the sentinel says comes next', () => withSentinel(async (fake, client) => {
  fake.records = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, time: '2026-01-01T00:00:00Z', kind: 'http', verdict: 'allow', finished: true }));
  const first = await client.records({ limit: 2 });
  assert.equal(first.kind, 'ok');
  if (first.kind !== 'ok') return;
  assert.deepEqual(first.value.records.map(record => record.id), [5, 4]);
  assert.equal(first.value.next, 4);
  const second = await client.records({ before: 4, limit: 2 });
  assert.deepEqual(second.kind === 'ok' && second.value.records.map(record => record.id), [3, 2]);
  assert.equal(fake.requests.at(-1), 'GET /v1/records?before=4&limit=2');
  const last = await client.records({ before: 2, limit: 2 });
  assert.equal(last.kind === 'ok' && last.value.next, undefined);
  const one = await client.record(3);
  assert.equal(one.kind === 'ok' && one.value.id, 3);
}));

test('a socket that is not there, or a ledger that cannot be read, is told apart and never taken for an answer', () => withSentinel(async (fake, client) => {
  fake.failWith = 503;
  assert.deepEqual(await client.approvals(), { kind: 'refused', status: 503, error: 'the ledger could not be read' });
  await fake.stop();
  assert.deepEqual(await client.approvals(), { kind: 'unreachable' });
  assert.deepEqual(await client.answer('ap-0001', { answer: 'allow', choice: 'once' }), { kind: 'unreachable' });
  const nowhere = new SentinelClient({ socketPath: join(tmpdir(), 'natsumi-no-sentinel.sock') });
  assert.deepEqual(await nowhere.grants(), { kind: 'unreachable' });
}));

test('the events are read a line at a time: hello first, then what the sentinel writes', () => withSentinel(async (fake, client) => {
  const opened = await client.events(new AbortController().signal);
  assert.equal(opened.kind, 'ok');
  if (opened.kind !== 'ok') return;
  const seen: string[] = [];
  const reading = (async () => {
    for await (const event of opened.value) {
      seen.push(event.type === 'approval.created' || event.type === 'approval.closed' ? `${event.type} ${event.approval.id}` : event.type);
    }
  })();
  while (fake.streamCount === 0) await new Promise(resolve => setTimeout(resolve, 5));
  fake.emit({ type: 'ping' });
  fake.create(fakeApproval());
  fake.emit({ type: 'something-new' });
  fake.emit({ type: 'approval.closed', approval: { id: 'not an approval' } });
  fake.close('ap-0001', 'denied');
  await new Promise(resolve => setTimeout(resolve, 50));
  fake.dropStreams();
  await reading;
  assert.deepEqual(seen, ['hello', 'ping', 'approval.created ap-0001', 'approval.closed ap-0001'],
    'a type it does not know and an approval it cannot read are passed over');
}));
