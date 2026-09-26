import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { LOOP_DEFAULTS } from '../src/server/config.ts';
import { createLoopTools, type LoopToolHost, type ToolOutcome } from '../src/server/loop-tools.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';

/**
 * What sits on the prefix cache: the system prompt the loop hands a new session, and the tool definitions that go
 * with it (ADR 0019). The backend prefills slowly, so both are built once per session and never move while it runs.
 * One changed character costs every running session its cache until the nightly switch, so the two are pinned here
 * byte for byte and the fixtures are only ever updated on purpose. See `test/fixtures/prefix/README.md`.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'prefix');
/** Set to write the fixtures back. Only ever run deliberately, with the new wording read before it is committed. */
const UPDATING = process.env.UPDATE_PREFIX_FIXTURES === '1';

interface Prefix {
  /** The instructions the server itself builds. */
  systemPrompt: string;
  /** What Pi appends to them. `{dataDirectory}` stands for the loop's own, which differs on every run. */
  trailer: string;
  tools: { name: string; description: string; parameters: unknown }[];
}

/** Written into the fixture in place of the data directory, which is a temporary one in a test. */
const DATA_DIRECTORY = '{dataDirectory}';

const outcome = (text: string): ToolOutcome => ({ ok: true, text });

/** Every check lives on the server, so a host that answers anything is enough to read the definitions off. */
function toolHost(workspace: boolean): LoopToolHost {
  return {
    reply: () => outcome('replied'),
    notify: () => outcome('notified'),
    setExpression: () => outcome('expression'),
    writeHandoff: () => outcome('handoff'),
    writeChangeNote: () => outcome('change note'),
    scheduleSelfCheck: () => outcome('scheduled'),
    listSelfChecks: () => outcome('listed'),
    cancelSelfCheck: () => outcome('cancelled'),
    askAgent: () => outcome('asked'),
    ...(workspace ? { runShell: () => outcome('ran'),
      capture: async () => ({ ok: true as const, exitCode: 0, stdout: '', stdoutTruncated: false }) } : {}),
  };
}

function toolShapes(workspace: boolean): Prefix['tools'] {
  return createLoopTools(toolHost(workspace)).map(tool => ({
    name: tool.name,
    description: tool.description,
    // The JSON schema as the model is shown it; TypeBox's own symbols do not survive, which is the point.
    parameters: JSON.parse(JSON.stringify(tool.parameters)) as unknown,
  }));
}

/**
 * The three files the prompt is built from, written before the start so the repository takes them in as they are
 * rather than seeding its templates. They hold a fixed line each rather than nothing, so that the heading the
 * server writes over every section is pinned here too — and so that a file opening with a heading of its own is
 * seen not to repeat it (ADR 0020). What is measured is still the frame, not what memory happens to hold.
 */
const MEMORY: Record<string, string> = {
  'personality.md': '# 性格・話し方\n\n固定の性格。\n',
  'always.md': '# 常時記憶\n\n固定の常時記憶。\n',
  'handoff.md': '# 引き継ぎ\n\n固定の引き継ぎ。\n',
};

/** Opens a loop, with or without the workspace runner, and reads the prompt off the session it just made. */
async function capture(workspace: boolean): Promise<Prefix & { activeToolNames: string[] }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-prefix-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(join(data, 'memory'), { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  for (const [name, text] of Object.entries(MEMORY)) await writeFile(join(data, 'memory', name), text);
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  let session: AgentSession | undefined;
  const loop = await ThinkingLoop.open({
    db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
    runtime: fixtureRuntime,
    configureSession: captured => { session = captured; },
    loop: { ...LOOP_DEFAULTS, ...(workspace ? { workspaceSocket: join(root, 'runner.sock') } : {}) },
  });
  try {
    assert.ok(session, 'the loop made no session');
    // Pi appends a section of its own, the working directory. Splitting it off keeps the temporary path out of the
    // fixture and pins the shape of what Pi adds: an upgrade that adds more would move the prefix just as a reworded
    // instruction would.
    // Pi's read carries a snippet and a guideline for Pi's own prompt; with natsumi's prompt neither goes in (ADR 0047).
    assert.doesNotMatch(session.systemPrompt, /Use read to examine files|Read file contents/);
    const split = session.systemPrompt.indexOf('\n\n<cwd>\n');
    assert.ok(split > 0, 'Pi no longer appends the working directory; the prefix has moved');
    return {
      systemPrompt: session.systemPrompt.slice(0, split),
      trailer: session.systemPrompt.slice(split).replaceAll(data, DATA_DIRECTORY),
      activeToolNames: session.getActiveToolNames(),
      tools: toolShapes(workspace),
    };
  } finally {
    await loop.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function check(name: string, workspace: boolean) {
  const captured = await capture(workspace);
  const prefix: Prefix = { systemPrompt: captured.systemPrompt, trailer: captured.trailer, tools: captured.tools };
  // The session really registers the tools the fixture pins, in the same order.
  assert.deepEqual(captured.activeToolNames, prefix.tools.map(tool => tool.name));
  const file = join(FIXTURES, `${name}.json`);
  if (UPDATING) {
    await writeFile(file, `${JSON.stringify(prefix, undefined, 2)}\n`);
    return;
  }
  const expected = JSON.parse(await readFile(file, 'utf8')) as Prefix;
  assert.equal(prefix.systemPrompt, expected.systemPrompt);
  assert.equal(prefix.trailer, expected.trailer);
  assert.deepEqual(prefix.tools, expected.tools);
}

test('the system prompt and the tool definitions are unchanged, with a workspace', async () => {
  await check('with-workspace', true);
});

test('the system prompt and the tool definitions are unchanged, without a workspace', async () => {
  await check('without-workspace', false);
});
