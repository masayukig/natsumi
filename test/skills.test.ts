import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { defineTool, type AgentSession } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { openPiSession } from '../src/pi/session.ts';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { composeSystemPrompt, SKILLS_SECTION } from '../src/server/prompts.ts';
import { OWN_SKILLS_PLACE, OWNER_SKILLS_PLACE, piSkills, skillPlaces } from '../src/server/skills.ts';
import { fixtureRuntime } from './support/fixture.ts';

// ADR 0073: the owner's skills and her own, from two places only, listed at the paths the workspace reads them by.

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n手順。\n`;

/** A stand-in for the workspace's read: the list goes into the prompt only when a reader is among the tools. */
const READ = defineTool({ name: 'read', label: 'read', description: 'read', parameters: Type.Object({ path: Type.String() }),
  execute: async () => ({ content: [{ type: 'text', text: 'read' }], details: {} }) });

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-skills-')));
  const data = join(root, 'data');
  const memory = join(data, 'memory');
  const agentDir = join(root, 'pi', 'agent');
  const sessionDir = join(root, 'pi', 'sessions');
  for (const dir of [join(data, 'skills'), join(memory, 'skills'), agentDir, sessionDir]) await mkdir(dir, { recursive: true });
  const lines: string[] = [];
  const write = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const open = async (options: { skills?: boolean; tools?: boolean } = {}) => openPiSession({
    cwd: data, agentDir, sessionDir, modelRuntime: await fixtureRuntime(), target: SUBSCRIPTION_TARGET,
    systemPrompt: 'fixture prompt', thinkingLevel: 'off',
    ...(options.tools === false ? {} : { tools: { names: ['read'], definitions: [READ] } }),
    ...(options.skills === false ? {} : { skills: piSkills(skillPlaces(data, memory), line => lines.push(line)) }),
  });
  return { root, data, memory, agentDir, lines, write, open, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const listed = (session: AgentSession) => [...session.systemPrompt.matchAll(/<location>(.*?)<\/location>/g)].map(match => match[1]);

test('the owner\'s skills and hers are listed at the workspace\'s paths, the owner\'s first', async () => {
  const f = await setup();
  try {
    await f.write(join(f.memory, 'skills', 'a-own', 'SKILL.md'), skill('a-own', 'なつみが書いた手順'));
    await f.write(join(f.data, 'skills', 'z-owner', 'SKILL.md'), skill('z-owner', 'マスターが書いた手順'));
    await f.write(join(f.data, 'skills', 'group', 'nested', 'SKILL.md'), skill('nested', '入れ子の手順'));
    const session = await f.open();
    try {
      assert.deepEqual(listed(session), [`${OWNER_SKILLS_PLACE}/group/nested/SKILL.md`, `${OWNER_SKILLS_PLACE}/z-owner/SKILL.md`,
        `${OWN_SKILLS_PLACE}/a-own/SKILL.md`]);
      assert.equal(OWNER_SKILLS_PLACE, '/skills');
      assert.equal(OWN_SKILLS_PLACE, '/memory/skills');
      // The server's own paths never reach the model in the list (Pi's own <cwd> section after it is another matter).
      assert.ok(!session.systemPrompt.slice(0, session.systemPrompt.indexOf('<cwd>')).includes(f.data));
      assert.match(session.systemPrompt, /マスターが書いた手順/);
      assert.match(f.lines.join('\n'), /skills: 2 of the owner's and 1 of her own/);
    } finally { session.dispose(); }
  } finally { await f.cleanup(); }
});

test('a name in both places is the owner\'s, and hers is left out with a warning', async () => {
  const f = await setup();
  try {
    await f.write(join(f.data, 'skills', 'same', 'SKILL.md'), skill('same', 'マスターの版'));
    await f.write(join(f.memory, 'skills', 'same', 'SKILL.md'), skill('same', 'なつみの版'));
    const session = await f.open();
    try {
      assert.deepEqual(listed(session), [`${OWNER_SKILLS_PLACE}/same/SKILL.md`]);
      assert.doesNotMatch(session.systemPrompt, /なつみの版/);
      const warning = f.lines.find(line => line.includes('"same"'));
      assert.ok(warning, f.lines.join('\n'));
      assert.ok(warning.includes(`${OWN_SKILLS_PLACE}/same/SKILL.md`) && warning.includes(`${OWNER_SKILLS_PLACE}/same/SKILL.md`), warning);
    } finally { session.dispose(); }
  } finally { await f.cleanup(); }
});

test('without the owner\'s clone the session still opens, with her skills and a warning', async () => {
  const f = await setup();
  try {
    await rm(join(f.data, 'skills'), { recursive: true });
    await f.write(join(f.memory, 'skills', 'mine', 'SKILL.md'), skill('mine', 'なつみの手順'));
    const session = await f.open();
    try {
      assert.deepEqual(listed(session), [`${OWN_SKILLS_PLACE}/mine/SKILL.md`]);
      assert.ok(f.lines.some(line => line.includes(OWNER_SKILLS_PLACE) && /does not exist/.test(line)), f.lines.join('\n'));
    } finally { session.dispose(); }
  } finally { await f.cleanup(); }
});

test('a SKILL.md that cannot be loaded is warned of and the rest are listed', async () => {
  const f = await setup();
  try {
    await f.write(join(f.data, 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\n\n説明がない。\n');
    await f.write(join(f.data, 'skills', 'good', 'SKILL.md'), skill('good', '使える手順'));
    const session = await f.open();
    try {
      assert.deepEqual(listed(session), [`${OWNER_SKILLS_PLACE}/good/SKILL.md`]);
      assert.ok(f.lines.some(line => line.includes(`${OWNER_SKILLS_PLACE}/broken/SKILL.md`) && /description/.test(line)), f.lines.join('\n'));
    } finally { session.dispose(); }
  } finally { await f.cleanup(); }
});

test('a skill reached through a symlink is never listed: the server would read what the workspace cannot see', async () => {
  const f = await setup();
  try {
    const outside = join(f.root, 'server-only');
    await f.write(join(outside, 'secret', 'SKILL.md'), skill('secret', 'SERVER-ONLY-TEXT'));
    await f.write(join(outside, 'file', 'SKILL.md'), skill('linked', 'SERVER-ONLY-TEXT'));
    await symlink(join(outside, 'secret'), join(f.memory, 'skills', 'secret'));
    await mkdir(join(f.memory, 'skills', 'linked'));
    await symlink(join(outside, 'file', 'SKILL.md'), join(f.memory, 'skills', 'linked', 'SKILL.md'));
    await f.write(join(f.memory, 'skills', 'plain', 'SKILL.md'), skill('plain', '普通の手順'));
    const session = await f.open();
    try {
      assert.deepEqual(listed(session), [`${OWN_SKILLS_PLACE}/plain/SKILL.md`]);
      assert.doesNotMatch(session.systemPrompt, /SERVER-ONLY-TEXT/);
      for (const name of ['secret', 'linked']) {
        assert.ok(f.lines.some(line => line.includes(`${OWN_SKILLS_PLACE}/${name}/SKILL.md`) && /symlink/.test(line)), f.lines.join('\n'));
      }
    } finally { session.dispose(); }
  } finally { await f.cleanup(); }
});

test('only the two places are read: Pi\'s own places stay unsearched, and without the setting nothing is loaded (ADR 0004)', async () => {
  const f = await setup();
  try {
    await f.write(join(f.agentDir, 'skills', 'pi-user', 'SKILL.md'), skill('pi-user', 'Pi の利用者の場所'));
    await f.write(join(f.data, '.pi', 'skills', 'pi-project', 'SKILL.md'), skill('pi-project', 'Pi のプロジェクトの場所'));
    await f.write(join(f.data, 'skills', 'owner', 'SKILL.md'), skill('owner', 'マスターの手順'));
    const on = await f.open();
    try { assert.deepEqual(listed(on), [`${OWNER_SKILLS_PLACE}/owner/SKILL.md`]); } finally { on.dispose(); }
    const off = await f.open({ skills: false });
    try {
      assert.deepEqual(off.resourceLoader.getSkills().skills, []);
      assert.doesNotMatch(off.systemPrompt, /<available_skills>/);
    } finally { off.dispose(); }
  } finally { await f.cleanup(); }
});

test('the list is made with the session and does not move while it runs', async () => {
  const f = await setup();
  try {
    await f.write(join(f.data, 'skills', 'first', 'SKILL.md'), skill('first', '最初の手順'));
    const session = await f.open();
    try {
      const before = session.systemPrompt;
      await f.write(join(f.memory, 'skills', 'later', 'SKILL.md'), skill('later', '後から書いた手順'));
      // Pi builds the prompt again when the tools change; the skills it builds it from are the ones it loaded.
      session.setActiveToolsByName(['read']);
      assert.equal(session.systemPrompt, before);
      assert.doesNotMatch(session.systemPrompt, /later/);
    } finally { session.dispose(); }
    const next = await f.open();
    try { assert.match(next.systemPrompt, /\/memory\/skills\/later\/SKILL\.md/); } finally { next.dispose(); }
  } finally { await f.cleanup(); }
});

test('with skills on and a workspace, she is told where skills are and how to write her own; otherwise nothing changes', () => {
  const parts = { personality: '', always: '', handoff: '' };
  const on = composeSystemPrompt({ workspace: true, skills: true, ...parts });
  assert.ok(on.includes(SKILLS_SECTION));
  assert.ok(on.indexOf('## 記憶と作業場') < on.indexOf(SKILLS_SECTION) && on.indexOf(SKILLS_SECTION) < on.indexOf('## 出来事の種類'));
  for (const words of [/\/skills/, /\/memory\/skills\/<名前>\/SKILL\.md/, /読み取り専用/, /name/, /description/, /次の思考の記録/, /\.md/, /scripts\//, /bash /, /python3 /]) {
    assert.match(SKILLS_SECTION, words);
  }
  assert.equal(composeSystemPrompt({ workspace: true, skills: false, ...parts }), composeSystemPrompt({ workspace: true, ...parts }));
  assert.ok(!composeSystemPrompt({ workspace: false, skills: true, ...parts }).includes(SKILLS_SECTION));
});
