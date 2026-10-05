import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, MigrationError, openStateDatabase, type Migration } from '../src/server/state-db.ts';

async function withDb(fn: (db: DatabaseSync, path: string) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-state-'));
  const path = join(root, 'state.sqlite');
  const db = openStateDatabase(path);
  try { await fn(db, path); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

const tables = (db: DatabaseSync) => (db.prepare(
  "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
  .map(row => row.name);

/** node:sqlite hands back null-prototype rows; the tests compare plain objects. */
const plainRows = (rows: unknown[]) => rows.map(row => ({ ...row as object }));

const one: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE a (id TEXT PRIMARY KEY);' };
const two: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE b (id TEXT PRIMARY KEY);' };

test('migrations apply in order and running them again changes nothing', () => withDb(db => {
  assert.deepEqual(migrate(db, [one, two]), { applied: [1, 2], version: 2 });
  db.prepare('INSERT INTO a (id) VALUES (?)').run('kept');
  assert.deepEqual(migrate(db, [one, two]), { applied: [], version: 2 });
  assert.deepEqual(tables(db), ['a', 'b', 'schema_migrations']);
  assert.equal((db.prepare('SELECT count(*) AS n FROM a').get() as { n: number }).n, 1);
}));

test('later code adds a migration on top of an existing database', () => withDb(db => {
  migrate(db, [one]);
  assert.deepEqual(migrate(db, [one, two]), { applied: [2], version: 2 });
}));

test('a failing migration leaves no partial schema and is not recorded', () => withDb(db => {
  const broken: Migration = { version: 2, name: 'broken',
    sql: 'CREATE TABLE half (id TEXT); INSERT INTO a (id) VALUES (\'x\'); CREATE TABLE a (dup TEXT);' };
  migrate(db, [one]);
  assert.throws(() => migrate(db, [one, broken]),
    (error: unknown) => error instanceof MigrationError && error.version === 2);
  assert.deepEqual(tables(db), ['a', 'schema_migrations']);
  assert.equal((db.prepare('SELECT count(*) AS n FROM a').get() as { n: number }).n, 0);
  assert.deepEqual(migrate(db, [one, two]), { applied: [2], version: 2 });
}));

test('the database stays usable after a failed run is reopened', () => withDb(async (db, path) => {
  assert.throws(() => migrate(db, [{ version: 1, name: 'bad', sql: 'CREATE TABLE x (; ' }]));
  const again = openStateDatabase(path);
  try { assert.deepEqual(migrate(again, [one]), { applied: [1], version: 1 }); } finally { again.close(); }
}));

test('malformed migration lists are rejected before touching the database', () => withDb(db => {
  assert.throws(() => migrate(db, [two, one]), /order/);
  assert.throws(() => migrate(db, [one, { ...two, version: 1 }]), /order/);
  assert.throws(() => migrate(db, [{ ...one, version: 0 }]), /version/);
  assert.deepEqual(tables(db), []);
}));

test('a database from newer or different code is refused', () => withDb(db => {
  migrate(db, [one, two]);
  assert.throws(() => migrate(db, [one]), /newer/);
  assert.throws(() => migrate(db, [one, { ...two, name: 'renamed' }]), /does not match/);
}));

test('the initial schema applies cleanly and twice', () => withDb(db => {
  const first = migrate(db, MIGRATIONS);
  assert.ok(first.applied.length > 0);
  assert.deepEqual(migrate(db, MIGRATIONS).applied, []);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
}));

test('the schema keeps the conversation shown to the owner and only references to the Pi session', () => withDb(db => {
  migrate(db, MIGRATIONS);
  // Text lives in one table: what the owner sees. Thoughts and tool calls stay in the Pi session (ADR 0008).
  for (const table of tables(db)) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
    for (const column of columns) {
      if (table === 'conversation_messages' && column === 'text') continue;
      // An agent's answer waits here until it is handed to Pi, and is emptied then: the record is the Pi session's.
      if (table === 'agent_replies' && column === 'text') continue;
      // What was said in Slack, which the day files are written from again on every edit and deletion (ADR 0039).
      // It is Slack's record, not natsumi's thinking, and the Pi session holds it only as far as an event carried it.
      if (table === 'slack_messages' && column === 'text') continue;
      // What natsumi asked the dove to post, kept with Jev's scores and the owner's decision to look back on (ADR 0040).
      // It is what went, or was to go, to Slack; her thinking about it stays in the Pi session.
      if (table === 'dove_posts' && column === 'text') continue;
      // The dove's answer waits here until it is handed to Pi, and is emptied then, like an agent's.
      if (table === 'dove_replies' && column === 'text') continue;
      assert.doesNotMatch(column, /^(text|body|content|message|prompt|reply|response|thinking|tool_calls?)$/i, `${table}.${column}`);
    }
  }
  const conversation = { id: 'conversation-example', session: 'session-example' };
  db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
    .run(conversation.id, conversation.session, 'fixture.jsonl', '2026-01-01T00:00:00Z');
  // Session references are relative to the Pi session directory; absolute or escaping paths are refused.
  for (const file of ['/abs/fixture.jsonl', '../escape.jsonl', 'a/../../escape.jsonl']) {
    assert.throws(() => db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
      .run(`c-${file}`, `s-${file}`, file, '2026-01-01T00:00:00Z'), /constraint/i);
  }

  const insert = db.prepare(`INSERT INTO conversation_messages
    (message_id, position, role, kind, text, event_id, request_id, device_id, created_at) VALUES (?, ?, ?, ?, 'x', ?, ?, ?, 'x')`);
  insert.run('message-1', 1, 'owner', 'message', 'event-1', 'request-1', 'device-1');
  // A request ID names one owner message.
  assert.throws(() => insert.run('message-2', 2, 'owner', 'message', 'event-2', 'request-1', 'device-1'), /constraint/i);
  // Only the owner writes messages; natsumi's words are replies or notices.
  assert.throws(() => insert.run('message-3', 3, 'natsumi', 'message', 'event-3', 'request-3', 'device-1'), /constraint/i);
  assert.throws(() => insert.run('message-4', 4, 'owner', 'reply', 'event-1', null, null), /constraint/i);
  // One reply per event.
  insert.run('message-5', 5, 'natsumi', 'reply', 'event-1', null, null);
  assert.throws(() => insert.run('message-6', 6, 'natsumi', 'reply', 'event-1', null, null), /constraint/i);
  assert.equal(tables(db).includes('conversation_operations'), false);
}));

/**
 * Schema 8 moves the handoff out of SQLite (ADR 0020). The rows written before it exist in production, and they
 * were made when there was no `handoff.md` at all, so the rebuild has to carry them over without inventing a commit
 * for them and without a CHECK that would refuse them.
 */
test('schema 8 keeps the switches made under schema 7 and leaves their handoff commit empty', () => withDb(db => {
  const upTo = (version: number) => MIGRATIONS.filter(migration => migration.version <= version);
  migrate(db, upTo(7));
  db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
    .run('conversation-1', 'session-new', 'new.jsonl', '2026-03-01T00:00:00.000Z');
  const rotations: [string, string, string][] = [
    ['rotation-old', '古い引き継ぎ', '2026-03-01T13:00:00.000Z'],
    ['rotation-newest', 'あしたの自分へ', '2026-03-02T13:00:00.000Z'],
  ];
  for (const [rotationId, handoff, at] of rotations) {
    db.prepare(`INSERT INTO loop_events (event_id, kind, state, created_at, updated_at)
      VALUES (?, 'nightly-review', 'no-reply', ?, ?)`).run(`event-${rotationId}`, at, at);
    db.prepare(`INSERT INTO session_rotations (rotation_id, event_id, conversation_id, from_session_id, from_session_file,
      state, handoff, to_session_id, to_session_file, created_at, updated_at)
      VALUES (?, ?, 'conversation-1', ?, ?, 'switched', ?, ?, ?, ?, ?)`)
      .run(rotationId, `event-${rotationId}`, `from-${rotationId}`, `from-${rotationId}.jsonl`, handoff,
        `to-${rotationId}`, `to-${rotationId}.jsonl`, at, at);
  }

  assert.deepEqual(migrate(db, upTo(8)).applied, [8]);

  const columns = (db.prepare('PRAGMA table_info(session_rotations)').all() as { name: string }[]).map(column => column.name);
  assert.equal(columns.includes('handoff'), false);
  assert.ok(columns.includes('handoff_commit'));
  assert.deepEqual(plainRows(db.prepare(`SELECT rotation_id, state, handoff_commit, to_session_id, to_session_file
    FROM session_rotations ORDER BY rotation_id`).all()), [
    { rotation_id: 'rotation-newest', state: 'switched', handoff_commit: null, to_session_id: 'to-rotation-newest', to_session_file: 'to-rotation-newest.jsonl' },
    { rotation_id: 'rotation-old', state: 'switched', handoff_commit: null, to_session_id: 'to-rotation-old', to_session_file: 'to-rotation-old.jsonl' },
  ]);
  // The newest handoff SQLite held is carried over, so the first start after the upgrade can write it into handoff.md.
  assert.equal((db.prepare('SELECT handoff FROM handoff_carryover').get() as { handoff: string } | undefined)?.handoff,
    'あしたの自分へ');
  // The other CHECK still holds: a completed switch names the session it went to.
  assert.throws(() => db.prepare(`INSERT INTO session_rotations (rotation_id, event_id, conversation_id, from_session_id,
    from_session_file, state, created_at, updated_at)
    VALUES ('rotation-bad', 'event-rotation-old', 'conversation-1', 'f', 'f.jsonl', 'switched', 'x', 'x')`).run(), /constraint/i);
}));

test('a fresh database carries no handoff over from SQLite', () => withDb(db => {
  migrate(db, MIGRATIONS);
  assert.equal(db.prepare('SELECT count(*) AS n FROM handoff_carryover').get()?.n, 0);
}));

/**
 * Schema 9 gives each of natsumi's lines the feeling she chose for it (ADR 0026). The lines already written had
 * none, and none is invented for them: they stay NULL, which reads as "not known", not as neutral.
 */
test('schema 9 adds the line expression and leaves every earlier row without one', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 8));
  const insert = db.prepare(`INSERT INTO conversation_messages
    (message_id, position, role, kind, text, event_id, request_id, device_id, created_at) VALUES (?, ?, ?, ?, 'x', ?, ?, ?, 'x')`);
  insert.run('message-1', 1, 'owner', 'message', 'event-1', 'request-1', 'device-1');
  insert.run('message-2', 2, 'natsumi', 'reply', 'event-1', null, null);
  insert.run('message-3', 3, 'natsumi', 'notice', null, null, null);

  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 9)).applied, [9]);

  assert.deepEqual(plainRows(db.prepare('SELECT message_id, expression FROM conversation_messages ORDER BY position').all()), [
    { message_id: 'message-1', expression: null },
    { message_id: 'message-2', expression: null },
    { message_id: 'message-3', expression: null },
  ]);
  const withExpression = db.prepare(`INSERT INTO conversation_messages
    (message_id, position, role, kind, text, event_id, request_id, device_id, expression, created_at)
    VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, 'x')`);
  withExpression.run('message-4', 4, 'natsumi', 'notice', null, null, null, 'happy');
  // Only her lines carry one: an owner message never does.
  assert.throws(() => withExpression.run('message-5', 5, 'owner', 'message', 'event-5', 'request-5', 'device-1', 'happy'),
    /constraint/i);
  withExpression.run('message-6', 6, 'owner', 'message', 'event-6', 'request-6', 'device-1', null);
}));

