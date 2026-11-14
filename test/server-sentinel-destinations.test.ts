import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { approveAtGitHub, PUBLIC_ORIGIN, startFixture, type Fixture } from './support/server-fixture.ts';
import { FakeSentinel, fakeApproval, fakeDestinationApproval, fakeRefusedName } from './support/fake-sentinel.ts';

/**
 * The sentinel's destination grants on the approvals window (ADR 0098): the names it refused for not being in its table
 * and the grant from them, an approval of a destination answered with the unit, handling and access the sentinel offers,
 * the sentinel's words as they came, and a sentinel of the version before all this left as the window always was.
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

async function withSentinel(fn: (f: Fixture, fake: FakeSentinel, cookie: string) => Promise<void>, options: { destinations?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-sentinel-'));
  const fake = new FakeSentinel(join(root, 'approvals.sock'));
  fake.destinations = options.destinations ?? true;
  await fake.start();
  const f = await startFixture({ sentinel: { socket: fake.socketPath } });
  f.model.auto = () => 'わかりました';
  try { await fn(f, fake, await browserLogin(f)); } finally {
    await f.cleanup();
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  }
}

const GRANT_PAGE = '/dashboard/sentinel/refused?source=penelope&name=docs.example.test';
const GRANT_POST = '/dashboard/sentinel/refused/grant';

test('a sentinel of the version before destination grants leaves the window as it was', () => withSentinel(async (f, fake, cookie) => {
  fake.create(fakeApproval(), false);
  fake.close('ap-0001', 'allowed', '1h', false);
  fake.create(fakeApproval({ id: 'ap-0002' }), false);
  const res = await f.fetch('/dashboard/sentinel', withCookie(cookie));
  assert.equal(res.status, 200, res.text);
  assert.ok(res.text.includes('ap-0002') && res.text.includes('gr-0001'), 'what waits and the grants, as before');
  assert.ok(!res.text.includes('断った名前'), 'no list of refused names where the sentinel has none');
  assert.ok(fake.requests.includes('GET /v1/refused-names?limit=1000'), 'it was asked, and its 404 taken as having none');

  const one = await f.fetch('/dashboard/sentinel/approvals/ap-0002', withCookie(cookie));
  assert.ok(!one.text.includes('name="unit"') && !one.text.includes('name="treatment"'), 'no options for an approval of an operation');
  const answer = await f.fetch('/dashboard/sentinel/approvals/ap-0002/answer', post(cookie, 'answer=allow&choice=1h'));
  assert.equal(answer.status, 303, answer.text);
  assert.deepEqual(fake.bodies.at(-1), { answer: 'allow', choice: '1h' }, 'the answer is of the same shape as before');

  const page = await f.fetch(GRANT_PAGE, withCookie(cookie));
  assert.equal(page.status, 404, 'no grant from a list the sentinel does not have');
  const grant = await f.fetch(GRANT_POST, post(cookie, 'source=penelope&name=docs.example.test&choice=1d&unit=name&treatment=inspect%3Aread'));
  assert.equal(grant.status, 404, grant.text);
}, { destinations: false }));

test('the names refused are listed with how often and when, in the sentinel\'s words as plain text', () => withSentinel(async (f, fake, cookie) => {
  fake.refusedNames = [
    fakeRefusedName(),
    fakeRefusedName({ name: 'telemetry.example.test', summary: '<b>telemetry</b> https://evil.example.test', count: 41 }),
  ];
  const res = await f.fetch('/dashboard/sentinel', withCookie(cookie));
  assert.equal(res.status, 200, res.text);
  assert.ok(res.text.includes('断った名前'));
  assert.ok(res.text.includes('docs.example.test') && res.text.includes('telemetry.example.test'));
  assert.ok(res.text.includes('41'), 'how often');
  assert.ok(res.text.includes('&lt;b&gt;telemetry&lt;/b&gt; https://evil.example.test') && !res.text.includes('href="https://evil'), 'plain text');
  assert.ok(res.text.includes('href="/dashboard/sentinel/refused?source=penelope&amp;name=docs.example.test"'), 'the way to a grant');
  assert.ok(res.text.indexOf('docs.example.test') < res.text.indexOf('telemetry.example.test'), 'in the sentinel\'s order');
}));

test('with no names refused, the list says so', () => withSentinel(async (f, _fake, cookie) => {
  const res = await f.fetch('/dashboard/sentinel', withCookie(cookie));
  assert.ok(res.text.includes('断った名前はありません'), res.text);
}));

test('the page of a name refused offers the sentinel\'s choices, its defaults first, and no passthrough that is read only', () => withSentinel(async (f, fake, cookie) => {
  fake.refusedNames = [fakeRefusedName({ name: 'a.b.example.test', inside: true })];
  const res = await f.fetch('/dashboard/sentinel/refused?source=penelope&name=a.b.example.test', withCookie(cookie));
  assert.equal(res.status, 200, res.text);
  assert.match(res.text, /<form method="post" action="\/dashboard\/sentinel\/refused\/grant">/);
  assert.match(res.text, /<input type="hidden" name="source" value="penelope">/);
  assert.match(res.text, /<input type="hidden" name="name" value="a.b.example.test">/);
  assert.match(res.text, /<input type="radio" name="choice" value="1d" checked>/);
  assert.match(res.text, /<input type="radio" name="choice" value="forever">/);
  assert.match(res.text, /<input type="radio" name="unit" value="name" checked>/);
  assert.match(res.text, /<input type="radio" name="unit" value="domain:b.example.test">/);
  assert.match(res.text, /<input type="radio" name="unit" value="domain:example.test">/);
  assert.ok(res.text.includes('example.test とその下のすべての名前が通る'), 'the breadth in the sentinel\'s words');
  assert.match(res.text, /<input type="radio" name="treatment" value="inspect:read" checked>/);
  assert.match(res.text, /<input type="radio" name="treatment" value="inspect:readwrite">/);
  assert.match(res.text, /<input type="radio" name="treatment" value="passthrough">/);
  assert.ok(!/name="treatment" value="passthrough:/.test(res.text), 'no passthrough with an access to choose');
  assert.ok(res.text.includes('開かない。読み書きとも通る。中身は見ない'), 'the passthrough in the sentinel\'s words');
  assert.ok(res.text.includes('内側の名前'), 'the mark of a name inside');
  assert.ok(res.text.includes('example.test'), 'the registrable domain');
  for (const path of ['/dashboard/sentinel/refused?source=penelope&name=nowhere.example.test', '/dashboard/sentinel/refused?name=a.b.example.test',
    '/dashboard/sentinel/refused?source=penelope&name=a&name=b']) {
    assert.equal((await f.fetch(path, withCookie(cookie))).status, 404, path);
  }
}));

test('a grant from a name refused is the Origin-checked POST of a live session, with the options chosen', () => withSentinel(async (f, fake, cookie) => {
  fake.refusedNames = [fakeRefusedName(), fakeRefusedName({ name: 'pkg.example.test' })];
  const body = 'source=penelope&name=docs.example.test&choice=1d&unit=domain%3Aexample.test&treatment=inspect%3Areadwrite';
  for (const headers of [{}, { origin: 'https://attacker.example.test' }] as Record<string, string>[]) {
    assert.equal((await f.fetch(GRANT_POST, post(cookie, body, headers))).status, 403, JSON.stringify(headers));
  }
  assert.equal((await f.fetch(GRANT_POST, { method: 'POST', headers: { ...FORM, origin: PUBLIC_ORIGIN }, body })).status, 403, 'no session');
  assert.equal((await f.fetch(GRANT_POST, withCookie(cookie))).status, 405, 'a GET grants nothing');
  for (const bad of ['source=penelope&name=docs.example.test&unit=name&treatment=inspect%3Aread',
    'source=penelope&choice=1d&unit=name&treatment=inspect%3Aread',
    'source=penelope&name=docs.example.test&choice=1d&unit=name&treatment=passthrough%3Aread',
    'source=penelope&name=docs.example.test&choice=1d&unit=name&treatment=inspect',
    'source=penelope&name=docs.example.test&choice=1d&unit=name&unit=domain%3Aexample.test&treatment=inspect%3Aread',
    'source=penelope&name=docs.example.test&choice=%3Cx%3E&unit=name&treatment=inspect%3Aread']) {
    assert.equal((await f.fetch(GRANT_POST, post(cookie, bad))).status, 400, bad);
  }
  assert.ok(!fake.requests.some(request => request.startsWith('POST ')), 'nothing reached the sentinel');

  const res = await f.fetch(GRANT_POST, post(cookie, body));
  assert.equal(res.status, 303, res.text);
  assert.equal(res.headers.get('location'), '/dashboard/sentinel?granted=gr-0001');
  assert.deepEqual(fake.bodies.at(-1), { source: 'penelope', name: 'docs.example.test', choice: '1d',
    options: { unit: 'domain:example.test', handling: 'inspect', access: 'readwrite' } });
  const after = await f.fetch('/dashboard/sentinel?granted=gr-0001', withCookie(cookie));
  assert.ok(after.text.includes('宛先の許し') && after.text.includes('gr-0001'));

  const passthrough = await f.fetch(GRANT_POST, post(cookie, 'source=penelope&name=pkg.example.test&choice=forever&unit=name&treatment=passthrough'));
  assert.equal(passthrough.status, 303, passthrough.text);
  assert.deepEqual(fake.bodies.at(-1), { source: 'penelope', name: 'pkg.example.test', choice: 'forever',
    options: { unit: 'name', handling: 'passthrough' } }, 'no access goes with a passthrough');

  const gone = await f.fetch(GRANT_POST, post(cookie, 'source=penelope&name=pkg.example.test&choice=1d&unit=name&treatment=inspect%3Aread'));
  assert.equal(gone.status, 404, 'the sentinel\'s refusal is passed on');
  assert.ok(gone.text.includes('pkg.example.test is not in the list of penelope'), 'in its own words');
  const refused = await f.fetch(GRANT_POST, post(cookie, 'source=penelope&name=docs.example.test&choice=1d&unit=name&treatment=inspect%3Aread'));
  assert.equal(refused.status, 404);
}));

test('an approval of a destination waits in the same list, and is answered with the sentinel\'s options', () => withSentinel(async (f, fake, cookie) => {
  await waitFor(() => fake.streamCount === 1, 'the server to follow the events');
  fake.create(fakeApproval(), false);
  fake.create(fakeDestinationApproval());
  const list = await f.fetch('/dashboard/sentinel', withCookie(cookie));
  assert.ok(list.text.includes('ap-0001') && list.text.includes('ap-0101'), 'both in one list');
  assert.ok(list.text.includes('先に頼まれた宛先'));

  const page = await f.fetch('/dashboard/sentinel/approvals/ap-0101', withCookie(cookie));
  assert.equal(page.status, 200, page.text);
  assert.ok(page.text.includes('docs.example.test') && page.text.includes('registrableDomain') && page.text.includes('refusedCount'),
    'the name and the facts the sentinel gave');
  assert.ok(!page.text.includes('内側の名前'), 'a name outside has no mark');
  assert.match(page.text, /<input type="radio" name="choice" value="1d" checked>/);
  assert.match(page.text, /<input type="radio" name="unit" value="name" checked>/);
  assert.match(page.text, /<input type="radio" name="unit" value="domain:example.test">/);
  assert.match(page.text, /<input type="radio" name="treatment" value="inspect:read" checked>/);
  assert.match(page.text, /<input type="radio" name="treatment" value="passthrough">/);

  const path = '/dashboard/sentinel/approvals/ap-0101/answer';
  assert.equal((await f.fetch(path, post(cookie, 'answer=allow&choice=1d&unit=name&treatment=passthrough%3Aread'))).status, 400);
  assert.equal((await f.fetch(path, post(cookie, 'answer=allow&choice=1d&unit=name'))).status, 400, 'a unit without the handling');
  const res = await f.fetch(path, post(cookie, 'answer=allow&choice=1d&unit=name&treatment=inspect%3Aread'));
  assert.equal(res.status, 303, res.text);
  assert.deepEqual(fake.bodies.at(-1), { answer: 'allow', choice: '1d', options: { unit: 'name', handling: 'inspect', access: 'read' } });
  const answered = await f.fetch('/dashboard/sentinel/approvals/ap-0101', withCookie(cookie));
  assert.ok(answered.text.includes('docs.example.test だけ') && answered.text.includes('開いて見る / 読みだけ。書きは聞く'),
    'what was chosen, in the sentinel\'s words');

  // It closes as any approval does, and her file has the grant it made.
  const file = join(f.data, 'sources', 'sentinel', 'approvals', 'ap-0101.json');
  await waitFor(async () => { try { await stat(file); return true; } catch { return false; } }, 'the file');
  const closed = JSON.parse(await readFile(file, 'utf8')) as { kind: string; state: string; chosen: unknown; grants: Record<string, unknown>[] };
  assert.equal(closed.kind, 'destination');
  assert.deepEqual(closed.chosen, { unit: 'name', handling: 'inspect', access: 'read' });
  assert.equal(closed.state, 'allowed');
  assert.deepEqual(closed.grants.map(grant => [grant.id, grant.kind, grant.name, grant.unit, grant.handling, grant.access]),
    [['gr-0001', 'destination', 'docs.example.test', 'name', 'inspect', 'read']]);
}));

test('a denial of an approval of a destination carries no options', () => withSentinel(async (f, fake, cookie) => {
  fake.create(fakeDestinationApproval(), false);
  const res = await f.fetch('/dashboard/sentinel/approvals/ap-0101/answer', post(cookie, 'answer=deny&unit=name&treatment=inspect%3Aread'));
  assert.equal(res.status, 303, res.text);
  assert.deepEqual(fake.bodies.at(-1), { answer: 'deny' });
}));

test('destination grants are listed with the grants, in the sentinel\'s words, and revoked the same way', () => withSentinel(async (f, fake, cookie) => {
  fake.refusedNames = [fakeRefusedName()];
  await f.fetch(GRANT_POST, post(cookie, 'source=penelope&name=docs.example.test&choice=forever&unit=name&treatment=passthrough'));
  const list = await f.fetch('/dashboard/sentinel', withCookie(cookie));
  assert.ok(list.text.includes('gr-0001') && list.text.includes('docs.example.test（この名前だけ、passthrough）を 期限なし'));
  assert.ok(list.text.includes('断った名前はありません'), 'a name granted leaves the list');
  const ask = await f.fetch('/dashboard/sentinel/grants/gr-0001', withCookie(cookie));
  assert.equal(ask.status, 200, ask.text);
  assert.ok(ask.text.includes('docs.example.test') && ask.text.includes('passthrough'));
  const res = await f.fetch('/dashboard/sentinel/grants/gr-0001/revoke', post(cookie, ''));
  assert.equal(res.status, 303, res.text);
  assert.equal(fake.grants.size, 0);
}));

test('a sentinel that cannot list the names refused still shows the rest, and says so', () => withSentinel(async (f, fake, cookie) => {
  fake.create(fakeApproval(), false);
  fake.refusedNamesFailWith = 503;
  const res = await f.fetch('/dashboard/sentinel', withCookie(cookie));
  assert.equal(res.status, 200, res.text);
  assert.ok(res.text.includes('ap-0001'));
  assert.ok(res.text.includes('断った名前の一覧を読めませんでした'), res.text);
}));

test('an approval of several names shows each, its inside mark, and only the units the sentinel offers', () => withSentinel(async (f, fake, cookie) => {
  fake.create(fakeDestinationApproval({
    items: [
      { destination: 'a.svc.example.test', facts: [{ name: 'inside', value: 'true' }, { name: 'registrableDomain', value: 'example.test' },
        { name: 'registrableDomainByDefaultRule', value: 'true' }] },
      { destination: 'b.svc.example.test', facts: [{ name: 'inside', value: 'true' }] },
    ],
    options: { ...fakeDestinationApproval().options!, unit: [{ id: 'name', label: 'それぞれの名前だけ' },
      { id: 'domain:svc.example.test', label: 'svc.example.test とその下のすべての名前が通る。接尾辞が一覧に無く、関所は上限を決めていない' }] },
  }), false);
  const page = await f.fetch('/dashboard/sentinel/approvals/ap-0101', withCookie(cookie));
  assert.equal(page.status, 200, page.text);
  assert.ok(page.text.includes('a.svc.example.test') && page.text.includes('b.svc.example.test') && page.text.includes('2 つ目'));
  assert.equal(page.text.split('内側の名前').length - 1, 2, 'a mark on each name inside');
  assert.ok(page.text.includes('接尾辞が一覧に無く、関所は上限を決めていない'), 'the breadth in the sentinel\'s words');
  assert.match(page.text, /<input type="radio" name="unit" value="domain:svc.example.test">/);
  assert.ok(!page.text.includes('value="domain:example.test"'), 'no unit the sentinel did not offer');
}));
