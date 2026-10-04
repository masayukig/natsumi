import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import { openPiSession } from '../src/pi/session.ts';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';

/**
 * A session record written by Pi 0.87.1 through the thinking loop (made-up conversation: owner messages, thinking,
 * tool calls and results, memos and one compaction). The running server keeps sessions across Pi upgrades, so a newer
 * Pi must open such a record as the same session with the same context, and go on appending to it.
 */
const FIXTURE = join(import.meta.dirname, 'fixtures', 'pi-0.87.1', 'session.jsonl');
const PASSPHRASE = 'SYNTHETIC-HERON-208';

const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};

test('a session written by Pi 0.87.1 opens as the same session, with the compacted context, and goes on', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-pi-compat-')));
  try {
    const cwd = join(root, 'data');
    const sessionDir = join(root, 'sessions');
    await mkdir(cwd); await mkdir(sessionDir);
    const file = join(sessionDir, 'saved.jsonl');
    await copyFile(FIXTURE, file);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    const header = JSON.parse(lines[0]!) as { id: string };

    const session = await openPiSession({ cwd, agentDir: join(root, 'agent'), sessionDir, modelRuntime: await fixtureRuntime(),
      target: SUBSCRIPTION_TARGET, systemPrompt: 'fixture prompt', thinkingLevel: 'medium', file, expectedSessionId: header.id });
    try {
      assert.equal(session.sessionId, header.id);
      assert.equal(session.sessionFile, file);
      const messages = session.messages;
      // The saved system message, then the summary, then what the compaction kept.
      assert.deepEqual(messages.slice(0, 3).map(message => message.role), ['system', 'compactionSummary', 'user']);
      assert.match((messages[1] as { summary: string }).summary, new RegExp(`要約: ${PASSPHRASE}`));
      const blocks = messages.flatMap(message => message.role === 'assistant' ? message.content.map(block => block.type) : []);
      assert.ok(blocks.includes('thinking') && blocks.includes('toolCall'), JSON.stringify(blocks));
      assert.ok(messages.some(message => message.role === 'toolResult' && message.toolName === 'reply_to_mac'));
      assert.equal(textOf(messages.filter(message => message.role === 'user').at(-1)!).includes('最後の話'), false,
        'the last turn ends with its memo, not with the owner message');

      const model = new ScriptedModel();
      model.auto = () => 'つづき';
      session.agent.streamFunction = model.streamFunction;
      await session.prompt('再開');
      const seen = model.contexts.at(-1)!;
      assert.match(textOf(seen.messages[0]!), new RegExp(`要約: ${PASSPHRASE}`), 'the summary reaches the model first');
      assert.equal(seen.messages.at(-1)!.role, 'user');
      assert.ok(seen.systemPrompt?.startsWith('fixture prompt'), 'the prompt given now, not the one saved in the record');
    } finally { session.dispose(); }

    // The new entries are appended to the same file, after the old ones, which stay as they were.
    const after = (await readFile(file, 'utf8')).trim().split('\n');
    assert.deepEqual(after.slice(0, lines.length), lines);
    assert.ok(after.length > lines.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});