/**
 * Schema 10 adds where to push a device that is away (ADR 0029). The devices already registered stay as they were and
 * have no registration until they send push.register.
 */
test('schema 10 adds one push registration per device, one device per token, and keeps the devices', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 9));
  db.prepare(`INSERT INTO devices (device_id, github_user_id, client_session_id, created_at, last_seen_at) VALUES (?, 1, 's', 'x', 'x')`)
    .run('device-1');
  db.prepare(`INSERT INTO devices (device_id, github_user_id, client_session_id, created_at, last_seen_at) VALUES (?, 1, 's', 'x', 'x')`)
    .run('device-2');

  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 10)).applied, [10]);

  assert.deepEqual(plainRows(db.prepare('SELECT device_id FROM devices ORDER BY device_id').all()), [{ device_id: 'device-1' }, { device_id: 'device-2' }]);
  assert.deepEqual(plainRows(db.prepare('SELECT * FROM push_registrations').all()), []);
  const insert = db.prepare(`INSERT INTO push_registrations (device_id, token, public_key, environment, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'x', 'x')`);
  const key = new Uint8Array(65).fill(4);
  insert.run('device-1', 'aa', key, 'sandbox');
  assert.throws(() => insert.run('device-1', 'bb', key, 'sandbox'), /constraint/i, 'one per device');
  assert.throws(() => insert.run('device-2', 'aa', key, 'sandbox'), /constraint/i, 'one device per token');
  assert.throws(() => insert.run('device-2', 'bb', key, 'development'), /constraint/i);
  assert.throws(() => insert.run('device-2', 'bb', new Uint8Array(33), 'sandbox'), /constraint/i);
  assert.throws(() => insert.run('device-missing', 'cc', key, 'sandbox'), /constraint/i);
}));

