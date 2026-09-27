import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { conditions, loadScene, loadScenes, SceneError } from '../src/eval/scene.ts';

async function withScenes(scenes: Record<string, string>, body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-scenes-'));
  try {
    for (const [name, yaml] of Object.entries(scenes)) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, 'scene.yaml'), yaml);
    }
    await body(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const GREETING = `
description: 本人のあいさつに返事をする
runs: 3
time: "2026-09-27T09:00:00+09:00"
files:
  /memory/personality.md: |
    # 性格・話し方
    明るい。
event:
  mac_message: おはよう
checks:
  - id: replied
    called: reply_to_mac
    max: 1
  - id: kind
    rubric: 朝のあいさつとして自然に返している。
`;

test('a scene is read from its directory with its defaults filled in', async () => {
  await withScenes({ greeting: GREETING }, async root => {
    const scene = await loadScene(join(root, 'greeting'));
    assert.equal(scene.name, 'greeting');
    assert.equal(scene.runs, 3);
    assert.equal(scene.timeZone, 'Asia/Tokyo');
    assert.deepEqual(scene.requires, []);
    assert.equal(scene.time, Date.parse('2026-09-27T09:00:00+09:00'));
    const [only, ...rest] = conditions(scene);
    assert.equal(rest.length, 0);
    assert.equal(only!.variant, 'base');
    assert.deepEqual(only!.event, { kind: 'mac_message', text: 'おはよう' });
    assert.deepEqual(only!.files['/memory/personality.md'], { text: '# 性格・話し方\n明るい。\n' });
    assert.deepEqual(only!.checks.map(check => [check.id, check.by]), [['replied', 'rule'], ['kind', 'llm']]);
  });
});

test('axes multiply into variants, each merged over the scene in the order of the axes', async () => {
  await withScenes({ sources: `
event:
  line: { type: sources_updated, where: base }
files:
  /manual/slack.md: base
checks:
  - id: read
    read: /manual/slack.md
axes:
  location:
    P: {}
    C:
      event:
        line: { type: sources_updated, where: line }
      prompt:
        - replace: "path がその場所で"
          with: "line がその場所で"
  manual:
    with: {}
    without:
      edits:
        - path: /manual/slack.md
          replace: "## 読み方"
          with: ""
      checks:
        - id: read
          notRead: /manual/slack.md
` }, async root => {
    const [scene] = await loadScenes([root]);
    const all = conditions(scene!);
    assert.deepEqual(all.map(condition => condition.variant), ['P/with', 'P/without', 'C/with', 'C/without']);
    const cWithout = all[3]!;
    assert.deepEqual(cWithout.event, { kind: 'line', line: { type: 'sources_updated', where: 'line' } });
    assert.deepEqual(cWithout.prompt, [{ replace: 'path がその場所で', with: 'line がその場所で' }]);
    assert.deepEqual(cWithout.edits, [{ path: '/manual/slack.md', replace: '## 読み方', with: '' }]);
    // A check of the same id is replaced by the variant's, where it stood.
    assert.deepEqual(cWithout.checks.map(check => check.spec), [{ notRead: '/manual/slack.md' }]);
    assert.deepEqual(all[0]!.checks.map(check => check.spec), [{ read: '/manual/slack.md' }]);
  });
});

test('a file may come from beside the scene, and a directory may be copied whole', async () => {
  await withScenes({ private: `
files:
  /memory/notes.md: { file: ./notes.md }
copy:
  /memory: ./memory
context:
  session: ./session.jsonl
  padding: { turns: 2, chars: 1000 }
  prelude:
    - event: { mac_message: きのうの話 }
      calls:
        - { tool: reply_to_mac, args: { text: うん, expression: happy } }
event: { ping: {} }
checks:
  - { id: quiet, notCalled: notify_owner }
` }, async root => {
    const scene = await loadScene(join(root, 'private'));
    const [condition] = conditions(scene);
    assert.deepEqual(condition!.files['/memory/notes.md'], { file: join(root, 'private', 'notes.md') });
    assert.deepEqual(condition!.copies, { '/memory': join(root, 'private', 'memory') });
    assert.equal(scene.context.session, join(root, 'private', 'session.jsonl'));
    assert.deepEqual(scene.context.padding, { turns: 2, chars: 1000 });
    assert.deepEqual(scene.context.prelude, [{ event: { kind: 'mac_message', text: 'きのうの話' },
      calls: [{ tool: 'reply_to_mac', args: { text: 'うん', expression: 'happy' } }] }]);
    assert.deepEqual(condition!.event, { kind: 'ping' });
  });
});

test('a scene out of shape is refused with the place it went wrong', async () => {
  const cases: [string, RegExp][] = [
    ['checks: []\n', /event/],
    ['event: { mac_message: x }\nfiles:\n  /etc/passwd: x\n', /files\./],
    ['event: { mac_message: x }\nchecks:\n  - { id: a, called: reply_to_mac }\n  - { id: a, called: notify_owner }\n', /checks.*a/],
    ['event: { mac_message: x }\nchecks:\n  - { id: a, called: reply_to_mac, rubric: x }\n', /checks\[0\]/],
    ['event: { mac_message: x }\nunknown: 1\n', /unknown/],
    ['event: { mac_message: x }\nchecks:\n  - { id: a, shell: "(" }\n', /checks\[0\]\.shell/],
    ['event: { mac_message: x, ping: {} }\n', /event/],
    ['event: { mac_message: x }\nrequires: [time-travel]\n', /requires/],
  ];
  for (const [yaml, message] of cases) {
    await withScenes({ bad: yaml }, async root => {
      await assert.rejects(loadScene(join(root, 'bad')), (error: Error) => {
        assert.ok(error instanceof SceneError, String(error));
        assert.match(error.message, message);
        return true;
      });
    });
  }
});

test('the scenes kept in the repository all load', async () => {
  const scenes = await loadScenes([join(import.meta.dirname, '..', 'eval', 'scenes')]);
  assert.ok(scenes.length >= 2);
  for (const scene of scenes) assert.ok(conditions(scene).length >= 1, scene.name);
  // sources_updated is on main (ADR 0050): its scene needs nothing more.
  const sources = scenes.find(scene => scene.name === 'sources-mention');
  assert.deepEqual(sources?.requires, []);
  assert.equal(conditions(sources!).length, 10);
});
