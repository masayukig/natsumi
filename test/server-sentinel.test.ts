import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { approveAtGitHub, PUBLIC_ORIGIN, startFixture, type Fixture } from './support/server-fixture.ts';
import { FakeSentinel, fakeApproval } from './support/fake-sentinel.ts';

/**
 * The sentinel's approvals on the dashboard (ADR 0096): off unless the config names the socket, a thin window onto the
 * sentinel's ledger when on, answers and revokes as Origin-checked form POSTs, and nothing taken when the socket is down.
 */

const COOKIE = 'natsumi_session';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, ms = 5000) {
  const until = Date.now() + ms;
  while (!await condition()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function browserLogin(f: Fixture): Promise<string> {
  const start = await f.fetch('/dashboard');
  assert.equal(start.status, 302, start.text);
  const res = await f.fetch(await approveAtGitHub(f, new URL(start.headers.get('location')!)));
  assert.equal(res.status, 200, res.text);
  const line = res.headers.getSetCookie().find(cookie => cookie.startsWith(`${COOKIE}=`))!;
  return line.split(';')[0]!.slice(COOKIE.length + 1);
}

const withCookie = (cookie: string, init: RequestInit = {}): RequestInit =>
  ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie: `${COOKIE}=${cookie}` } });
const post = (cookie: string, body: string, headers: Record<string, string> = { origin: PUBLIC_ORIGIN }) =>
  withCookie(cookie, { method: 'POST', headers: { ...FORM, ...headers }, body });

