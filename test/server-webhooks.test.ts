import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startFixture, type Fixture, type FixtureOptions } from './support/server-fixture.ts';

/**
 * The way in for webhooks (ADR 0091): `POST /v1/webhooks/<name>`, each webhook checked by its own bearer token or by
 * GitHub's HMAC of the body, a body of at most 1 MiB that is JSON, read as the webhook's format, and answered with a 2xx
 * only once what came is written under `/sources/webhooks/<name>/`. Without the config there is no such way in at all,
 * and the way in Alertmanager had of its own (ADR 0086) is gone.
 */

// Fictional values only.
const FRACTION_TOKEN = 'fixture-webhook-fraction-7c1d';
const PLAIN_TOKEN = 'fixture-webhook-plain-2b9e';
const GITHUB_SECRET = 'fixture-webhook-github-4e8a';

const hooks: FixtureOptions = {
  webhooks: async root => {
    await writeFile(join(root, 'fraction-token'), `${FRACTION_TOKEN}\n`);
    await writeFile(join(root, 'plain-token'), PLAIN_TOKEN);
    await writeFile(join(root, 'github-secret'), `${GITHUB_SECRET}\n`);
    return [
      { name: 'fraction', format: 'alertmanager', tokenFile: join(root, 'fraction-token'), description: 'クラスタ fraction のアラート。' },
      { name: 'plain', format: 'raw', tokenFile: join(root, 'plain-token'), description: '試しの送り手。' },
      { name: 'github', format: 'raw', secretFile: join(root, 'github-secret'), description: 'GitHub の issue。',
        headers: ['X-GitHub-Event', 'X-GitHub-Delivery'] },
    ];
  },
};

async function withFixture(fn: (f: Fixture) => Promise<void>, options: FixtureOptions = hooks) {
  const f = await startFixture(options);
  try { await fn(f); } finally { await f.cleanup(); }
}

const firing = (fingerprint: string, severity = 'warning') => ({
  version: '4', groupKey: '{}:{alertname="KubePodCrashLooping"}', status: 'firing', receiver: 'natsumi',
  alerts: [{
    status: 'firing', labels: { alertname: 'KubePodCrashLooping', severity }, annotations: { summary: 'Pod is crash looping.' },
    startsAt: '2025-12-31T23:50:00Z', endsAt: '0001-01-01T00:00:00Z', generatorURL: 'https://prometheus.example.test/graph', fingerprint,
  }],
});

function post(f: Fixture, name: string, body: string, headers: Record<string, string> = {}) {
  return f.fetch(`/v1/webhooks/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const signed = (body: string, secret = GITHUB_SECRET) =>
  ({ 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` });
