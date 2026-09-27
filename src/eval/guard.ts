import { access, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SECRET_TABLES, STATE_DATABASE } from './snapshot.ts';

/**
 * The third of the guarantees that a run on a snapshot acts on nothing outside (ADR 0052): before it starts, look for
 * anything shaped like a Slack, APNs or A2A token in the environment, in the places production keeps its secrets and
 * in the snapshots it will use, and refuse to start if there is one. What is found is named by its place only (a
 * variable's name, a file's path, a table), never by its value.
 */

/** Where production mounts its secrets; any of them being here means this is no place to evaluate in. */
export const SECRET_PLACES = ['/run/secrets/natsumi', '/run/secrets/natsumi-a2a', '/var/run/secrets/natsumi', '/var/run/secrets/natsumi-a2a'];

const NAMED = /SLACK|APNS|A2A/i;
const SHAPES = [
  /\bxox[abposre]-[A-Za-z0-9-]{10,}/, // Slack bot, user and legacy tokens
  /\bxapp-\d-[A-Za-z0-9-]{10,}/, // Slack app-level tokens (Socket Mode)
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, // APNs .p8 keys and any other private key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWTs: the A2A token is a projected ServiceAccount token
];
/** Compressed, so nothing is seen in them by shape. */
const SKIPPED = new Set(['objects']);

export interface SecretSearch {
  env: Record<string, string | undefined>;
  /** Places whose mere existence is a finding. */
  files: string[];
  /** Snapshot directories to scan through. */
  snapshots: string[];
}

export async function findSecrets(search: SecretSearch): Promise<string[]> {
  const found: string[] = [];
  for (const [name, value] of Object.entries(search.env)) {
    if (!value) continue;
    if (NAMED.test(name) || tokenShaped(value)) found.push(`環境変数 ${name}`);
  }
  for (const file of search.files) {
    try { await access(file); found.push(`ファイル ${file}`); } catch { /* not here */ }
  }
  for (const snapshot of search.snapshots) {
    for (const file of await walk(snapshot)) {
      const path = relative(snapshot, file);
      if (tokenShaped((await readFile(file)).toString('latin1'))) found.push(`写し ${snapshot} の ${path}`);
    }
    found.push(...secretRows(join(snapshot, STATE_DATABASE)).map(table => `写し ${snapshot} の ${STATE_DATABASE} の表 ${table}`));
  }
  return found;
}

/** Refuses to go on when anything is found, naming every place. */
export async function refuseOnSecrets(search: SecretSearch): Promise<void> {
  const found = await findSecrets(search);
  if (found.length > 0) {
    throw new Error(`秘密らしいものがあるので始めません（値は出しません）:\n${found.map(line => `  - ${line}`).join('\n')}`);
  }
}

function tokenShaped(text: string): boolean {
  return SHAPES.some(shape => shape.test(text));
}

/** The secret tables of a copy of SQLite that still have rows. */
function secretRows(file: string): string[] {
  let db: DatabaseSync;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { return []; }
  try {
    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(row => row.name));
    return SECRET_TABLES.filter(table => tables.has(table)
      && (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n > 0);
  } catch { return []; } finally { db.close(); }
}

async function walk(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (!(SKIPPED.has(entry.name) && directory.endsWith('.git'))) files.push(...await walk(path)); } else if (entry.isFile()) files.push(path);
  }
  return files;
}