/**
 * A migration that rebuilds a table other tables point at runs with foreign keys off, as SQLite's own procedure for
 * changing a table says, and is still refused if it leaves a reference dangling. Either way foreign keys are back on.
 */
test('a migration run with foreign keys off is checked before it commits, and foreign keys are on again after', () => withDb(db => {
  const parent: Migration = { version: 1, name: 'parent', sql: `
    CREATE TABLE p (id TEXT PRIMARY KEY, n INTEGER CHECK (n > 0)) STRICT;
    CREATE TABLE c (id TEXT PRIMARY KEY, p_id TEXT REFERENCES p (id)) STRICT;
    INSERT INTO p VALUES ('p1', 1); INSERT INTO c VALUES ('c1', 'p1');` };
  migrate(db, [parent]);
  const dangling: Migration = { version: 2, name: 'dangling', foreignKeysOff: true, sql: `
    CREATE TABLE p_new (id TEXT PRIMARY KEY, n INTEGER) STRICT;
    DROP TABLE p;
    ALTER TABLE p_new RENAME TO p;` };
  assert.throws(() => migrate(db, [parent, dangling]),
    (error: unknown) => error instanceof MigrationError && error.version === 2 && /foreign key/.test(error.message));
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  assert.deepEqual(plainRows(db.prepare('SELECT * FROM p').all()), [{ id: 'p1', n: 1 }]);

  const rebuild: Migration = { version: 2, name: 'rebuild', foreignKeysOff: true, sql: `
    CREATE TABLE p_new (id TEXT PRIMARY KEY, n INTEGER) STRICT;
    INSERT INTO p_new SELECT id, n FROM p;
    DROP TABLE p;
    ALTER TABLE p_new RENAME TO p;` };
  assert.deepEqual(migrate(db, [parent, rebuild]).applied, [2]);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  db.prepare('INSERT INTO p VALUES (?, ?)').run('p2', -1);
  assert.throws(() => db.prepare('INSERT INTO c VALUES (?, ?)').run('c2', 'missing'), /constraint/i);
}));

/**
 * Schema 11 lets natsumi talk without an owner message to answer (ADR 0032). A reply that answers waiting messages
 * still names the newest of them, at most one such reply per event; a reply that answers none names no event. The
 * table is rebuilt to lose the CHECK that required one, and every row and every reference to it is kept.
 */
test('schema 11 keeps the conversation and its references, and lets a reply name no event', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 10));
  const insert = db.prepare(`INSERT INTO conversation_messages
    (message_id, position, role, kind, text, event_id, request_id, device_id, expression, created_at)
    VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, 'x')`);
  insert.run('message-1', 1, 'owner', 'message', 'event-1', 'request-1', 'device-1', null);
  insert.run('message-2', 2, 'natsumi', 'reply', 'event-1', null, null, 'happy');
  insert.run('message-3', 3, 'natsumi', 'notice', null, null, null, null);
  db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
    VALUES ('event-1', 'mac-message', 'message-1', 'replied', 'x', 'x')`).run();
  db.prepare(`INSERT INTO read_cursor (owner, message_id, device_id, updated_at) VALUES (1, 'message-2', NULL, 'x')`).run();
  db.prepare(`INSERT INTO notice_acknowledgements (message_id, device_id, acknowledged_at) VALUES ('message-3', NULL, 'x')`).run();
  // Before: a reply has to name the event it answers.
  assert.throws(() => insert.run('message-9', 9, 'natsumi', 'reply', null, null, null, null), /constraint/i);

  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 11)).applied, [11]);

  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  assert.deepEqual(plainRows(db.prepare('PRAGMA foreign_key_check').all()), []);
  assert.deepEqual(plainRows(db.prepare(`SELECT message_id, position, role, kind, event_id, request_id, expression
    FROM conversation_messages ORDER BY position`).all()), [
    { message_id: 'message-1', position: 1, role: 'owner', kind: 'message', event_id: 'event-1', request_id: 'request-1', expression: null },
    { message_id: 'message-2', position: 2, role: 'natsumi', kind: 'reply', event_id: 'event-1', request_id: null, expression: 'happy' },
    { message_id: 'message-3', position: 3, role: 'natsumi', kind: 'notice', event_id: null, request_id: null, expression: null },
  ]);
  // A reply that answers no waiting message names no event, as many times as she speaks.
  insert.run('message-4', 4, 'natsumi', 'reply', null, null, null, 'neutral');
  insert.run('message-5', 5, 'natsumi', 'reply', null, null, null, 'neutral');
  // The reply that answers a message is still one per event.
  assert.throws(() => insert.run('message-6', 6, 'natsumi', 'reply', 'event-1', null, null, null), /constraint/i);
  // What held before still holds.
  assert.throws(() => insert.run('message-7', 4, 'natsumi', 'notice', null, null, null, null), /constraint/i, 'position is unique');
  assert.throws(() => insert.run('message-8', 8, 'owner', 'message', 'event-8', 'request-1', 'device-1', null), /constraint/i);
  assert.throws(() => insert.run('message-10', 10, 'owner', 'message', 'event-10', 'request-10', 'device-1', 'happy'), /constraint/i);
  assert.throws(() => insert.run('message-11', 11, 'natsumi', 'message', 'event-11', 'request-11', 'device-1', null), /constraint/i);
  // And the tables that point at the conversation still point at it.
  assert.throws(() => db.prepare(`UPDATE read_cursor SET message_id = 'message-missing'`).run(), /constraint/i);
  assert.throws(() => db.prepare(`INSERT INTO notice_acknowledgements (message_id, acknowledged_at) VALUES ('message-missing', 'x')`).run(),
    /constraint/i);
  assert.throws(() => db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
    VALUES ('event-x', 'mac-message', 'message-missing', 'queued', 'x', 'x')`).run(), /constraint/i);
}));

