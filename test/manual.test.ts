import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { AGENT_LIST_PATH } from '../src/server/agent-requests.ts';
import { AGENT_LIST_DIRECTORY, AGENT_LIST_FILE } from '../src/server/agent-list.ts';
import { loadAvatar } from '../src/server/avatar.ts';
import { readImagesTemplate, renderImagesPage } from '../src/server/avatar-manual.ts';
import { parseDoveRequest } from '../src/server/dove-request.ts';
import { codeManualDirectory, readManualIndex } from '../src/server/manual.ts';
import { ASK_AGENT_DESCRIPTION, composeSystemPrompt, workspaceSection } from '../src/server/prompts.ts';

const root = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFile(`${root}${path}`, 'utf8');
/** The part of the manual the server writes on every start, rather than the image holding it (ADR 0036). */
const LIST = `/manual/agents/${AGENT_LIST_FILE}`;
/** The page on drawing, which the server writes from the avatar on every start (ADR 0057), as it writes it for natsumi. */
const IMAGES = '/manual/avatar/images.md';
/** The params the server writes beside it, which the page on drawing names. */
const PARAMS = '/manual/avatar/sdctl-params.yaml';
const imagesPage = async () => renderImagesPage(await readImagesTemplate(), await loadAvatar(undefined));

const mentioned = (text: string) => [...text.matchAll(/\/manual\/[\w./-]*[\w]/g)].map(match => match[0]);

// ADR 0036: what she is pointed at must be there. A renamed page would leave her reading nothing.
test('every page of the manual that the prompt, the tool and the manual itself name exists', async () => {
  const pages = await readdir(`${root}manual`);
  const texts = [workspaceSection(), ASK_AGENT_DESCRIPTION, AGENT_LIST_PATH, await imagesPage(),
    ...await Promise.all(pages.map(page => read(`manual/${page}`)))];
  const named = new Set(texts.flatMap(mentioned));
  assert.ok(named.has('/manual/INDEX.md'));
  assert.ok(named.has(LIST));
  assert.ok(named.has(IMAGES));
  for (const path of named) {
    if (path === LIST || path === IMAGES || path === PARAMS) continue;
    assert.ok(pages.includes(path.replace('/manual/', '')), `${path} is named but not in manual/`);
  }
  assert.equal(AGENT_LIST_PATH, LIST);
  // Every page is reachable from the index.
  const index = await read('manual/INDEX.md');
  for (const page of pages.filter(page => page !== 'INDEX.md')) assert.ok(index.includes(`/manual/${page}`), page);
  assert.ok(index.includes(IMAGES));
});

test('the manual speaks of the same states and the same argument as the tool, and of the reply under /sources', async () => {
  const page = await read('manual/ask-agent.md');
  for (const word of ['completed', 'failed', 'input_required', 'gave_up', 'continue: true', 'continue: false', 'agent_reply',
    'sources_updated', 'attention', 'summary', 'state', '/sources/agents/', 'README.md', 'images/', 'reply_to_mac',
    'request.md', 'request', 'asked_at', '頼んだこと']) {
    assert.ok(page.includes(word), word);
  }
  // ADR 0069: no reply comes as an agent_reply event with its text, nor puts images in /work any more.
  assert.doesNotMatch(page, /\/work\/agents|images_not_taken|text が答え/);
});

