import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { AGENT_LIST_PATH } from '../src/server/agent-requests.ts';
import { AGENT_LIST_DIRECTORY, AGENT_LIST_FILE } from '../src/server/agent-list.ts';
import { ASK_AGENT_DESCRIPTION, WORKSPACE_SECTION } from '../src/server/prompts.ts';

const root = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFile(`${root}${path}`, 'utf8');
/** The part of the manual the server writes on every start, rather than the image holding it (ADR 0036). */
const LIST = `/manual/agents/${AGENT_LIST_FILE}`;

const mentioned = (text: string) => [...text.matchAll(/\/manual\/[\w./-]*[\w]/g)].map(match => match[0]);

// ADR 0036: what she is pointed at must be there. A renamed page would leave her reading nothing.
test('every page of the manual that the prompt, the tool and the manual itself name exists', async () => {
  const pages = await readdir(`${root}manual`);
  const texts = [WORKSPACE_SECTION, ASK_AGENT_DESCRIPTION, AGENT_LIST_PATH, ...await Promise.all(pages.map(page => read(`manual/${page}`)))];
  const named = new Set(texts.flatMap(mentioned));
  assert.ok(named.has('/manual/INDEX.md'));
  assert.ok(named.has(LIST));
  for (const path of named) {
    if (path === LIST) continue;
    assert.ok(pages.includes(path.replace('/manual/', '')), `${path} is named but not in manual/`);
  }
  assert.equal(AGENT_LIST_PATH, LIST);
  // Every page is reachable from the index.
  const index = await read('manual/INDEX.md');
  for (const page of pages.filter(page => page !== 'INDEX.md')) assert.ok(index.includes(`/manual/${page}`), page);
});

test('the manual speaks of the same statuses and the same argument as the tool', async () => {
  const page = await read('manual/ask-agent.md');
  for (const word of ['completed', 'failed', 'input_required', 'gave_up', 'continue: true', 'continue: false', 'agent_reply']) {
    assert.ok(page.includes(word), word);
  }
});

test('the workspace image holds the manual, and compose shows it the list of agents read-only', async () => {
  const dockerfile = await read('Dockerfile');
  const workspace = dockerfile.slice(dockerfile.indexOf('AS workspace\n'), dockerfile.indexOf('\nFROM ', dockerfile.indexOf('AS workspace\n')));
  assert.match(workspace, /^COPY manual\/ \/manual\/$/m);
  const compose = await read('compose.yaml');
  const service = compose.slice(compose.indexOf('  natsumi-workspace:'), compose.indexOf('\nvolumes:'));
  const mount = service.match(/- type: volume\n\s+source: natsumi-data\n\s+target: \/manual\/agents\n([\s\S]*?)(?=\n\s+- type:|\n\s+# natsumi creates)/);
  assert.ok(mount, 'the list of agents is not mounted at /manual/agents');
  assert.match(mount[1]!, /read_only: true/);
  assert.match(mount[1]!, new RegExp(`subpath: ${AGENT_LIST_DIRECTORY}\\b`));
});

// ADR 0040: what she writes to the dove and what comes back are spelled the way the server reads and writes them.
test('the Slack page says how to ask the dove and names every answer it gives', async () => {
  const page = await read('manual/slack.md');
  for (const word of ['poppo', '返信先:', '種類: 投稿', '種類: リアクション', '表情:', '---', 'agent_reply',
    'sent', 'reacted', 'to_owner', 'returned', 'rejected', 'expired', 'not_sent']) {
    assert.ok(page.includes(word), word);
  }
  assert.doesNotMatch(page, /今はまだ Slack に書き込めません|書き込む手段がありません/);
});

// ADR 0044: the page on drawing names what the image holds, and her own look as the owner wrote it.
test('the page on images says how to draw with the default params, where to put the result, and how she looks', async () => {
  const page = await read('manual/images.md');
  for (const word of ['sdctl txt2img --prompt ', '/work/images', 'view ', '画像:', 'anima_mignolia_v10', 'kutara_aki_anima.v3', '-o ']) {
    assert.ok(page.includes(word), word);
  }
  // The defaults come from the image's sdctl config file: no flag for them, and nothing to throw away.
  assert.doesNotMatch(page, /--params/);
  assert.doesNotMatch(page, /\/dev\/null/);
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /^COPY docker\/sdctl\/anima\.yaml \/etc\/sdctl\/anima\.yaml$/m);
  assert.match(await read('docker/sdctl/config.yaml'), /^output_dir: \/work\/images$/m);
  // Her own look, as the owner wrote it, line breaks and all.
  assert.ok(page.includes([
    '<lora:kutara_aki_anima.v3:1> ,',
    'masterpiece, newest,',
    'woman, low ponytail, freckles,',
    '',
    'black glasses,',
    'black business suit,  collared white shirt, large breasts,',
  ].join('\n')));
});

test('the Slack page says how to name images for the dove', async () => {
  const page = await read('manual/slack.md');
  assert.ok(page.includes('画像: /work/'));
  assert.ok(page.includes('/manual/images.md'));
});

// ADR 0045: the page on images says how to show one to the owner, with reply_to_mac and never with a notice.
test('the page on images says how to show the owner a picture with reply_to_mac', async () => {
  const page = await read('manual/images.md');
  for (const word of ['reply_to_mac', 'images', '/work/', 'notify_owner']) assert.ok(page.includes(word), word);
});

// ADR 0048: an image an agent hands back is in /work/agents; she looks at it with view and shows it with reply_to_mac.
test('the page on asking agents says where an image in a reply is and how to look at it and show it', async () => {
  const page = await read('manual/ask-agent.md');
  for (const word of ['/work/agents/', 'images_not_taken', 'description', 'view', 'reply_to_mac', '/manual/images.md']) {
    assert.ok(page.includes(word), word);
  }
  assert.ok((await read('manual/images.md')).includes('/work/agents/'));
});
