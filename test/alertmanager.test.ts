import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AlertmanagerWebhook, parseNotification } from '../src/server/alertmanager.ts';
import { ConversationStore } from '../src/server/conversation-store.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SOURCES_DEFAULTS, Sources } from '../src/server/sources.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { WEBHOOKS_REGISTRATION } from '../src/server/webhooks.ts';

/**
 * The webhook format `alertmanager` (ADR 0091, as ADR 0086 had it): one line a change of an alert's state in the day's
 * file under `/sources/webhooks/<name>/`, what fires now in `firing.jsonl`, which the history leaves out, and an
 * attention when an alert of a heavy severity begins to fire. The state of every alert is kept by the webhook's name,
 * so a notification sent again writes nothing, across a restart as well.
 */

const TIME_ZONE = 'Asia/Tokyo';
const MINUTE = 60_000;
/** 10:00:05 in Tokyo, 2026-10-30. */
const MORNING = Date.parse('2026-10-30T01:00:05Z');
const AT_MEAN = 1 - Math.exp(-1);

interface AlertInput {
  fingerprint: string;
  status?: 'firing' | 'resolved';
  alertname?: string;
  severity?: string;
  startsAt?: string;
  endsAt?: string;
  annotations?: Record<string, string>;
}

function alert(input: AlertInput) {
  const status = input.status ?? 'firing';
  return {
    status,
    labels: { alertname: input.alertname ?? 'KubePodCrashLooping', namespace: 'default', ...(input.severity === undefined ? {} : { severity: input.severity }) },
    annotations: input.annotations ?? { summary: 'Pod is crash looping.', runbook_url: 'https://runbooks.example.test/KubePodCrashLooping' },
    startsAt: input.startsAt ?? '2026-10-30T00:50:00.123Z',
    endsAt: input.endsAt ?? (status === 'resolved' ? '2026-10-30T01:00:00Z' : '0001-01-01T00:00:00Z'),
    generatorURL: 'https://prometheus.example.test/graph?g0.expr=up',
    fingerprint: input.fingerprint,
  };
}

function notification(...alerts: ReturnType<typeof alert>[]) {
  return {
    version: '4', groupKey: '{}:{alertname="KubePodCrashLooping"}', truncatedAlerts: 0,
    status: alerts.some(item => item.status === 'firing') ? 'firing' : 'resolved', receiver: 'natsumi',
    groupLabels: { alertname: 'KubePodCrashLooping' }, commonLabels: {}, commonAnnotations: {}, externalURL: 'https://alertmanager.example.test',
    alerts,
  };
}