test('the workspace image holds the manual, and compose shows it the list of agents and the avatar\'s pages read-only', async () => {
  const dockerfile = await read('Dockerfile');
  const workspace = dockerfile.slice(dockerfile.indexOf('AS workspace\n'), dockerfile.indexOf('\nFROM ', dockerfile.indexOf('AS workspace\n')));
  assert.match(workspace, /^COPY manual\/ \/manual\/$/m);
  const compose = await read('compose.yaml');
  const service = compose.slice(compose.indexOf('  natsumi-workspace:'), compose.indexOf('\nvolumes:'));
  const mount = service.match(/- type: volume\n\s+source: natsumi-data\n\s+target: \/manual\/agents\n([\s\S]*?)(?=\n\s+- type:|\n\s+# natsumi creates)/);
  assert.ok(mount, 'the list of agents is not mounted at /manual/agents');
  assert.match(mount[1]!, /read_only: true/);
  assert.match(mount[1]!, new RegExp(`subpath: ${AGENT_LIST_DIRECTORY}\\b`));
  const avatar = /target: \/manual\/avatar\n(( {8}.*\n)+)/.exec(service);
  assert.ok(avatar, 'the avatar\'s pages are not mounted at /manual/avatar');
  assert.match(avatar[1]!, /read_only: true/);
  assert.match(avatar[1]!, /subpath: avatar\b/);
});

// ADR 0040, ADR 0074: what she writes to the dove and what comes back are spelled the way the server reads and writes them.
test('the Slack page says how to ask the dove in JSON, where the results are, and names every one it gives', async () => {
  const page = await read('manual/slack.md');
  for (const word of ['poppo', '"kind"', '"post"', '"reaction"', '"to"', '"file"', '"path"', '"face"', '"text"', '"emoji"', '"images"',
    'agent_reply', 'attention', '/sources/agents/poppo/', 'request.json', 'results.jsonl', 'slack_file', 'slack_path', 'summary',
    'sent', 'reacted', 'to_owner', 'returned', 'rejected', 'expired', 'not_sent']) {
    assert.ok(page.includes(word), word);
  }
  // The form before ADR 0074 is gone, and no schema is shown: the table and the examples are enough.
  assert.doesNotMatch(page, /返信先:|種類: 投稿|`---` の行|書き出しを「」|\$schema/);
  assert.doesNotMatch(page, /今はまだ Slack に書き込めません|書き込む手段がありません/);
  // Every example of a request is one the server takes.
  const examples = [...page.matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1]!).filter(block => block.includes('"to"'));
  assert.ok(examples.length >= 3, `${examples.length} examples`);
  for (const example of examples) assert.equal(parseDoveRequest(example).ok, true, example);
});

// ADR 0050: the page says what an attention's kind means, how to read the JSON Lines, and how to see a diff.
test('the Slack page reads a sources_updated: its kinds, the lines by jq -s, the thread by reply_to, and sources-diff', async () => {
  const page = await read('manual/slack.md');
  for (const word of ['sources_updated', 'attention', '`mention`', '`dm`', "jq -s '.[", 'tail -n', 'reply_to', 'deleted', 'mine',
    'sources-diff', '--since', '.jsonl']) {
    assert.ok(page.includes(word), word);
  }
  assert.doesNotMatch(page, /slack_mention|updates\.slack|reference はその発言/);
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /^COPY --chmod=755 docker\/sources-diff\/sources-diff \/usr\/local\/bin\/sources-diff$/m);
  const compose = await read('compose.yaml');
  const mount = /target: \/sources\.git\n(( {8}.*\n)+)/.exec(compose);
  assert.ok(mount, 'the history of /sources is not mounted at /sources.git');
  assert.match(mount[1]!, /read_only: true/);
  assert.match(mount[1]!, /subpath: sources\.git\b/);
});

// ADR 0044, ADR 0057: the page on drawing names the defaults, and natsumi's own look as the owner wrote it.
test('the page on images says how to draw with the default params, where to put the result, and how she looks', async () => {
  const page = await imagesPage();
  for (const word of ['sdctl txt2img --prompt ', '/work/images', 'view ', '`images`', 'anima_2_9_Anima-2.9B-preview-v1', 'kutara_anima.v1', '-o ']) {
    assert.ok(page.includes(word), word);
  }
  // The defaults come from the image's sdctl config file: no flag for them, and nothing to throw away.
  assert.doesNotMatch(page, /--params/);
  assert.doesNotMatch(page, /\/dev\/null/);
  assert.match(await read('docker/sdctl/config.yaml'), /^output_dir: \/work\/images$/m);
  // Her own look, as the owner wrote it, line breaks and all.
  assert.ok(page.includes([
    '<lora:kutara_anima.v1:1> ,',
    'masterpiece, newest,',
    'kutara natsumi, low ponytail, freckles, large breasts,',
    '',
    'black glasses,',
    'black business suit,  collared white shirt,',
  ].join('\n')));
});

