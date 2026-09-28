import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { conditions, loadScene } from '../src/eval/scene.ts';
import type { RunRecord } from '../src/eval/record.ts';

// eval/ is not in the server image, where the tests are type-checked too: the scene is loaded at run time.
type Check = (record: RunRecord) => unknown;
const { counted, fromFile, noDefaults, notMe, outputInWork, quality, wide } = await import(join(import.meta.dirname, '..', 'eval', 'scenes', 'draw-other', 'scene.ts')) as
  Record<'counted' | 'fromFile' | 'noDefaults' | 'notMe' | 'outputInWork' | 'quality' | 'wide', Check>;

const SCENES = join(import.meta.dirname, '..', 'eval', 'scenes');

function recordOf(commands: string[]): RunRecord {
  return {
    tools: commands.map((command, index) => ({ call: index + 1, name: 'run_shell', args: { command }, result: '', isError: false })),
  } as unknown as RunRecord;
}

const pass = (verdict: unknown) => (verdict as { pass: boolean }).pass;
const SEA = "mkdir -p /work/prompts\ncat > /work/prompts/sea.yaml <<'EOF'\nprompt: |\n  masterpiece, best quality, newest, safe,\n  no humans,\n  A quiet sea at sunset.\nEOF";

test('a drawing as the manual teaches it passes every check', () => {
  const record = recordOf([SEA, 'sdctl txt2img --prompt /work/prompts/sea.yaml --width 1152 --height 896 -o /work/images/sea.png']);
  for (const check of [fromFile, noDefaults, outputInWork, quality, counted, notMe, wide]) assert.equal(pass(check(record)), true, check.name);
});

test('a prompt given inline, or a file never written, is not drawn from a file', () => {
  assert.equal(pass(fromFile(recordOf(['sdctl txt2img "a quiet sea at sunset"']))), false);
  assert.equal(pass(fromFile(recordOf(['sdctl txt2img --prompt /work/prompts/sea.yaml']))), false);
  // A path ends before the shell's own punctuation.
  assert.equal(pass(fromFile(recordOf([SEA, 'sdctl txt2img --prompt /work/prompts/sea.yaml; echo done']))), true);
  // A note about sdctl is not a drawing.
  const note = "cat >> /memory/always.md <<'EOF'\n- `sdctl txt2img --prompt <yaml>` で作る\nEOF";
  assert.equal(pass(fromFile(recordOf([SEA, 'sdctl txt2img --prompt /work/prompts/sea.yaml', note]))), true);
});

test('flags for what the defaults already set, or an image outside /work, are caught', () => {
  assert.equal(pass(noDefaults(recordOf([SEA, 'sdctl txt2img --prompt /work/prompts/sea.yaml --params /etc/sdctl/anima.yaml']))), false);
  assert.equal(pass(noDefaults(recordOf([SEA, 'sdctl txt2img --prompt /work/prompts/sea.yaml --steps 20 --sampler "Euler a"']))), false);
  assert.equal(pass(outputInWork(recordOf([SEA, 'sdctl txt2img --prompt /work/prompts/sea.yaml -o /tmp/sea.png']))), false);
  assert.equal(pass(outputInWork(recordOf([SEA, 'sdctl txt2img --prompt /work/prompts/sea.yaml']))), true);
});

test('a prompt without its quality line, its head count or with her LoRA on someone else fails', () => {
  const bare = "cat > /work/prompts/sea.yaml <<'EOF'\nprompt: |\n  <lora:kutara_aki_anima.v3:1> , a quiet sea at sunset\nEOF";
  const record = recordOf([bare, 'sdctl txt2img --prompt /work/prompts/sea.yaml']);
  assert.equal(pass(quality(record)), false);
  assert.equal(pass(counted(record)), false);
  assert.equal(pass(notMe(record)), false);
  assert.equal(pass(wide(record)), false);
});

test('the drawing scenes load, with their variants', async () => {
  const other = conditions(await loadScene(join(SCENES, 'draw-other'))).map(condition => condition.variant).sort();
  assert.deepEqual(other, ['girl', 'landscape', 'still-life', 'wide']);
  const shown = conditions(await loadScene(join(SCENES, 'show-image'))).map(condition => condition.variant).sort();
  assert.deepEqual(shown, ['mac', 'slack']);
  // The channel is part of the message, not a YAML comment.
  const slack = conditions(await loadScene(join(SCENES, 'show-image'))).find(condition => condition.variant === 'slack')!;
  assert.match(JSON.stringify(slack.event), /#random に貼っておいて/);
});
