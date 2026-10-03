import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { conditions, loadScene } from '../src/eval/scene.ts';
import type { RunRecord } from '../src/eval/record.ts';

// eval/ is not in the server image, where the tests are type-checked too: the scene is loaded at run time.
type Check = (record: RunRecord) => unknown;
// Her look is the default avatar's appearance.yaml (ADR 0057): the LoRA, the words to keep and the default clothes.
const { changedOutfit, drawnPrompt, keep, look, lora } = await import(join(import.meta.dirname, '..', 'eval', 'scenes', 'self-look', 'scene.ts')) as
  Record<'changedOutfit' | 'keep' | 'look' | 'lora', Check> & { drawnPrompt: (record: RunRecord) => string | undefined };

const LOOK = [
  '<lora:kutara_anima.v1:1> ,',
  'masterpiece, newest,',
  'kutara natsumi, low ponytail, freckles, large breasts,',
  '',
  'black glasses,',
].join('\n');

function write(file: string, body: string): string {
  return `mkdir -p /work/prompts\ncat > /work/prompts/${file} <<'EOF'\nprompt: |\n${body.split('\n').map(line => `  ${line}`).join('\n')}\nEOF`;
}

function recordOf(commands: string[]): RunRecord {
  return {
    tools: commands.map((command, index) => ({ call: index + 1, name: 'run_shell', args: { command }, result: '', isError: false })),
  } as unknown as RunRecord;
}

test('the prompt she drew is the file named by the last sdctl, as she last wrote it', () => {
  const record = recordOf([
    write('me.yaml', 'woman, freckles'),
    write('other.yaml', 'cat, no humans'),
    'sdctl txt2img --prompt /work/prompts/me.yaml',
    write('me.yaml', `${LOOK}\n1girl, pajamas`),
    'grep -c freckles /work/prompts/me.yaml',
    'sdctl txt2img --prompt /work/prompts/me.yaml -o /work/images/me.png',
  ]);
  const prompt = drawnPrompt(record);
  assert.ok(prompt?.includes('pajamas'), prompt);
  assert.ok(!prompt?.includes('no humans'), prompt);
});

test('of two files written in one command, the prompt is the one sdctl read', () => {
  const record = recordOf([
    `${write('me.yaml', `${LOOK}\nblack business suit,`)}\n${write('pajamas.yaml', `${LOOK}\nstriped pajamas,`)}`,
    'cd /work && sdctl txt2img --prompt /work/prompts/pajamas.yaml',
  ]);
  assert.equal((changedOutfit(record) as { pass: boolean }).pass, true, drawnPrompt(record));
});

test('sdctl behind time or timeout is still a drawing', () => {
  for (const run of ['cd /work && time sdctl txt2img --prompt /work/prompts/me.yaml 2>&1 | tail -20', 'timeout 300 sdctl txt2img --prompt /work/prompts/me.yaml']) {
    const record = recordOf([write('me.yaml', `${LOOK}\n1girl`), run]);
    assert.equal((look(record) as { pass: boolean }).pass, true, run);
  }
});

test('sdctl written about in a note is not a drawing', () => {
  const record = recordOf([
    write('me.yaml', `${LOOK}\n1girl`),
    'sdctl txt2img --prompt /work/prompts/me.yaml',
    "cat >> /memory/always.md <<'EOF'\n- 絵は `sdctl txt2img --prompt <yaml>` で作る\nEOF",
  ]);
  assert.equal((look(record) as { pass: boolean }).pass, true, drawnPrompt(record));
});

test('a grep for her features does not count as having drawn them', () => {
  const record = recordOf([
    write('me.yaml', '<lora:kutara_anima.v1:1> ,\nwoman, low ponytail,\nblack glasses,'),
    'grep -E "freckles|large breasts" /work/prompts/me.yaml',
    'sdctl txt2img --prompt /work/prompts/me.yaml',
  ]);
  assert.equal((lora(record) as { pass: boolean }).pass, true);
  assert.deepEqual(keep(record), { pass: false, detail: '無い: freckles, large breasts' });
  assert.equal((look(record) as { pass: boolean }).pass, false);
});

test('her whole look passes only with the LoRA and every word to keep in the prompt she drew', () => {
  const kept = recordOf([`${write('me.yaml', `${LOOK}\n1girl, casual clothes, park`)}\nsdctl txt2img --prompt /work/prompts/me.yaml`]);
  assert.equal((look(kept) as { pass: boolean }).pass, true);
  assert.equal((changedOutfit(kept) as { pass: boolean }).pass, true);
  const suited = recordOf([write('me.yaml', `${LOOK}\nblack business suit,  collared white shirt,`), 'sdctl txt2img --prompt /work/prompts/me.yaml']);
  assert.equal((changedOutfit(suited) as { pass: boolean }).pass, false);
});

test('a feature only in the negative prompt is not in the picture', () => {
  const record = recordOf([
    `cat > /work/prompts/me.yaml <<'EOF'\nprompt: |\n  <lora:kutara_anima.v1:1> ,\n  kutara natsumi, low ponytail, large breasts,\nnegative: |\n  freckles\nEOF`,
    'sdctl txt2img --prompt /work/prompts/me.yaml',
  ]);
  assert.deepEqual(keep(record), { pass: false, detail: '無い: freckles' });
});

test('without a drawing there is no prompt, and nothing passes', () => {
  const record = recordOf(['ls /work']);
  assert.equal(drawnPrompt(record), undefined);
  assert.equal((look(record) as { pass: boolean }).pass, false);
  assert.equal((changedOutfit(record) as { pass: boolean }).pass, false);
});

test('the self-look scene asks for her picture in several ways', async () => {
  const scene = await loadScene(join(import.meta.dirname, '..', 'eval', 'scenes', 'self-look'));
  const variants = conditions(scene).map(condition => condition.variant).sort();
  assert.deepEqual(variants, ['casual', 'mood', 'pair', 'pajamas', 'scene', 'selfie']);
  for (const condition of conditions(scene)) {
    const ids = condition.checks.map(check => check.id);
    for (const id of ['drew', 'lora', 'keep', 'look']) assert.ok(ids.includes(id), `${condition.variant}: ${id}`);
    if (['casual', 'pajamas'].includes(condition.variant)) assert.ok(ids.includes('outfit'), condition.variant);
  }
});