async function withSentinel(fn: (f: Fixture, fake: FakeSentinel, cookie: string) => Promise<void>, options: { start?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-sentinel-'));
  const fake = new FakeSentinel(join(root, 'approvals.sock'));
  if (options.start !== false) await fake.start();
  const f = await startFixture({ sentinel: { socket: fake.socketPath } });
  // A closed approval's attention starts a turn of hers; it ends at once.
  f.model.auto = () => 'わかりました';
  try { await fn(f, fake, await browserLogin(f)); } finally {
    await f.cleanup();
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test('without the sentinel in the config there is no approvals window, no source, and the dashboard is as it was', async () => {
  const f = await startFixture();
  try {
    const cookie = await browserLogin(f);
    for (const path of ['/dashboard/sentinel', '/dashboard/sentinel/approvals/ap-0001', '/dashboard/sentinel/records', '/dashboard/sentinel/grants/gr-0001']) {
      const res = await f.fetch(path, withCookie(cookie));
      assert.equal(res.status, 404, path);
    }
    const answer = await f.fetch('/dashboard/sentinel/approvals/ap-0001/answer', post(cookie, 'answer=deny'));
    assert.equal(answer.status, 405, 'no POST is taken either: the path is one the dashboard does not have, as before');
    const status = await f.fetch('/dashboard', withCookie(cookie));
    assert.ok(!status.text.includes('関所'), 'nothing of the sentinel on the dashboard');
    assert.equal((await f.fetch('/dashboard/approvals', withCookie(cookie))).status, 200, 'the history of the Slack approvals stays where it is');
    await assert.rejects(stat(join(f.data, 'sources', 'sentinel')));
    assert.ok(!f.logs.some(line => line.startsWith('sentinel:')), f.logs.join('\n'));
  } finally { await f.cleanup(); }
});

test('the window lists what waits, oldest first, and shows the sentinel\'s own words as plain text', () => withSentinel(async (f, fake, cookie) => {
  fake.create(fakeApproval({ summary: '<script>alert(1)</script> **太字** https://evil.example.test' }), false);
  fake.create(fakeApproval({ id: 'ap-0002', summary: '二つ目の承認待ち' }), false);
  const res = await f.fetch('/dashboard/sentinel', withCookie(cookie));
  assert.equal(res.status, 200, res.text);
  assert.ok(res.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; **太字** https://evil.example.test'), 'escaped, not read as markup');
  assert.ok(!res.text.includes('<script>alert') && !res.text.includes('<strong>太字') && !res.text.includes('href="https://evil'));
  assert.ok(res.text.indexOf('ap-0001') < res.text.indexOf('ap-0002'), 'the oldest first');
  assert.match(res.text, /href="\/dashboard\/sentinel\/approvals\/ap-0001"/);
  assert.match(res.text, /href="\/dashboard\/sentinel\/records"/);
  assert.match(res.text, /aria-current="page">関所</, 'the window has its place in the navigation');
  const status = await f.fetch('/dashboard', withCookie(cookie));
  assert.match(status.text, /href="\/dashboard\/sentinel"/, 'the current state points to it');
}));

test('one approval shows its facts and a form of the choices the sentinel gave', () => withSentinel(async (f, fake, cookie) => {
  fake.create(fakeApproval(), false);
  const res = await f.fetch('/dashboard/sentinel/approvals/ap-0001', withCookie(cookie));
  assert.equal(res.status, 200, res.text);
  for (const fact of ['pulls.merge', 'PUT', '/repos/example/widgets/pulls/7/merge', 'owner=example repo=widgets', 'number', '{&quot;merge_method&quot;:&quot;merge&quot;}']) {
    assert.ok(res.text.includes(fact), `shows ${fact}`);
  }
  assert.match(res.text, /<form method="post" action="\/dashboard\/sentinel\/approvals\/ap-0001\/answer">/);
  assert.match(res.text, /<input type="radio" name="choice" value="once"[^>]*>/);
  assert.match(res.text, /<input type="radio" name="choice" value="1h"[^>]*>/);
  assert.ok(res.text.includes('example/widgets の pulls.merge を 1 時間'));
  assert.match(res.text, /<button type="submit" name="answer" value="allow">/);
  assert.match(res.text, /<button type="submit" name="answer" value="deny">/);
  assert.equal((await f.fetch('/dashboard/sentinel/approvals/ap-9999', withCookie(cookie))).status, 404);
  assert.equal((await f.fetch('/dashboard/sentinel/approvals/..%2Fgrants', withCookie(cookie))).status, 404);
}));

test('an approval of several items shows each, with the facts its connector looked up as plain text', () => withSentinel(async (f, fake, cookie) => {
  const [first] = fakeApproval().items;
  fake.create(fakeApproval({ items: [
    { ...first, facts: [{ name: 'head', value: '<b>abc123</b>' }] },
    { destination: 'github.example.test', operation: 'git.push', params: [{ name: 'ref', value: 'refs/tags/v1.0.0' }] },
  ] }), false);
  const res = await f.fetch('/dashboard/sentinel/approvals/ap-0001', withCookie(cookie));
  assert.equal(res.status, 200, res.text);
  assert.ok(res.text.includes('1 つ目') && res.text.includes('2 つ目'));
  assert.ok(res.text.includes('&lt;b&gt;abc123&lt;/b&gt;') && !res.text.includes('<b>abc123'), 'a fact is plain text');
  assert.ok(res.text.includes('git.push') && res.text.includes('refs/tags/v1.0.0'));
}));

test('an answer is the Origin-checked POST of a live session, passed to the sentinel as it is', () => withSentinel(async (f, fake, cookie) => {
  fake.create(fakeApproval(), false);
  const path = '/dashboard/sentinel/approvals/ap-0001/answer';
  for (const headers of [{}, { origin: 'https://attacker.example.test' }, { origin: 'null' }] as Record<string, string>[]) {
    const res = await f.fetch(path, post(cookie, 'answer=allow&choice=1h', headers));
    assert.equal(res.status, 403, JSON.stringify(headers));
  }
  const anonymous = await f.fetch(path, { method: 'POST', headers: { ...FORM, origin: PUBLIC_ORIGIN }, body: 'answer=allow&choice=1h' });
  assert.equal(anonymous.status, 403, 'no session, no answer; and no login is started from a POST');
  assert.equal((await f.fetch(path, withCookie(cookie))).status, 405, 'a GET answers nothing');
  for (const body of ['answer=maybe', 'answer=allow', 'answer=allow&choice=1h&choice=once', 'answer=allow&choice=%3Cx%3E']) {
    assert.equal((await f.fetch(path, post(cookie, body))).status, 400, body);
  }
  assert.ok(!fake.requests.some(request => request.startsWith('POST ')), 'nothing reached the sentinel');

  const res = await f.fetch(path, post(cookie, 'answer=allow&choice=1h'));
  assert.equal(res.status, 303, res.text);
  assert.equal(res.headers.get('location'), '/dashboard/sentinel/approvals/ap-0001?answered=1');
  assert.deepEqual(fake.bodies, [{ answer: 'allow', choice: '1h' }]);
  const after = await f.fetch('/dashboard/sentinel/approvals/ap-0001?answered=1', withCookie(cookie));
  assert.ok(after.text.includes('答えを関所に渡しました'));
  assert.ok(!after.text.includes('name="answer"'), 'a closed approval has no form');

  const again = await f.fetch(path, post(cookie, 'answer=deny&choice=once'));
  assert.equal(again.status, 409, 'the sentinel\'s refusal is passed on');
  assert.ok(again.text.includes('ap-0001 is already allowed'), 'in its own words');
  assert.deepEqual(fake.bodies.at(-1), { answer: 'deny' }, 'a denial carries no choice');
}));

test('a grant in force is revoked from the page that asks first', () => withSentinel(async (f, fake, cookie) => {
  fake.create(fakeApproval(), false);
  fake.close('ap-0001', 'allowed', '1h', false);
  const list = await f.fetch('/dashboard/sentinel', withCookie(cookie));
  assert.ok(list.text.includes('gr-0001') && list.text.includes('example/widgets の pulls.merge を 1 時間'));
  assert.match(list.text, /href="\/dashboard\/sentinel\/grants\/gr-0001"/);
  const ask = await f.fetch('/dashboard/sentinel/grants/gr-0001', withCookie(cookie));
  assert.equal(ask.status, 200, ask.text);
  assert.match(ask.text, /<form method="post" action="\/dashboard\/sentinel\/grants\/gr-0001\/revoke">/);
  assert.equal(fake.grants.size, 1, 'opening the page revokes nothing');

  const path = '/dashboard/sentinel/grants/gr-0001/revoke';
  assert.equal((await f.fetch(path, post(cookie, '', {}))).status, 403);
  assert.equal((await f.fetch(path, withCookie(cookie))).status, 405);
  const res = await f.fetch(path, post(cookie, ''));
  assert.equal(res.status, 303, res.text);
  assert.equal(res.headers.get('location'), '/dashboard/sentinel?revoked=gr-0001');
  assert.equal(fake.grants.size, 0);
  const gone = await f.fetch(path, post(cookie, ''));
  assert.equal(gone.status, 404, 'the sentinel no longer has it');
  assert.ok(gone.text.includes('no such grant'));
  assert.equal((await f.fetch('/dashboard/sentinel/grants/gr-0001', withCookie(cookie))).status, 404);
}));

test('the records are read a page at a time, and one record whole', () => withSentinel(async (f, fake, cookie) => {
  fake.records = Array.from({ length: 60 }, (_, index) => ({ id: index + 1, time: '2026-01-01T00:00:00Z', source: 'penelope', kind: 'http',
    verdict: index % 2 ? 'allow' : 'ask', name: 'github.example.test', method: 'POST', path: `/repos/example/widgets/issues/${index + 1}/comments`,
    request: { text: '{"body":"<b>見て</b>"}', size: 22, sha256: 'ef'.repeat(32) }, finished: true }));
  const first = await f.fetch('/dashboard/sentinel/records', withCookie(cookie));
  assert.equal(first.status, 200, first.text);
  assert.ok(first.text.includes('/repos/example/widgets/issues/60/comments') && !first.text.includes('/issues/10/comments'));
  assert.match(first.text, /href="\/dashboard\/sentinel\/records\?before=11"/, 'the next page starts where the sentinel says');
  const second = await f.fetch('/dashboard/sentinel/records?before=11', withCookie(cookie));
  assert.ok(second.text.includes('/issues/10/comments') && !second.text.includes('records?before='));
  const one = await f.fetch('/dashboard/sentinel/records/3', withCookie(cookie));
  assert.equal(one.status, 200);
  assert.ok(one.text.includes('{&quot;body&quot;:&quot;&lt;b&gt;見て&lt;/b&gt;&quot;}'), 'the body as plain text');
  for (const path of ['/dashboard/sentinel/records?before=x', '/dashboard/sentinel/records?before=1&before=2', '/dashboard/sentinel/records/x',
    '/dashboard/sentinel/records/999']) {
    assert.equal((await f.fetch(path, withCookie(cookie))).status, 404, path);
  }
}));

test('with the socket down the server still starts, the window says so, and no answer or revoke is taken', () => withSentinel(async (f, fake, cookie) => {
  const page = await f.fetch('/dashboard/sentinel', withCookie(cookie));
  assert.equal(page.status, 503);
  assert.ok(page.text.includes('関所につながらない'));
  const status = await f.fetch('/dashboard', withCookie(cookie));
  assert.ok(status.text.includes('つながらない'));
  const answer = await f.fetch('/dashboard/sentinel/approvals/ap-0001/answer', post(cookie, 'answer=allow&choice=once'));
  assert.equal(answer.status, 503);
  assert.ok(answer.text.includes('関所につながらない'));
  const revoke = await f.fetch('/dashboard/sentinel/grants/gr-0001/revoke', post(cookie, ''));
  assert.equal(revoke.status, 503);

  // It keeps trying, and the window is back once the sentinel is.
  fake.create(fakeApproval(), false);
  await fake.start();
  await waitFor(async () => (await f.fetch('/dashboard/sentinel', withCookie(cookie))).status === 200, 'the window to come back');
}, { start: false }));

test('an approval that closes is put under /sources/sentinel/approvals', () => withSentinel(async (f, fake, cookie) => {
  await waitFor(() => fake.streamCount === 1, 'the server to follow the events');
  fake.create(fakeApproval());
  const res = await f.fetch('/dashboard/sentinel/approvals/ap-0001/answer', post(cookie, 'answer=deny'));
  assert.equal(res.status, 303, res.text);
  const file = join(f.data, 'sources', 'sentinel', 'approvals', 'ap-0001.json');
  await waitFor(async () => { try { await stat(file); return true; } catch { return false; } }, 'the file');
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as { state: string }).state, 'denied');
}));
