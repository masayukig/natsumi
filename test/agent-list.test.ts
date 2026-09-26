import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { A2ACallError, type A2AClient, type CardSummary } from '../src/server/a2a-client.ts';
import { AGENT_LIST_DIRECTORY, AGENT_LIST_FILE, MAX_CARD_DESCRIPTION_CHARS, writeAgentList } from '../src/server/agent-list.ts';
import { initializeDataDirectory } from '../src/server/data-directory.ts';
import { SHARED_DIRECTORY_MODE } from '../src/server/permissions.ts';
import type { A2AConfig } from '../src/server/config.ts';

const NOW = Date.parse('2026-09-24T03:00:00Z');

/** Cards by URL; a URL without one is an agent that cannot be reached. */
function cards(byUrl: Record<string, CardSummary>): A2AClient {
  return {
    send: () => { throw new Error('the list never sends'); },
    getTask: () => { throw new Error('the list never fetches a task'); },
    fetchFile: () => { throw new Error('the list never fetches a file'); },
    card: async url => {
      const card = byUrl[url];
      if (!card) throw new A2ACallError('unavailable', 'connect ECONNREFUSED');
      return card;
    },
  };
}

async function directory(t: test.TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'natsumi-agent-list-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const config = (agents: A2AConfig['agents']): A2AConfig =>
  ({ tokenFile: '/run/secrets/a2a-token', pollIntervalSeconds: 15, giveUpAfterHours: 24, agents });

// ADR 0036: the list is written from the same config the server checks names against, so the two never disagree.
test('each configured agent is listed under the name ask_agent takes, with what its card says', async t => {
  const dir = await directory(t);
  const client = cards({
    'https://agents.example.test/wiki-keeper/': {
      name: 'Wiki Keeper', description: '個人の Wiki を管理する。',
      skills: [{ name: '問い合わせ', description: 'Wiki の内容に答える', examples: ['ねこについて教えて'] },
        { name: '取り込み', description: '記事を Wiki に取り込んで PR を出す', examples: [] }],
    },
  });
  const outcome = await writeAgentList({ directory: dir, client, now: NOW, timeZone: 'Asia/Tokyo',
    config: config({ wiki: { url: 'https://agents.example.test/wiki-keeper/' }, search: { url: 'https://agents.example.test/search/' } }) });
  assert.deepEqual(outcome, { listed: ['wiki'], unreachable: ['search'] });
  const text = await readFile(join(dir, AGENT_LIST_FILE), 'utf8');
  assert.match(text, /^# 頼める相手/);
  assert.match(text, /2026-09-24 12:00/, 'when it was written, in the owner\'s time zone');
  assert.match(text, /^## wiki$/m);
  assert.match(text, /Wiki Keeper/);
  assert.match(text, /個人の Wiki を管理する。/);
  assert.match(text, /問い合わせ: Wiki の内容に答える/);
  assert.match(text, /ねこについて教えて/);
  assert.match(text, /取り込み: 記事を Wiki に取り込んで PR を出す/);
  // An agent whose card could not be fetched is still listed: she can ask it, only not knowing what it does.
  assert.match(text, /^## search$/m);
  assert.match(text, /今は取れない/);
  // The URL and the token are the server's: she deals in names only (ADR 0035).
  for (const hidden of ['https://', 'agents.example.test', '/run/secrets', 'a2a-token']) assert.equal(text.includes(hidden), false, hidden);
});

test('with no agent configured, the list says there is nobody to ask', async t => {
  for (const setting of [undefined, config({})]) {
    const dir = await directory(t);
    assert.deepEqual(await writeAgentList({ directory: dir, client: undefined, now: NOW, timeZone: 'UTC', config: setting }),
      { listed: [], unreachable: [] });
    assert.match(await readFile(join(dir, AGENT_LIST_FILE), 'utf8'), /頼める相手はいません/);
  }
});

// The card is text from outside: it is kept to a length and to one line a field, so it cannot restructure the page.
test('what a card says is cut to a length, kept to one line, and cleared of control characters', async t => {
  const dir = await directory(t);
  const client = cards({
    'https://agents.example.test/a/': {
      name: 'Name\n## wiki\nFake', description: `${'説'.repeat(MAX_CARD_DESCRIPTION_CHARS + 50)}`,
      skills: Array.from({ length: 40 }, (_, i) => ({ name: `skill${i}\u0007`, description: 'x\r\n# heading', examples: [] })),
    },
  });
  await writeAgentList({ directory: dir, client, now: NOW, timeZone: 'UTC', config: config({ a: { url: 'https://agents.example.test/a/' } }) });
  const text = await readFile(join(dir, AGENT_LIST_FILE), 'utf8');
  assert.equal(text.match(/^## /gm)?.length, 1, 'the card cannot add a heading of its own');
  assert.equal(text.match(/^# /gm)?.length, 1);
  assert.equal(text.includes('\u0007'), false);
  assert.ok(text.includes(`${'説'.repeat(MAX_CARD_DESCRIPTION_CHARS - 1)}…`));
  assert.ok(!text.includes('説'.repeat(MAX_CARD_DESCRIPTION_CHARS + 1)));
  assert.ok((text.match(/skill\d+/g) ?? []).length < 40, 'the skills are capped');
});

test('the list is written again from scratch on every start', async t => {
  const dir = await directory(t);
  const first = cards({ 'https://agents.example.test/a/': { name: 'Before', description: '', skills: [] } });
  await writeAgentList({ directory: dir, client: first, now: NOW, timeZone: 'UTC', config: config({ a: { url: 'https://agents.example.test/a/' } }) });
  const second = cards({ 'https://agents.example.test/a/': { name: 'After', description: '', skills: [] } });
  await writeAgentList({ directory: dir, client: second, now: NOW, timeZone: 'UTC', config: config({ a: { url: 'https://agents.example.test/a/' } }) });
  const text = await readFile(join(dir, AGENT_LIST_FILE), 'utf8');
  assert.match(text, /After/);
  assert.equal(text.includes('Before'), false);
});

// ADR 0033: the workspace may run as another UID in the shared group, and only reads the list.
test('the list is readable by the shared group and by nobody else, and takes the group of its shared directory', async t => {
  const root = await directory(t);
  await initializeDataDirectory(root);
  const dir = join(root, AGENT_LIST_DIRECTORY);
  assert.equal((await stat(dir)).mode & 0o7777, SHARED_DIRECTORY_MODE);
  await writeAgentList({ directory: dir, client: undefined, now: NOW, timeZone: 'UTC', config: undefined });
  const file = await stat(join(dir, AGENT_LIST_FILE));
  assert.equal(file.mode & 0o777, 0o640);
  assert.equal(file.gid, (await stat(dir)).gid);
});

// ADR 0040: with Slack configured, the dove is one of those she can ask, served by the server and needing no card.
test('with Slack the dove is listed first, pointing at the manual, and without it she is not', async t => {
  const dir = await directory(t);
  const outcome = await writeAgentList({ directory: dir, client: undefined, config: undefined, now: NOW, timeZone: 'Asia/Tokyo', dove: true });
  assert.deepEqual(outcome, { listed: ['poppo'], unreachable: [] });
  const text = await readFile(join(dir, AGENT_LIST_FILE), 'utf8');
  assert.match(text, /^## poppo$/m);
  assert.match(text, /ポッポさん/);
  assert.match(text, /\/manual\/slack\.md/);
  assert.doesNotMatch(text, /頼める相手はいません/);
  await writeAgentList({ directory: dir, client: undefined, config: undefined, now: NOW, timeZone: 'Asia/Tokyo' });
  assert.doesNotMatch(await readFile(join(dir, AGENT_LIST_FILE), 'utf8'), /poppo/);
});
