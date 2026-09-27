import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { MIGRATIONS } from '../../src/server/migrations.ts';
import { migrate } from '../../src/server/state-db.ts';
import { SessionRecord } from './session-record.ts';

/** The stamps of the daily copies of SQLite a fake backup holds, oldest first. */
export const BACKUP_STAMPS = ['20260926T203000Z', '20260927T053000Z'];
export const SESSION_FILE = '2026-09-27T04-00-00-000Z_fixture-session.jsonl';

/**
 * A made-up backup as the backup job leaves it on its NFS (ADR 0052): the volume's mirror under `mirror/` and the
 * daily copies of SQLite under `sqlite/`. It holds what an allow list must take (memory, sources, work, images,
 * sessions) beside what it must never take (a login, a home directory, keys, the agent list). Every person, text and
 * secret in it is invented; the "secrets" are shaped like real ones so that a scan would see them.
 */
export async function makeFakeBackup(root: string): Promise<void> {
  const mirror = join(root, 'mirror');
  const files: Record<string, string> = {
    'data/memory/personality.md': '# 性格・話し方\nFIXTURE-SNAPSHOT-PERSONALITY\n',
    'data/memory/plans/2026-09.md': '- 9/28（日）10:00 架空の打ち合わせ\n',
    'data/memory/.git/HEAD': 'ref: refs/heads/main\n',
    'data/sources/slack/fixture/2026-09-27.md': '# #fixture\n- 10:00 架空の人: FIXTURE-SOURCE-LINE\n',
    'data/work/draft.md': 'FIXTURE-WORK-NOTE\n',
    'data/.natsumi/images/fixture.png': 'not really a png\n',
    // Never to be taken.
    'data/home/.ssh/id_ed25519': '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n',
    'data/.natsumi/acme/account.pem': '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n',
    'data/.natsumi/model-route.json': '{"route":"fixture"}\n',
    'data/agents/INDEX.md': '# 頼める相手\n',
    'pi/agent/auth.json': '{"openai-codex":{"type":"oauth","access":"fixture-access-token"}}\n',
    'secrets/slack-bot-token': `xoxb-${'0'.repeat(12)}-${'0'.repeat(12)}-fixturefixturefixture\n`,
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(mirror, path, '..'), { recursive: true });
    await writeFile(join(mirror, path), text);
  }
  const session = new SessionRecord('fixture-session', '2026-09-27T04:00:00.000Z');
  session.events('2026-09-27T04:10:00.000Z', [{ type: 'mac_message', received_at: '2026-09-27T04:10:00.000Z', text: 'FIXTURE-SNAPSHOT-EARLIER' }]);
  session.assistant('2026-09-27T04:10:05.000Z', [{ type: 'text', text: 'うん' }]);
  await mkdir(join(mirror, 'pi', 'sessions'), { recursive: true });
  await writeFile(join(mirror, 'pi', 'sessions', SESSION_FILE), session.text());
  await writeFile(join(mirror, 'pi', 'sessions', '2026-09-26T04-00-00-000Z_older.jsonl'), new SessionRecord('older-session').text());

  await mkdir(join(root, 'sqlite'), { recursive: true });
  for (const stamp of BACKUP_STAMPS) {
    const db = new DatabaseSync(join(root, 'sqlite', `state-${stamp}.sqlite`));
    try {
      migrate(db, MIGRATIONS);
      const at = '2026-09-27T04:00:00.000Z';
      db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
        .run('conversation-fixture', 'fixture-session', SESSION_FILE, at);
      db.prepare(`INSERT INTO client_sessions (session_id, token_hash, github_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run('client-fixture', 'fixture-token-hash', 1, at, '2026-12-31T00:00:00.000Z');
      db.prepare('INSERT INTO devices (device_id, github_user_id, client_session_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
        .run('device-fixture', 1, 'client-fixture', at, at);
      db.prepare(`INSERT INTO push_registrations (device_id, token, public_key, environment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('device-fixture', 'f'.repeat(64), new Uint8Array(65), 'sandbox', at, at);
      db.prepare(`INSERT INTO loop_events (event_id, kind, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run('event-left-queued', 'ping', 'queued', at, at);
      db.prepare(`INSERT INTO conversation_messages (message_id, position, role, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('message-fixture', 1, 'natsumi', 'reply', `FIXTURE-SQLITE-${stamp}`, at);
    } finally { db.close(); }
  }
}