const day = (f: Fixture, name: string) => join(f.data, 'sources', 'webhooks', name, '2026-01-01.jsonl');
const lines = async (f: Fixture, name: string) => (await readFile(day(f, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('an alertmanager webhook takes a notification with its token, and writes it before the answer', () => withFixture(async f => {
  const res = await post(f, 'fraction', JSON.stringify(firing('a1')), bearer(FRACTION_TOKEN));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json(), { recorded: 1 });
  assert.deepEqual((await lines(f, 'fraction')).map(line => line.fingerprint), ['a1']);
  const again = await post(f, 'fraction', JSON.stringify(firing('a1')), bearer(FRACTION_TOKEN));
  assert.deepEqual([again.status, again.json()], [200, { recorded: 0 }], 'the same state sent again is no line');
  assert.equal((await f.fetch('/v1/webhooks/fraction', { headers: bearer(FRACTION_TOKEN) })).status, 404, 'a POST only');
}));

test('a raw webhook checked by GitHub’s signature writes the body with the headers it names', () => withFixture(async f => {
  const body = JSON.stringify({ action: 'opened', issue: { number: 7, title: '直して' } });
  const res = await post(f, 'github', body, { ...signed(body), 'x-github-event': 'issues', 'x-github-delivery': 'delivery-1', 'x-github-hook-id': '9' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json(), { recorded: 1 });
  assert.deepEqual(await lines(f, 'github'), [{ at: '2026-01-01 00:00:00', headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'delivery-1' },
    body: { action: 'opened', issue: { number: 7, title: '直して' } } }]);
}));

test('a raw webhook checked by a token writes the body alone', () => withFixture(async f => {
  const res = await post(f, 'plain', '{"n": 1}', bearer(PLAIN_TOKEN));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(await lines(f, 'plain'), [{ at: '2026-01-01 00:00:00', body: { n: 1 } }]);
}));

test('an unknown name, a wrong token or signature and none at all are the same 401', () => withFixture(async f => {
  const body = JSON.stringify(firing('a1'));
  const refusals = [
    await post(f, 'fraction', body, bearer(PLAIN_TOKEN)),
    await post(f, 'fraction', body, bearer(`${FRACTION_TOKEN}x`)),
    await post(f, 'fraction', body),
    await post(f, 'fraction', body, { authorization: FRACTION_TOKEN }),
    await post(f, 'fraction', body, signed(body, FRACTION_TOKEN)),
    await post(f, 'github', body),
    await post(f, 'github', body, signed(body, 'fixture-another-secret')),
    await post(f, 'github', body, signed(`${body} `)),
    await post(f, 'github', body, bearer(GITHUB_SECRET)),
    await post(f, 'elsewhere', body, bearer(FRACTION_TOKEN)),
    await post(f, 'a%2Fb', body, bearer(FRACTION_TOKEN)),
  ];
  for (const res of refusals) assert.deepEqual([res.status, res.text], [401, '{"error":"unauthorized"}']);
  assert.equal(f.seen.some(text => text.includes(FRACTION_TOKEN) || text.includes(GITHUB_SECRET) || text.includes('-token')), false);
  await assert.rejects(readFile(day(f, 'fraction')), 'nothing was written');
  await assert.rejects(readFile(day(f, 'github')));
  assert.equal(f.logs.some(line => line.includes(FRACTION_TOKEN) || line.includes(GITHUB_SECRET)), false);
}));

test('the browser’s login does not let a webhook in', () => withFixture(async f => {
  const res = await post(f, 'plain', '{}', { cookie: 'natsumi_session=fixture-anything' });
  assert.equal(res.status, 401);
}));

test('a body past 1 MiB is a 413, one that is not JSON a 415, and one not of the format a 400', () => withFixture(async f => {
  const large = JSON.stringify({ padding: 'x'.repeat(1024 * 1024) });
  assert.equal((await post(f, 'plain', large, bearer(PLAIN_TOKEN))).status, 413);
  assert.equal((await post(f, 'github', large, signed(large))).status, 413);
  assert.equal((await post(f, 'github', large)).status, 413, 'a signed webhook cannot be checked before its body is read');
  assert.equal((await post(f, 'plain', large)).status, 401, 'a token webhook is checked first');
  for (const body of ['{"alerts": [', 'not json', '']) {
    const res = await post(f, 'fraction', body, bearer(FRACTION_TOKEN));
    assert.deepEqual([res.status, res.json().error], [415, 'not-json'], body);
    assert.equal((await post(f, 'plain', body, bearer(PLAIN_TOKEN))).status, 415, body);
  }
  for (const body of ['null', '{"alerts": "none"}', JSON.stringify({ alerts: [{ status: 'firing' }] })]) {
    const res = await post(f, 'fraction', body, bearer(FRACTION_TOKEN));
    assert.deepEqual([res.status, res.json().error], [400, 'invalid-request'], body);
  }
  assert.equal((await post(f, 'plain', 'null', bearer(PLAIN_TOKEN))).status, 200, 'raw takes any JSON');
  assert.equal((await post(f, 'fraction', JSON.stringify(firing('a1')), bearer(FRACTION_TOKEN))).status, 200, 'not shut out after it');
}));

test('what cannot be written is a 5xx, for the sender to send again', () => withFixture(async f => {
  await rm(join(f.data, 'sources', 'webhooks', 'plain'), { recursive: true, force: true });
  await writeFile(join(f.data, 'sources', 'webhooks', 'plain'), 'not a directory');
  const failed = await post(f, 'plain', '{"n": 1}', bearer(PLAIN_TOKEN));
  assert.equal(failed.status >= 500 && failed.status < 600, true, String(failed.status));
  await rm(join(f.data, 'sources', 'webhooks', 'plain'));
  await mkdir(join(f.data, 'sources', 'webhooks', 'plain'));
  assert.equal((await post(f, 'plain', '{"n": 2}', bearer(PLAIN_TOKEN))).status, 200);
  assert.deepEqual((await lines(f, 'plain')).map(line => line.body), [{ n: 1 }, { n: 2 }]);
}));

test('each webhook’s directory has the README.md of its config, written at start', () => withFixture(async f => {
  const readme = await readFile(join(f.data, 'sources', 'webhooks', 'github', 'README.md'), 'utf8');
  assert.match(readme, /GitHub の issue。/);
  assert.match(readme, /`raw`/);
  const alerts = await readFile(join(f.data, 'sources', 'webhooks', 'fraction', 'README.md'), 'utf8');
  assert.match(alerts, /`alertmanager`/);
  assert.equal(alerts.includes(FRACTION_TOKEN) || alerts.includes('fraction-token'), false, 'nothing of the token');
}));

test('without the config there is no way in, and Alertmanager’s own way in is gone', () => withFixture(async f => {
  assert.equal((await post(f, 'plain', '{}', bearer(PLAIN_TOKEN))).status, 404);
}, {}));

test('Alertmanager’s old way in is not found', () => withFixture(async f => {
  const res = await f.fetch('/v1/alertmanager/fraction', { method: 'POST', headers: bearer(FRACTION_TOKEN), body: JSON.stringify(firing('a1')) });
  assert.equal(res.status, 404);
}));

test('a notification sent again after a restart writes nothing', () => withFixture(async f => {
  await post(f, 'fraction', JSON.stringify(firing('a1')), bearer(FRACTION_TOKEN));
  await f.restart(4242001);
  const again = await post(f, 'fraction', JSON.stringify(firing('a1')), bearer(FRACTION_TOKEN));
  assert.deepEqual([again.status, again.json()], [200, { recorded: 0 }]);
}));

test('a token or secret file that cannot be read stops the start, naming the setting only', async () => {
  await assert.rejects(startFixture({ webhooks: async root => [{ name: 'plain', format: 'raw', tokenFile: join(root, 'missing'), description: 'x' }] }),
    (error: Error) => error.message.includes('webhooks[0].tokenFile') && !error.message.includes('missing'));
  await assert.rejects(startFixture({ webhooks: async root => [{ name: 'github', format: 'raw', secretFile: join(root, 'missing'), description: 'x' }] }),
    (error: Error) => error.message.includes('webhooks[0].secretFile') && !error.message.includes('missing'));
});