async function setup(t: test.TestContext, options: { attentionSeverities?: string[] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-alertmanager-')));
  let db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  let clock = MORNING;
  const now = () => clock;
  const directory = join(root, 'sources');
  const make = () => {
    const sources = new Sources({
      db, directory, gitDirectory: join(root, 'sources.git'), timeZone: TIME_ZONE, awakeHours: { start: '08:00', end: '23:00' },
      activity: SOURCES_DEFAULTS.activity, historyDays: SOURCES_DEFAULTS.historyDays, now, raise: () => { raised += 1; }, random: () => AT_MEAN,
    });
    sources.register(WEBHOOKS_REGISTRATION);
    const hooks = new Map<string, AlertmanagerWebhook>();
    const hook = (name: string) => {
      let made = hooks.get(name);
      if (!made) hooks.set(name, made = new AlertmanagerWebhook({ db, name, directory: join(directory, 'webhooks'), timeZone: TIME_ZONE,
        attentionSeverities: options.attentionSeverities ?? ['critical'], now, sources }));
      return made;
    };
    return { sources, hook, prepare: () => Promise.all(['fraction', 'test'].map(name => hook(name).prepare())) };
  };
  let raised = 0;
  let made = make();
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const send = (name: string, body: unknown) => {
    const received = made.hook(name).receive(body);
    assert.ok(received, 'the notification is read');
    return received;
  };
  const read = (path: string) => readFile(join(directory, 'webhooks', path), 'utf8');
  const lines = async (path: string) => (await read(path)).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  const take = async () => {
    const eventId = new ConversationStore(db, now).insertEvent('sources-updated');
    const ready = await made.sources.take(eventId);
    return ready ? made.sources.eventLine(eventId, 'received') as Record<string, any> : undefined;
  };
  return {
    root, directory, send, read, lines, take,
    get sources() { return made.sources; },
    hook: (name: string) => made.hook(name),
    raised: () => raised,
    /** The core started over files already there, so that a directory appearing later is a change, shown whole. */
    async start() {
      await send('seed', notification(alert({ fingerprint: 'seed' })));
      await made.sources.prepare();
    },
    advance: (ms: number) => { clock += ms; },
    /** As the server starts again: the same database and files, new webhooks and a new core. */
    async restart() {
      db.close();
      db = openStateDatabase(join(root, 'state.sqlite'));
      migrate(db, MIGRATIONS);
      made = make();
      await made.sources.prepare();
      await made.prepare();
    },
  };
}

test('a notification is read only in the shape Alertmanager sends', () => {
  assert.ok(parseNotification(notification(alert({ fingerprint: 'a1' }))));
  assert.ok(parseNotification({ alerts: [] }), 'a group with nothing in it is still a notification');
  for (const bad of [null, [], 'text', {}, { alerts: 'x' }, { alerts: [{}] },
    { alerts: [{ ...alert({ fingerprint: 'a1' }), status: 'pending' }] },
    { alerts: [{ ...alert({ fingerprint: 'a1' }), fingerprint: '' }] },
    { alerts: [{ ...alert({ fingerprint: 'a1' }), labels: { alertname: 3 } }] },
    { alerts: [{ ...alert({ fingerprint: 'a1' }), annotations: [] }] },
    { alerts: [{ ...alert({ fingerprint: 'a1' }), startsAt: 'yesterday' }] },
    { alerts: [{ ...alert({ fingerprint: 'a1' }), fingerprint: '../a1' }] }]) {
    assert.equal(parseNotification(bad), undefined, JSON.stringify(bad));
  }
});

test('a body not in the shape Alertmanager sends is not taken', async t => {
  const f = await setup(t);
  assert.equal(f.hook('fraction').receive({ alerts: 'none' }), undefined);
  assert.equal(f.hook('fraction').receive(null), undefined);
});

test('an alert that begins to fire is a line of the day, and is in firing.jsonl', async t => {
  const f = await setup(t);
  assert.deepEqual(await f.send('fraction', notification(alert({ fingerprint: 'a1', severity: 'warning' }))), { recorded: 1 });
  assert.deepEqual(await f.lines('fraction/2026-10-30.jsonl'), [{
    at: '2026-10-30 10:00:05', status: 'firing', alertname: 'KubePodCrashLooping', severity: 'warning',
    labels: { alertname: 'KubePodCrashLooping', namespace: 'default', severity: 'warning' },
    annotations: { summary: 'Pod is crash looping.', runbook_url: 'https://runbooks.example.test/KubePodCrashLooping' },
    starts_at: '2026-10-30 09:50:00', fingerprint: 'a1', generator_url: 'https://prometheus.example.test/graph?g0.expr=up',
    group_key: '{}:{alertname="KubePodCrashLooping"}',
  }]);
  assert.deepEqual((await f.lines('fraction/firing.jsonl')).map(line => [line.fingerprint, line.status]), [['a1', 'firing']]);
});

test('the same state sent again writes no line; firing.jsonl takes what came last', async t => {
  const f = await setup(t);
  await f.send('fraction', notification(alert({ fingerprint: 'a1' })));
  f.advance(4 * 60 * MINUTE);
  const again = await f.send('fraction', notification(alert({ fingerprint: 'a1', annotations: { summary: 'Still crash looping.' } })));
  assert.deepEqual(again, { recorded: 0 });
  assert.equal((await f.lines('fraction/2026-10-30.jsonl')).length, 1);
  const [firing] = await f.lines('fraction/firing.jsonl');
  assert.deepEqual([firing!.annotations, firing!.at], [{ summary: 'Still crash looping.' }, '2026-10-30 14:00:05']);
});

test('every change of state is a line: resolved, firing again, and resolved for an alert never seen', async t => {
  const f = await setup(t);
  await f.send('fraction', notification(alert({ fingerprint: 'a1' })));
  f.advance(MINUTE);
  assert.deepEqual(await f.send('fraction', notification(alert({ fingerprint: 'a1', status: 'resolved' }))), { recorded: 1 });
  assert.deepEqual(await f.send('fraction', notification(alert({ fingerprint: 'a1', status: 'resolved' }))), { recorded: 0 });
  f.advance(MINUTE);
  await f.send('fraction', notification(alert({ fingerprint: 'a1' })));
  await f.send('fraction', notification(alert({ fingerprint: 'b2', status: 'resolved', alertname: 'TargetDown' })));
  const day = await f.lines('fraction/2026-10-30.jsonl');
  assert.deepEqual(day.map(line => [line.fingerprint, line.status]), [['a1', 'firing'], ['a1', 'resolved'], ['a1', 'firing'], ['b2', 'resolved']]);
  assert.equal(day[1]!.ends_at, '2026-10-30 10:00:00', 'a resolved line says when it ended');
  assert.equal('ends_at' in day[0]!, false, 'a firing one does not');
  assert.deepEqual((await f.lines('fraction/firing.jsonl')).map(line => line.fingerprint), ['a1']);
});

test('firing.jsonl holds what fires now in the order it began, and is emptied when nothing does', async t => {
  const f = await setup(t);
  await f.send('fraction', notification(alert({ fingerprint: 'late', startsAt: '2026-10-30T00:58:00Z' }),
    alert({ fingerprint: 'early', startsAt: '2026-10-30T00:10:00Z' })));
  assert.deepEqual((await f.lines('fraction/firing.jsonl')).map(line => line.fingerprint), ['early', 'late']);
  await f.send('fraction', notification(alert({ fingerprint: 'late', status: 'resolved' }), alert({ fingerprint: 'early', status: 'resolved' })));
  assert.equal(await f.read('fraction/firing.jsonl'), '');
});

test('each webhook has a directory of its own, and the same fingerprint in two is two alerts', async t => {
  const f = await setup(t);
  await f.send('fraction', notification(alert({ fingerprint: 'a1' })));
  assert.deepEqual(await f.send('test', notification(alert({ fingerprint: 'a1' }))), { recorded: 1 });
  assert.equal((await f.lines('test/2026-10-30.jsonl')).length, 1);
  assert.equal((await f.lines('fraction/2026-10-30.jsonl')).length, 1);
});

test('a line goes into the file of the day it was received, in natsumi’s time zone', async t => {
  const f = await setup(t);
  await f.send('fraction', notification(alert({ fingerprint: 'a1' })));
  f.advance(14 * 60 * MINUTE); // 00:00:05 the next day in Tokyo
  await f.send('fraction', notification(alert({ fingerprint: 'a1', status: 'resolved' })));
  assert.deepEqual((await f.lines('fraction/2026-10-31.jsonl')).map(line => [line.status, line.at]), [['resolved', '2026-10-31 00:00:05']]);
  assert.equal((await f.lines('fraction/2026-10-30.jsonl')).length, 1);
});

test('a critical alert that begins to fire is an attention at its line; warnings and resolutions wait', async t => {
  const f = await setup(t);
  await f.start();
  await f.send('fraction', notification(alert({ fingerprint: 'w1', severity: 'warning' })));
  assert.equal(f.raised(), 0, 'a warning asks for no event at once');
  await f.send('fraction', notification(alert({ fingerprint: 'c1', severity: 'critical', alertname: 'NodeDown' })));
  assert.equal(f.raised(), 1);
  const line = await f.take();
  assert.ok(line);
  const [changed] = line.changed;
  assert.equal(changed.dir, '/sources/webhooks/fraction');
  assert.deepEqual(changed.files, ['/sources/webhooks/fraction/2026-10-30.jsonl'], 'firing.jsonl is out of the history');
  assert.deepEqual(changed.attention, [{ source: 'webhooks', kind: 'alert', file: '/sources/webhooks/fraction/2026-10-30.jsonl',
    path: '.[1]', alertname: 'NodeDown', severity: 'critical' }]);

  await f.send('fraction', notification(alert({ fingerprint: 'c1', severity: 'critical', alertname: 'NodeDown', status: 'resolved' })));
  await f.send('fraction', notification(alert({ fingerprint: 'c1', severity: 'critical', alertname: 'NodeDown' })));
  assert.equal(f.raised(), 2, 'firing again is a new attention; the resolution between is not');
  await f.send('fraction', notification(alert({ fingerprint: 'c1', severity: 'critical', alertname: 'NodeDown' })));
  assert.equal(f.raised(), 2, 'sent again, it is no new attention');
});

test('the severities marked for her are the config’s, and none at all can be', async t => {
  const f = await setup(t, { attentionSeverities: ['critical', 'page'] });
  await f.sources.prepare();
  await f.send('fraction', notification(alert({ fingerprint: 'p1', severity: 'page' })));
  assert.equal(f.raised(), 1);
  const g = await setup(t, { attentionSeverities: [] });
  await g.sources.prepare();
  await g.send('fraction', notification(alert({ fingerprint: 'c1', severity: 'critical' })));
  assert.equal(g.raised(), 0);
});

test('a change of firing.jsonl alone is no change of the source', async t => {
  const f = await setup(t);
  await f.start();
  await f.send('fraction', notification(alert({ fingerprint: 'a1' })));
  await f.sources.tick();
  f.advance(90 * MINUTE);
  assert.ok(await f.take(), 'the first line is a change');
  await f.send('fraction', notification(alert({ fingerprint: 'a1', annotations: { summary: 'changed' } })));
  await f.sources.tick();
  f.advance(90 * MINUTE);
  assert.equal(await f.take(), undefined);
});

test('what could not be written is refused, and written when the notification comes again', async t => {
  const f = await setup(t);
  await mkdir(join(f.directory, 'webhooks'), { recursive: true });
  await writeFile(join(f.directory, 'webhooks', 'fraction'), 'not a directory');
  await assert.rejects(f.send('fraction', notification(alert({ fingerprint: 'a1' }))));
  await rm(join(f.directory, 'webhooks', 'fraction'));
  assert.deepEqual(await f.send('fraction', notification(alert({ fingerprint: 'a1' }))), { recorded: 0 }, 'its state was kept');
  assert.deepEqual((await f.lines('fraction/2026-10-30.jsonl')).map(line => line.fingerprint), ['a1'], 'and its line is written once');
});

test('the state of every alert outlives a restart', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  await f.send('fraction', notification(alert({ fingerprint: 'a1' })));
  await f.restart();
  assert.deepEqual(await f.send('fraction', notification(alert({ fingerprint: 'a1' }))), { recorded: 0 });
  assert.deepEqual(await f.send('fraction', notification(alert({ fingerprint: 'a1', status: 'resolved' }))), { recorded: 1 });
  assert.deepEqual((await f.lines('fraction/2026-10-30.jsonl')).map(line => line.status), ['firing', 'resolved']);
});

test('a restart writes again what a refused notification left unwritten', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  await mkdir(join(f.directory, 'webhooks'), { recursive: true });
  await writeFile(join(f.directory, 'webhooks', 'fraction'), 'not a directory');
  await assert.rejects(f.send('fraction', notification(alert({ fingerprint: 'a1' }))));
  await rm(join(f.directory, 'webhooks', 'fraction'));
  await f.restart();
  assert.deepEqual((await f.lines('fraction/2026-10-30.jsonl')).map(line => line.fingerprint), ['a1']);
  assert.deepEqual((await f.lines('fraction/firing.jsonl')).map(line => line.fingerprint), ['a1']);
});