// Her body is copied into every picture of her; only the clothes change with the scene.
test('the page on images says her body lines go into every picture of her, whatever she wears or however it is asked', async () => {
  const page = await imagesPage();
  const self = page.slice(page.indexOf('## あなた自身の姿'));
  assert.ok(self.startsWith('## あなた自身の姿'));
  // Which lines are her body and which are her clothes, and that the body is kept even when written as a scene.
  for (const word of ['体の行', '服の行', '自撮りでなくても', 'freckles', 'large breasts']) assert.ok(self.includes(word), word);
  // A check to run on the prompt before drawing.
  assert.match(self, /grep -q .*\/work\/prompts\//);
  // Examples in other clothes and of a mood, and every prompt of her in them keeps her body lines as the owner wrote them.
  const blocks = [...self.matchAll(/```\n([\s\S]*?)```/g)].map(match => match[1]!);
  const prompts = blocks.filter(block => block.includes('<lora:kutara_anima.v1:1>'));
  assert.ok(prompts.length >= 3, `${prompts.length} prompts of her`);
  for (const prompt of prompts) {
    for (const line of ['kutara natsumi, low ponytail, freckles, large breasts,', 'black glasses,']) assert.ok(prompt.includes(line), `${line}\n${prompt}`);
  }
  assert.ok(prompts.some(prompt => !prompt.includes('business suit')), 'no example in other clothes');
  assert.ok(prompts.some(prompt => /mood|feeling/i.test(prompt) || !/looking at viewer/.test(prompt)), 'no example that is not a selfie');
});

test('the Slack page says how to name images for the dove', async () => {
  const page = await read('manual/slack.md');
  assert.ok(page.includes('"images": ["/work/'));
  assert.ok(page.includes(IMAGES));
});

// ADR 0045: the page on images says how to show one to the owner, with reply_to_mac and never with a notice.
test('the page on images says how to show the owner a picture with reply_to_mac', async () => {
  const page = await imagesPage();
  for (const word of ['reply_to_mac', 'images', '/work/', 'notify_owner']) assert.ok(page.includes(word), word);
});

// ADR 0073: the owner's sd-generate skill is written for another machine. Where the two differ, this page wins, and it
// says so only for a deployment whose list has the skill.
test('the page on images says what to take from an sd-generate skill and where this page wins over it', async () => {
  const page = await imagesPage();
  const start = page.indexOf('## skill の sd-generate');
  assert.ok(start >= 0, 'no section on the sd-generate skill');
  const end = page.indexOf('\n## ', start + 1);
  const section = page.slice(start, end < 0 ? undefined : end);
  assert.match(section, /一覧に `sd-generate` があれば/);
  for (const word of ['go install', '/etc/sdctl/config.yaml', '--config', 'SDCTL_URL', 'localhost:7860', 'sdctl models set', '403',
    'override_settings', '--model', 'sdctl models list', '/manual/avatar/sdctl-params.yaml', '.jpg', '/work/images',
    'reply_to_mac', '/manual/slack.md']) {
    assert.ok(section.includes(word), word);
  }
  // The section is not where her own look is: that one stays last, as the server fills it in.
  assert.ok(start < page.indexOf('## あなた自身の姿'));
  // It lives in the workspace, not in her instructions: the prefix does not move.
  const index = await readManualIndex(await codeManualDirectory());
  assert.doesNotMatch(composeSystemPrompt({ workspace: true, skills: true, ...(index ? { manualIndex: index } : {}),
    personality: '', always: '', handoff: '' }), /sd-generate/);
});

// ADR 0048: an image an agent hands back is in /work/agents; she looks at it with view and shows it with reply_to_mac.
test('the page on asking agents says where an image in a reply is and how to look at it and show it', async () => {
  const page = await read('manual/ask-agent.md');
  for (const word of ['/sources/agents/', 'images/', '取れなかった画像', '説明', 'view', 'reply_to_mac', IMAGES]) {
    assert.ok(page.includes(word), word);
  }
  assert.ok((await imagesPage()).includes('/sources/agents/'));
});

// ADR 0074: the tool's fixed text and the page on asking agents say the dove's requests are JSON and its results are
// lines under /sources/agents/poppo, told as attentions, and the list of agents points at the Slack page.
test('the tool, the page on asking agents and the list say the dove is asked in JSON and heard from under /sources', async () => {
  for (const word of ['poppo', 'JSON', '/manual/slack.md', '/sources/agents/poppo', 'results.jsonl']) {
    assert.ok(ASK_AGENT_DESCRIPTION.includes(word), word);
  }
  assert.doesNotMatch(ASK_AGENT_DESCRIPTION, /agent_reply の出来事/);
  const page = await read('manual/ask-agent.md');
  for (const word of ['/sources/agents/poppo/', 'results.jsonl', '/manual/slack.md']) assert.ok(page.includes(word), word);
  assert.doesNotMatch(page, /agent_reply の出来事/);
  assert.doesNotMatch(await read('manual/slack.md'), /agent_reply の出来事/);
});