test('schema 12 adds the outside agents\' exchanges beside what was there, and holds an answer only to its event', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 11));
  db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
    VALUES ('event-1', 'ping', NULL, 'no-reply', 'x', 'x')`).run();
  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 12)).applied, [12]);
  assert.deepEqual(plainRows(db.prepare('SELECT event_id, state FROM loop_events').all()), [{ event_id: 'event-1', state: 'no-reply' }]);

  const task = db.prepare(`INSERT INTO agent_tasks (agent, task_id, context_id, state, sent_at, created_at, updated_at)
    VALUES ('wiki', ?, 'context-1', ?, 'x', 'x', 'x')`);
  task.run('task-1', 'waiting');
  // One row per task of an agent, and only the states the server writes.
  assert.throws(() => task.run('task-1', 'waiting'), /constraint/i);
  assert.throws(() => task.run('task-2', 'working'), /constraint/i);
  const reply = db.prepare(`INSERT INTO agent_replies (event_id, agent, status, text, created_at) VALUES (?, 'wiki', ?, '', 'x')`);
  reply.run('event-1', 'completed');
  // An answer belongs to one event that exists.
  assert.throws(() => reply.run('event-missing', 'completed'), /constraint/i);
  assert.throws(() => reply.run('event-1', 'failed'), /constraint/i);
  db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
    VALUES ('event-2', 'agent-reply', NULL, 'queued', 'x', 'x')`).run();
  assert.throws(() => reply.run('event-2', 'input_required'), /constraint/i);
  // One latest exchange per agent.
  const context = db.prepare(`INSERT INTO agent_contexts (agent, context_id, task_id, updated_at) VALUES ('wiki', ?, NULL, 'x')`);
  context.run('context-1');
  assert.throws(() => context.run('context-2'), /constraint/i);
}));

