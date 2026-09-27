import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findSecrets } from '../src/eval/guard.ts';

// Shaped like the real ones so that the scan sees them; none of them is a real token.
const SLACK = `xoxb-${'1'.repeat(12)}-${'2'.repeat(12)}-fixturefixturefixture`;
const APP = `xapp-1-${'A'.repeat(11)}-${'3'.repeat(13)}-fixture`;
const JWT = `eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOlsiYTJhIl19.${'s'.repeat(40)}`;
const PEM = '-----BEGIN PRIVATE KEY-----\nMIGfixture\n-----END PRIVATE KEY-----\n';

async function withDirectory(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-guard-'));
  try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('a clean environment, no secret files and a clean snapshot are let through', async () => {
  await withDirectory(async root => {
    await mkdir(join(root, 'snapshot', 'data', 'memory'), { recursive: true });
    await writeFile(join(root, 'snapshot', 'data', 'memory', 'notes.md'), 'xoxo と書いた手紙の話。eyJ だけの文字列。\n');
    assert.deepEqual(await findSecrets({ env: { PATH: '/usr/bin', HOME: '/home/me' }, files: [join(root, 'absent')],
      snapshots: [join(root, 'snapshot')] }), []);
  });
});

test('a variable named for Slack, APNs or A2A, or holding something shaped like their tokens, is found by its name only', async () => {
  const found = await findSecrets({ env: { SLACK_BOT_TOKEN: 'anything', NATSUMI_APNS_KEY_FILE: '/x', A2A_TOKEN: 'y', INNOCENT: SLACK,
    ALSO: JWT, EMPTY_SLACK_HOOK: '' }, files: [], snapshots: [] });
  assert.deepEqual(found.sort(), ['環境変数 A2A_TOKEN', '環境変数 ALSO', '環境変数 INNOCENT', '環境変数 NATSUMI_APNS_KEY_FILE', '環境変数 SLACK_BOT_TOKEN']);
  assert.ok(!found.join('\n').includes('xoxb-') && !found.join('\n').includes('eyJ'), 'no value is ever shown');
});

test('the places production keeps its secrets are found when they exist here', async () => {
  await withDirectory(async root => {
    await mkdir(join(root, 'run-secrets-natsumi'));
    assert.deepEqual(await findSecrets({ env: {}, files: [join(root, 'run-secrets-natsumi'), join(root, 'absent')], snapshots: [] }),
      [`ファイル ${join(root, 'run-secrets-natsumi')}`]);
  });
});

test('a snapshot holding token-shaped text or a table with push tokens or login sessions is found, by place', async () => {
  await withDirectory(async root => {
    const snapshot = join(root, 'snapshot');
    const put = async (path: string, text: string) => {
      await mkdir(join(snapshot, path, '..'), { recursive: true });
      await writeFile(join(snapshot, path), text);
    };
    await put('data/memory/slack.md', `token: ${SLACK}\n`);
    await put('data/work/app.txt', APP);
    await put('data/sources/key.p8', PEM);
    await put('pi/sessions/s.jsonl', `{"text":"${JWT}"}\n`);
    await put('data/memory/.git/objects/ab/cdef', SLACK);
    await put('data/memory/clean.md', 'ふつうのメモ\n');
    await mkdir(join(snapshot, 'data', '.natsumi'), { recursive: true });
    const db = new DatabaseSync(join(snapshot, 'data', '.natsumi', 'state.sqlite'));
    db.exec(`CREATE TABLE push_registrations (token TEXT); INSERT INTO push_registrations VALUES ('${'f'.repeat(64)}');
      CREATE TABLE client_sessions (token_hash TEXT);`);
    db.close();
    const found = await findSecrets({ env: {}, files: [], snapshots: [snapshot] });
    assert.deepEqual(found.map(line => line.replace(snapshot, '<snapshot>')).sort(), [
      '写し <snapshot> の data/.natsumi/state.sqlite の表 push_registrations',
      '写し <snapshot> の data/memory/slack.md',
      '写し <snapshot> の data/sources/key.p8',
      '写し <snapshot> の data/work/app.txt',
      '写し <snapshot> の pi/sessions/s.jsonl',
    ]);
  });
});
