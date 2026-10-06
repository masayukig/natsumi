import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defineTool, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { openPiSession } from '../src/pi/session.ts';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { fixtureRuntime } from './support/fixture.ts';

// An extension on disk that would add a tool if Pi ever loaded it.
const DISK_EXTENSION = `export default function (pi) {
  pi.registerTool({ name: 'disk_tool', label: 'disk', description: 'disk', parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'disk' }], details: {} }) });
}
`;

test('only the extensions given in code are loaded: none on disk and none of Pi\'s built-in ones (ADR 0004, ADR 0047)', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-pi-extensions-')));
  try {
    const cwd = join(root, 'data');
    const agentDir = join(root, 'agent');
    const sessionDir = join(root, 'sessions');
    for (const dir of [join(cwd, '.pi', 'extensions'), join(agentDir, 'extensions'), sessionDir]) await mkdir(dir, { recursive: true });
    await writeFile(join(cwd, '.pi', 'extensions', 'disk.ts'), DISK_EXTENSION);
    await writeFile(join(agentDir, 'extensions', 'disk.ts'), DISK_EXTENSION);
    // Settings on disk that would turn Pi's built-in extensions on are not read either.
    const enable = JSON.stringify({ extensions: ['builtin:codemode', 'builtin:tool-search', 'builtin:mcp', 'builtin:llama.cpp'] });
    await writeFile(join(agentDir, 'settings.json'), enable);
    await writeFile(join(cwd, '.pi', 'settings.json'), enable);

    let loaded = 0;
    const ours: ExtensionFactory = () => { loaded += 1; };
    const echo = defineTool({ name: 'echo', label: 'echo', description: 'echo', parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'echo' }], details: {} }) });
    const session = await openPiSession({ cwd, agentDir, sessionDir, modelRuntime: await fixtureRuntime(), target: SUBSCRIPTION_TARGET,
      systemPrompt: 'fixture prompt', thinkingLevel: 'off', tools: { names: ['echo'], definitions: [echo] }, extensions: [ours] });
    try {
      assert.equal(loaded, 1);
      const { extensions, errors } = session.resourceLoader.getExtensions();
      assert.deepEqual(errors, []);
      assert.equal(extensions.length, 1, extensions.map(extension => extension.path).join(', '));
      assert.deepEqual(session.getAllTools().map(tool => tool.name), ['echo']);
      assert.deepEqual(session.getActiveToolNames(), ['echo']);
    } finally { session.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