test('schema 13 adds Slack beside what was there, and one mention makes at most one event', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 12));
  db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
    VALUES ('event-1', 'slack-mention', NULL, 'queued', 'x', 'x'), ('event-2', 'slack-mention', NULL, 'queued', 'x', 'x')`).run();
  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 13)).applied, [13]);
  db.prepare(`INSERT INTO slack_channels (workspace, channel_id, directory, label, is_im, created_at)
    VALUES ('work', 'C1', 'dev', '#dev', 0, 'x')`).run();
  assert.throws(() => db.prepare(`INSERT INTO slack_channels (workspace, channel_id, directory, label, is_im, created_at)
    VALUES ('work', 'C2', 'dev', '#dev', 0, 'x')`).run(), /constraint/i, 'two channels never share a directory');
  db.prepare(`INSERT INTO slack_mentions (event_id, workspace, channel_id, ts) VALUES ('event-1', 'work', 'C1', '1.1')`).run();
  assert.throws(() => db.prepare(`INSERT INTO slack_mentions (event_id, workspace, channel_id, ts) VALUES ('event-2', 'work', 'C1', '1.1')`).run(),
    /constraint/i);
  assert.throws(() => db.prepare(`INSERT INTO slack_mentions (event_id, workspace, channel_id, ts) VALUES ('event-missing', 'work', 'C1', '2.2')`).run(),
    /constraint/i);
}));

test('schema 14 adds the dove and the approvals, and an approval belongs to one post and closes once', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 13));
  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 14)).applied, [14]);
  const post = db.prepare(`INSERT INTO dove_posts (post_id, kind, workspace, channel_id, target_ts, target_thread_ts, reference, text,
    expression, state, created_at, updated_at) VALUES (?, 'post', 'work', 'C1', NULL, NULL, 'work/#dev', '下書き', NULL, ?, 'x', 'x')`);
  post.run('post-1', 'judging');
  assert.throws(() => post.run('post-2', 'thinking'), /constraint/i, 'only the states the server writes');
  const approval = db.prepare(`INSERT INTO approvals (approval_id, revision, kind, post_id, payload, state, created_at, expires_at)
    VALUES (?, 1, 'slack-post', ?, '{}', 'pending', 'x', 'x')`);
  approval.run('approval-1', 'post-1');
  assert.throws(() => approval.run('approval-2', 'post-1'), /constraint/i, 'one approval per post');
  assert.throws(() => approval.run('approval-3', 'post-missing'), /constraint/i);
  assert.throws(() => db.prepare(`INSERT INTO dove_replies (event_id, post_id, result, text, created_at)
    VALUES ('event-missing', 'post-1', 'sent', '', 'x')`).run(), /constraint/i, 'an answer belongs to an event that exists');
}));

test('schema 15 adds the reactions on Slack messages, one per person, name and message', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 14));
  db.prepare(`INSERT INTO slack_channels (workspace, channel_id, directory, label, is_im, created_at)
    VALUES ('work', 'C1', 'dev', '#dev', 0, 'x')`).run();
  db.prepare(`INSERT INTO slack_messages (workspace, channel_id, ts, thread_ts, speaker, own, text, files, edited, deleted, file_date, counted,
    created_at, updated_at) VALUES ('work', 'C1', '1.1', NULL, '山田', 0, 'x', '[]', 0, 0, '2026-09-25', 0, 'x', 'x')`).run();
  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 15)).applied, [15]);
  const reaction = db.prepare(`INSERT INTO slack_reactions (workspace, channel_id, ts, name, position, user_id, reactor, others, counted, created_at)
    VALUES ('work', 'C1', ?, '+1', 0, ?, '佐藤', ?, 0, 'x')`);
  reaction.run('1.1', 'U2', 0);
  assert.throws(() => reaction.run('1.1', 'U2', 0), /constraint/i, 'one per person, name and message');
  assert.throws(() => reaction.run('9.9', 'U2', 0), /constraint/i, 'only on a message recorded');
  assert.throws(() => reaction.run('1.1', '', -1), /constraint/i);
}));

test('schema 16 adds the images the server took, and the images of a post, each once in its place', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 15));
  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 16)).applied, [16]);
  db.prepare(`INSERT INTO dove_posts (post_id, kind, workspace, channel_id, target_ts, target_thread_ts, reference, text,
    expression, state, created_at, updated_at) VALUES ('post-1', 'post', 'work', 'C1', NULL, NULL, 'work/#dev', '', NULL, 'judging', 'x', 'x')`).run();
  const image = db.prepare(`INSERT INTO images (image_id, source, file, mime_type, bytes, sha256, created_at)
    VALUES (?, '/work/cat.png', ?, ?, 10, 'ab', 'x')`);
  image.run('image-1', 'image-1.png', 'image/png');
  image.run('image-2', 'image-2.webp', 'image/webp');
  assert.throws(() => image.run('image-3', 'image-3.gif', 'image/gif'), /constraint/i, 'only the types taken');
  const link = db.prepare('INSERT INTO dove_post_images (post_id, position, image_id) VALUES (?, ?, ?)');
  link.run('post-1', 0, 'image-1');
  assert.throws(() => link.run('post-1', 0, 'image-2'), /constraint/i, 'one image in each place');
  assert.throws(() => link.run('post-missing', 1, 'image-2'), /constraint/i);
  assert.throws(() => link.run('post-1', 1, 'image-missing'), /constraint/i);
}));

test('schema 17 gives the images a size when it is known, and a reply its images, each once in its place', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 16));
  db.prepare(`INSERT INTO images (image_id, source, file, mime_type, bytes, sha256, created_at)
    VALUES ('image-old', '/work/old.png', 'image-old.png', 'image/png', 10, 'ab', 'x')`).run();
  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 17)).applied, [17]);
  assert.deepEqual({ ...db.prepare("SELECT width, height FROM images WHERE image_id = 'image-old'").get() as object },
    { width: null, height: null }, 'an image taken before has no size');
  db.prepare(`INSERT INTO images (image_id, source, file, mime_type, bytes, sha256, width, height, created_at)
    VALUES ('image-new', '/work/new.png', 'image-new.png', 'image/png', 10, 'ab', 896, 1152, 'x')`).run();
  db.prepare(`INSERT INTO conversation_messages (message_id, position, role, kind, text, created_at)
    VALUES ('message-1', 1, 'natsumi', 'reply', '描きました', 'x')`).run();
  const link = db.prepare('INSERT INTO conversation_message_images (message_id, position, image_id) VALUES (?, ?, ?)');
  link.run('message-1', 0, 'image-new');
  link.run('message-1', 1, 'image-old');
  assert.throws(() => link.run('message-1', 1, 'image-new'), /constraint/i, 'one image in each place');
  assert.throws(() => link.run('message-missing', 2, 'image-new'), /constraint/i);
  assert.throws(() => link.run('message-1', 2, 'image-missing'), /constraint/i);
}));

test('schema 18 keeps one row of numbers per turn, folded or not, with no room for words', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 17));
  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 18)).applied, [18]);
  const insert = db.prepare(`INSERT INTO turn_stats (turn_id, started_at, fold, route, event_kinds, outcome, first_out_ms, turn_ms,
    model_calls, input_tokens, cache_read_tokens, output_tokens, context_tokens, reflection_ms, reflection_input_tokens,
    reflection_cache_read_tokens, reflection_output_tokens, compacted, repeated_calls, tool_errors, dove_refusals, unanswered_messages)
    VALUES (?, 'x', ?, 'local', 'mac_message', 'ok', NULL, 10, 1, 1, 1, 1, NULL, NULL, NULL, NULL, NULL, ?, 0, 0, 0, 0)`);
  insert.run('turn-1', 'on', 0);
  insert.run('turn-2', 'off', 1);
  assert.throws(() => insert.run('turn-3', 'maybe', 0), /constraint/i, 'folded or not');
  assert.throws(() => insert.run('turn-4', 'on', 2), /constraint/i);
  const columns = (db.prepare('PRAGMA table_info(turn_stats)').all() as { name: string }[]).map(column => column.name);
  for (const name of columns) assert.doesNotMatch(name, /(^|_)(text|memo|message|body|reply)(_|$)/, name);
}));

test('schema 19 gives an agent reply what it says of the images the agent handed back, empty for the replies before', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 18));
  db.prepare(`INSERT INTO loop_events (event_id, kind, state, created_at, updated_at) VALUES ('event-1', 'agent-reply', 'queued', 'x', 'x')`).run();
  db.prepare(`INSERT INTO agent_replies (event_id, agent, status, text, created_at) VALUES ('event-1', 'wiki', 'completed', '答え', 'x')`).run();
  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 19)).applied, [19]);
  assert.deepEqual({ ...db.prepare("SELECT files FROM agent_replies WHERE event_id = 'event-1'").get() as object }, { files: '' });
}));

test('schema 20 tells a turn where it is in the session record and what kind it was, and still has no room for words', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 19));
  const before = `INSERT INTO turn_stats (turn_id, started_at, fold, route, event_kinds, outcome, first_out_ms, turn_ms,
    model_calls, input_tokens, cache_read_tokens, output_tokens, context_tokens, reflection_ms, reflection_input_tokens,
    reflection_cache_read_tokens, reflection_output_tokens, compacted, repeated_calls, tool_errors, dove_refusals, unanswered_messages)
    VALUES (?, 'x', 'off', 'local', 'mac_message', 'ok', NULL, 10, 1, 1, 1, 1, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0)`;
  db.prepare(before).run('turn-old');
  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 20)).applied, [20]);
  // The turns recorded before are ordinary ones, with no place: the dashboard estimates it (ADR 0049).
  assert.deepEqual({ ...db.prepare(`SELECT kind, session_file, first_entry_id, last_entry_id, start_offset, end_offset, event_ids
    FROM turn_stats WHERE turn_id = 'turn-old'`).get() as object },
  { kind: 'events', session_file: null, first_entry_id: null, last_entry_id: null, start_offset: null, end_offset: null, event_ids: null });
  const insert = db.prepare(`INSERT INTO turn_stats (turn_id, started_at, fold, route, event_kinds, outcome, turn_ms, model_calls,
    input_tokens, cache_read_tokens, output_tokens, compacted, repeated_calls, tool_errors, dove_refusals, unanswered_messages,
    kind, session_file, first_entry_id, last_entry_id, start_offset, end_offset, event_ids)
    VALUES (?, 'x', 'off', 'local', 'nightly_review', 'ok', 10, 1, 1, 1, 1, 0, 0, 0, 0, 0, ?, 'a.jsonl', 'aaaa0001', 'aaaa0009', ?, ?, '["event-1"]')`);
  insert.run('turn-review', 'review', 100, 900);
  assert.throws(() => insert.run('turn-2', 'chat', 100, 900), /constraint/i, 'an ordinary turn or the nightly review');
  assert.throws(() => insert.run('turn-3', 'events', -1, 900), /constraint/i);
  assert.throws(() => insert.run('turn-4', 'events', 900, 100), /constraint/i, 'the end is not before the start');
  const columns = (db.prepare('PRAGMA table_info(turn_stats)').all() as { name: string }[]).map(column => column.name);
  for (const name of columns) assert.doesNotMatch(name, /(^|_)(text|memo|message|body|reply)(_|$)/, name);
}));

test('schema 22 lets a turn be the memory curator\'s, keeps every turn before, and keeps when each file was last curated', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 21));
  const insert = (version: number) => db.prepare(`INSERT INTO turn_stats (turn_id, started_at, fold, route, event_kinds, outcome, turn_ms,
    model_calls, input_tokens, cache_read_tokens, output_tokens, compacted, repeated_calls, tool_errors, dove_refusals, unanswered_messages,
    kind, session_file, first_entry_id, last_entry_id, start_offset, end_offset, event_ids)
    VALUES (?, ?, 'off', 'local', ?, 'ok', 10, 1, 1, 1, 1, 0, 0, 0, 0, 0, ?, ${version >= 22 ? "'curator/a.jsonl'" : "'a.jsonl'"}, 'e1', 'e2', 0, 10, '[]')`);
  insert(21).run('turn-review', '2026-09-26T19:00:00.000Z', 'nightly_review', 'review');
  assert.throws(() => insert(21).run('turn-curator', 'x', 'memory_curator', 'curator'), /constraint/i);
  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 22)).applied, [22]);
  // What was there before is there after, column for column.
  assert.deepEqual({ ...db.prepare("SELECT kind, event_kinds, session_file, start_offset, end_offset FROM turn_stats WHERE turn_id = 'turn-review'").get() as object },
    { kind: 'review', event_kinds: 'nightly_review', session_file: 'a.jsonl', start_offset: 0, end_offset: 10 });
  insert(22).run('turn-curator', '2026-09-26T19:10:00.000Z', 'memory_curator', 'curator');
  assert.throws(() => insert(22).run('turn-chat', 'x', 'mac_message', 'chat'), /constraint/i, 'an ordinary turn, the review or the curator');
  assert.throws(() => db.prepare(`INSERT INTO turn_stats (turn_id, started_at, fold, route, event_kinds, outcome, turn_ms, model_calls,
    input_tokens, cache_read_tokens, output_tokens, compacted, repeated_calls, tool_errors, dove_refusals, unanswered_messages)
    VALUES ('turn-bad', 'x', 'sideways', 'local', 'x', 'ok', 10, 1, 1, 1, 1, 0, 0, 0, 0, 0)`).run(), /constraint/i, 'the other checks stay');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'turn_stats_started'").get());
  const columns = (db.prepare('PRAGMA table_info(turn_stats)').all() as { name: string }[]).map(column => column.name);
  for (const name of columns) assert.doesNotMatch(name, /(^|_)(text|memo|message|body|reply)(_|$)/, name);

  // One row per file, and one row for the curator itself: where it last succeeded and whether it is running now.
  db.prepare("INSERT INTO memory_curation (path, curated_at) VALUES ('暮らし/予定.md', '2026-09-26T19:10:00.000Z')").run();
  assert.throws(() => db.prepare("INSERT INTO memory_curation (path, curated_at) VALUES ('暮らし/予定.md', 'x')").run(), /constraint/i);
  db.prepare("INSERT INTO memory_curator (owner, base_commit, running_since) VALUES (1, 'abc', NULL)").run();
  assert.throws(() => db.prepare("INSERT INTO memory_curator (owner) VALUES (2)").run(), /constraint/i);
}));

test('schema 24 lets a post be placed as a broadcast, and renames the channel of before to what it meant (ADR 0062)', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 23));
  const post = db.prepare(`INSERT INTO dove_posts (post_id, kind, workspace, channel_id, target_ts, target_thread_ts, reference, text,
    state, placement, sent_placement, placement_probabilities, judgement_logprobs, judgement_jev, created_at, updated_at)
    VALUES (?, 'post', 'work', 'C1', ?, NULL, 'work/#dev', '下書き', 'sent', ?, ?, ?, ?, ?, 'x', 'x')`);
  const odds = (thread: number, channel: number) => JSON.stringify({ thread, channel });
  const judgement = (choice: string) => JSON.stringify({ verdict: 'send', issues: [], placement: { choice, probabilities: { thread: 0.1, channel: 0.9 } } });
  post.run('post-reply', '1.1', 'channel', 'channel', odds(0.1, 0.9), judgement('channel'), JSON.stringify({ error: 'timeout' }));
  post.run('post-images', '1.2', 'channel', 'channel', null, null, null);
  post.run('post-thread', '1.3', 'thread', 'thread', odds(0.8, 0.2), judgement('thread'), null);
  post.run('post-channel', null, 'channel', 'channel', null, null, null);
  assert.throws(() => post.run('post-broadcast', '1.4', 'broadcast', null, null, null, null), /constraint/i, 'two places before');
  db.prepare(`INSERT INTO images (image_id, source, file, mime_type, bytes, sha256, created_at)
    VALUES ('image-1', '/work/a.png', 'a.png', 'image/png', 1, 'x', 'x')`).run();
  db.prepare(`INSERT INTO dove_post_images (post_id, position, image_id) VALUES ('post-images', 0, 'image-1')`).run();
  const payload = (placement: string, replyTo: boolean, probabilities?: object) => JSON.stringify({ approvalId: 'a', revision: 1,
    target: { channel: 'work/#dev', placement, ...(replyTo ? { replyTo: { speaker: '山田', at: 'x', text: 'y' } } : {}) },
    text: '下書き', reason: { verdict: 'owner', issues: [], ...(probabilities ? { placement: { probabilities } } : {}) } });
  const approval = db.prepare(`INSERT INTO approvals (approval_id, revision, kind, post_id, payload, state, created_at, expires_at, decided_placement)
    VALUES (?, 1, 'slack-post', ?, ?, 'approved', 'x', 'x', ?)`);
  approval.run('approval-reply', 'post-reply', payload('channel', true, { thread: 0.1, channel: 0.9 }), 'channel');
  approval.run('approval-thread', 'post-thread', payload('thread', true, { thread: 0.8, channel: 0.2 }), 'thread');
  approval.run('approval-channel', 'post-channel', payload('channel', false), null);

  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 24)).applied, [24]);
  const posts = Object.fromEntries((db.prepare(`SELECT post_id, placement, sent_placement, placement_probabilities, judgement_logprobs,
    judgement_jev FROM dove_posts`).all() as Record<string, string | null>[]).map(row => [row.post_id, row]));
  const parsed = (text: string | null | undefined) => text ? JSON.parse(text) : text;
  // A reply placed in the channel went to its thread and was shown in the channel too: a broadcast.
  assert.deepEqual([posts['post-reply']!.placement, posts['post-reply']!.sent_placement], ['broadcast', 'broadcast']);
  assert.deepEqual(parsed(posts['post-reply']!.placement_probabilities), { thread: 0.1, broadcast: 0.9 });
  assert.deepEqual(parsed(posts['post-reply']!.judgement_logprobs).placement, { choice: 'broadcast', probabilities: { thread: 0.1, broadcast: 0.9 } });
  assert.deepEqual(parsed(posts['post-reply']!.judgement_jev), { error: 'timeout' });
  // Images placed in the channel went to the channel itself, where they were sent stays so.
  assert.deepEqual([posts['post-images']!.placement, posts['post-images']!.sent_placement], ['broadcast', 'channel']);
  assert.deepEqual([posts['post-thread']!.placement, posts['post-thread']!.sent_placement], ['thread', 'thread']);
  assert.deepEqual(parsed(posts['post-thread']!.placement_probabilities), { thread: 0.8, broadcast: 0.2 });
  assert.deepEqual(parsed(posts['post-thread']!.judgement_logprobs).placement, { choice: 'thread', probabilities: { thread: 0.1, broadcast: 0.9 } });
  // A post to the channel itself was always in the channel itself.
  assert.deepEqual([posts['post-channel']!.placement, posts['post-channel']!.sent_placement], ['channel', 'channel']);

  const approvals = Object.fromEntries((db.prepare('SELECT approval_id, payload, decided_placement FROM approvals').all() as
    { approval_id: string; payload: string; decided_placement: string | null }[]).map(row => [row.approval_id, row]));
  const reply = JSON.parse(approvals['approval-reply']!.payload);
  assert.equal(reply.target.placement, 'broadcast');
  assert.deepEqual(reply.reason.placement, { probabilities: { thread: 0.1, broadcast: 0.9 } });
  assert.equal(reply.text, '下書き', 'the rest of what was shown stays');
  assert.equal(approvals['approval-reply']!.decided_placement, 'broadcast');
  assert.equal(JSON.parse(approvals['approval-thread']!.payload).target.placement, 'thread');
  assert.deepEqual(JSON.parse(approvals['approval-thread']!.payload).reason.placement, { probabilities: { thread: 0.8, broadcast: 0.2 } });
  assert.equal(approvals['approval-thread']!.decided_placement, 'thread');
  assert.equal(JSON.parse(approvals['approval-channel']!.payload).target.placement, 'channel');

  post.run('post-broadcast', '1.4', 'broadcast', 'broadcast', null, null, null);
  assert.throws(() => post.run('post-elsewhere', '1.5', 'elsewhere', null, null, null, null), /constraint/i, 'the three places alone');
  assert.throws(() => db.prepare(`INSERT INTO dove_posts (post_id, kind, workspace, channel_id, reference, text, state, created_at, updated_at)
    VALUES ('post-bad', 'post', 'work', 'C1', 'work/#dev', 'x', 'thinking', 'x', 'x')`).run(), /constraint/i, 'the other checks stay');
  for (const index of ['dove_posts_by_target', 'dove_posts_by_state']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index), index);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => approval.run('approval-missing', 'post-missing', '{}', null), /constraint/i, 'the approvals still point at the posts');
}));

/**
 * Schema 25 lets a self-check repeat and drops the folding of the same reason (ADR 0063). The bookings waiting stay as
 * one-offs, and each delivered one keeps the event that carried it, now kept beside the booking so a repeating one can
 * be carried by many.
 */
test('schema 25 keeps every self-check as a one-off, keeps which event carried each, and allows the same reason twice', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 24));
  db.prepare(`INSERT INTO loop_events (event_id, kind, state, created_at, updated_at)
    VALUES ('event-check', 'self-check', 'no-reply', '2026-09-17T01:00:00.000Z', '2026-09-17T01:00:00.000Z')`).run();
  const check = db.prepare(`INSERT INTO self_checks (check_id, reason, reason_key, due_at, state, event_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')`);
  check.run('check-waiting', '会議の準備を聞く', '会議の準備を聞く', '2026-09-17T06:00:00.000Z', 'pending', null);
  check.run('check-done', '洗濯物を聞く', '洗濯物を聞く', '2026-09-17T01:00:00.000Z', 'delivered', 'event-check');
  check.run('check-gone', '取り消した', '取り消した', '2026-09-17T02:00:00.000Z', 'cancelled', null);

  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 25)).applied, [25]);
  assert.deepEqual(db.prepare('SELECT check_id, reason, cron, due_at, state FROM self_checks ORDER BY check_id').all()
    .map(row => ({ ...row })), [
    { check_id: 'check-done', reason: '洗濯物を聞く', cron: null, due_at: '2026-09-17T01:00:00.000Z', state: 'delivered' },
    { check_id: 'check-gone', reason: '取り消した', cron: null, due_at: '2026-09-17T02:00:00.000Z', state: 'cancelled' },
    { check_id: 'check-waiting', reason: '会議の準備を聞く', cron: null, due_at: '2026-09-17T06:00:00.000Z', state: 'pending' },
  ]);
  assert.deepEqual(db.prepare('SELECT event_id, check_id, due_at FROM self_check_deliveries').all().map(row => ({ ...row })),
    [{ event_id: 'event-check', check_id: 'check-done', due_at: '2026-09-17T01:00:00.000Z' }]);
  const columns = (db.prepare('PRAGMA table_info(self_checks)').all() as { name: string }[]).map(column => column.name);
  assert.equal(columns.includes('reason_key'), false);
  assert.equal(columns.includes('event_id'), false);

  const insert = db.prepare(`INSERT INTO self_checks (check_id, reason, cron, due_at, state, created_at, updated_at)
    VALUES (?, ?, ?, '2026-09-17T07:00:00.000Z', ?, 'x', 'x')`);
  insert.run('check-again', '会議の準備を聞く', null, 'pending');
  insert.run('check-repeating', '会議の準備を聞く', '0 16 * * *', 'pending');
  assert.throws(() => insert.run('check-repeating-done', '繰り返し', '0 16 * * *', 'delivered'), /constraint/i,
    'a repeating booking is never done by being delivered');
  assert.throws(() => insert.run('check-odd', '変な状態', null, 'waiting'), /constraint/i);
  assert.throws(() => db.prepare(`INSERT INTO self_check_deliveries (event_id, check_id, due_at) VALUES ('event-missing', 'check-again', 'x')`).run(),
    /constraint/i, 'a delivery names an event');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}));

