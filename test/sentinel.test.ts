import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MIGRATIONS } from '../src/server/migrations.ts';
import type { PushEvent } from '../src/server/push.ts';
import { SentinelClient } from '../src/server/sentinel-client.ts';
import { SENTINEL_ATTENTION, SentinelWatcher } from '../src/server/sentinel.ts';
import type { Attention } from '../src/server/sources.ts';
import { migrate } from '../src/server/state-db.ts';
import { FakeSentinel, fakeApproval } from './support/fake-sentinel.ts';

/**
 * The sentinel's events, followed for as long as the server runs (ADR 0096): an approval that opens is told to the
 * browsers once, one that closes is put under /sources/sentinel/approvals with an attention, and what came while the
 * stream was down is caught up on from the list when it is back.
 */

const NOW = Date.parse('2026-01-01T00:10:00Z');

async function waitFor(condition: () => boolean, what: string, ms = 3000) {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function setup(options: { start?: boolean; pingTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-sentinel-'));
  const fake = new FakeSentinel(join(root, 'approvals.sock'));
  if (options.start !== false) await fake.start();
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS);
  const pushes: PushEvent[] = [];
  const attentions: Attention[] = [];
  const logs: string[] = [];
  let notified = 0;
  const directory = join(root, 'sources', 'sentinel');
  const make = () => {
    const watcher = new SentinelWatcher({
      client: new SentinelClient({ socketPath: fake.socketPath }), db, directory, now: () => NOW, log: line => logs.push(line),
      sources: { recordAttention: attention => { attentions.push(attention); return true; }, notify: () => { notified += 1; } },
      reconnectDelaysMs: [10], ...(options.pingTimeoutMs ? { pingTimeoutMs: options.pingTimeoutMs } : {}),
    });
    watcher.subscribe(event => pushes.push(event));
    return watcher;
  };
  const watchers: SentinelWatcher[] = [];
  const watch = () => { const watcher = make(); watchers.push(watcher); watcher.start(); return watcher; };
  return {
    root, fake, db, pushes, attentions, logs, directory, watch, notified: () => notified,
    async cleanup() {
      for (const watcher of watchers) watcher.close();
      await fake.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('a socket that is not there leaves the watcher waiting, and it connects and tells what is open once it is', async () => {
  const s = await setup({ start: false });
  try {
    const watcher = s.watch();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(watcher.connected, false);
    s.fake.create(fakeApproval(), false);
    await s.fake.start();
    await waitFor(() => watcher.connected && s.pushes.length === 1, 'the open approval to be told');
    assert.deepEqual(s.pushes, [{ type: 'sentinel.approval', payload: { approvalId: 'ap-0001',
      summary: 'github.example.test の pulls.merge（owner=example repo=widgets number=7）' } }]);
    assert.ok(s.logs.includes('sentinel: connected to the events'), s.logs.join('\n'));
  } finally { await s.cleanup(); }
});

test('an approval that opens is told once, even when told again, and not again by the next process', async () => {
  const s = await setup();
  try {
    const watcher = s.watch();
    await waitFor(() => watcher.connected && s.fake.streamCount === 1, 'the stream');
    s.fake.create(fakeApproval());
    s.fake.create(fakeApproval());
    await waitFor(() => s.pushes.length >= 1, 'the push');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(s.pushes.length, 1);
    watcher.close();
    const next = s.watch();
    await waitFor(() => next.connected, 'the next process');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(s.pushes.length, 1, 'what was told is kept in SQLite');
  } finally { await s.cleanup(); }
});

test('an approval that closes is put under /sources/sentinel/approvals with its facts, and marked for her once', async () => {
  const s = await setup();
  try {
    const watcher = s.watch();
    await waitFor(() => watcher.connected && s.fake.streamCount === 1, 'the stream');
    s.fake.create(fakeApproval({ items: [{ ...fakeApproval().items[0]!, facts: [{ name: 'head', value: 'abc123' }] }] }));
    s.fake.close('ap-0001', 'allowed', '1h');
    await waitFor(() => s.attentions.length === 1, 'the attention');
    const file = JSON.parse(await readFile(join(s.directory, 'approvals', 'ap-0001.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(file, {
      id: 'ap-0001', kind: 'request', state: 'allowed', source: 'penelope', created: '2026-01-01T00:00:00Z', expires: '2026-01-02T00:00:00Z',
      answered: '2026-01-01T00:05:00Z', summary: 'github.example.test の pulls.merge（owner=example repo=widgets number=7）',
      items: [{ destination: 'github.example.test', method: 'PUT', path: '/repos/example/widgets/pulls/7/merge', operation: 'pulls.merge',
        params: [{ name: 'owner', value: 'example' }, { name: 'repo', value: 'widgets' }, { name: 'number', value: '7' }],
        target: ['owner', 'repo'], targetText: 'owner=example repo=widgets', facts: [{ name: 'head', value: 'abc123' }] }],
      choice: { id: '1h', scope: 'timed', seconds: 3600, label: 'example/widgets の pulls.merge を 1 時間' },
      grants: [{ id: 'gr-0001', scope: 'timed', expires: '2026-01-01T01:05:00Z', summary: 'example/widgets の pulls.merge を 1 時間' }],
    }, 'the facts the sentinel gave, without the body or the fingerprint of the request');
    assert.deepEqual(s.attentions, [{ source: 'sentinel', kind: SENTINEL_ATTENTION, file: '/sources/sentinel/approvals/ap-0001.json',
      details: { approval: 'ap-0001', state: 'allowed', summary: 'github.example.test の pulls.merge（owner=example repo=widgets number=7）' } }]);
    assert.equal(SENTINEL_ATTENTION, 'approval_closed');
    assert.ok(s.notified() >= 1, 'the loop is asked for the event');

    s.fake.emit({ type: 'approval.closed', approval: s.fake.approvals.get('ap-0001') });
    s.fake.create(fakeApproval({ id: 'ap-0002' }));
    s.fake.close('ap-0002', 'expired');
    await waitFor(() => s.attentions.length === 2, 'the second attention');
    assert.deepEqual(s.attentions.map(attention => attention.details?.approval), ['ap-0001', 'ap-0002'], 'a close told twice is put once');
    const expired = JSON.parse(await readFile(join(s.directory, 'approvals', 'ap-0002.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(expired.state, 'expired');
    assert.equal(expired.choice, undefined);
    assert.deepEqual(expired.grants, []);
  } finally { await s.cleanup(); }
});

test('after the stream is lost it connects again and catches up from the lists on what opened and closed meanwhile', async () => {
  const s = await setup();
  try {
    const watcher = s.watch();
    await waitFor(() => watcher.connected && s.fake.streamCount === 1, 'the stream');
    s.fake.create(fakeApproval());
    await waitFor(() => s.pushes.length === 1, 'the first push');
    await s.fake.stop();
    await waitFor(() => !watcher.connected, 'the loss');
    s.fake.close('ap-0001', 'denied', undefined, false);
    s.fake.create(fakeApproval({ id: 'ap-0002' }), false);
    await s.fake.start();
    await waitFor(() => watcher.connected && s.pushes.length === 2 && s.attentions.length === 1, 'the catching up');
    assert.deepEqual(s.pushes.map(event => event.payload.approvalId), ['ap-0001', 'ap-0002']);
    assert.equal(s.attentions[0]!.details?.state, 'denied');
    assert.deepEqual(await readdir(join(s.directory, 'approvals')), ['ap-0001.json']);
  } finally { await s.cleanup(); }
});

test('a stream that goes quiet past the pings is given up on and opened again', async () => {
  const s = await setup({ pingTimeoutMs: 80 });
  try {
    const watcher = s.watch();
    await waitFor(() => watcher.connected, 'the stream');
    await waitFor(() => s.fake.requests.filter(request => request === 'GET /v1/events').length >= 2, 'the second stream');
  } finally { await s.cleanup(); }
});