/** Schema 26 gives an attention the source's own fields (ADR 0069); one recorded before has none, and no jq path is needed. */
test('schema 26 keeps the attentions waiting, each with no fields of its own', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 25));
  db.prepare(`INSERT INTO source_attention (source, kind, dir, file, path, images, created_at)
    VALUES ('slack', 'dm', 'slack/work/dm', '/sources/slack/work/dm/a.jsonl', '.[0]', '[]', 'x')`).run();
  assert.deepEqual(migrate(db, MIGRATIONS.filter(migration => migration.version <= 26)).applied, [26]);
  assert.deepEqual(plainRows(db.prepare('SELECT path, details FROM source_attention').all()), [{ path: '.[0]', details: '{}' }]);
}));

/** Schema 26 also keeps where each request to an outside agent is put and what it said; a task from before has neither. */
test('schema 26 gives the agents\' tasks and exchanges the place of their request, empty for those from before', () => withDb(db => {
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 25));
  db.prepare(`INSERT INTO agent_tasks (agent, task_id, context_id, state, sent_at, created_at, updated_at)
    VALUES ('wiki', 't1', 'c1', 'waiting', 'x', 'x', 'x')`).run();
  db.prepare(`INSERT INTO agent_contexts (agent, context_id, task_id, updated_at) VALUES ('wiki', 'c1', 't1', 'x')`).run();
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 26));
  assert.deepEqual(plainRows(db.prepare('SELECT place, request FROM agent_tasks').all()), [{ place: null, request: null }]);
  assert.deepEqual(plainRows(db.prepare('SELECT place FROM agent_contexts').all()), [{ place: null }]);
}));
