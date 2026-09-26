import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoopTools, EXPRESSIONS, LOOP_TOOL_NAMES, READ_TOOL_NAME, RUN_SHELL_TOOL_NAME, type LoopToolHost } from '../src/server/loop-tools.ts';
import { ASK_AGENT_DESCRIPTION, NOTIFY_OWNER_DESCRIPTION, REPLY_TO_MAC_DESCRIPTION, RUN_SHELL_DESCRIPTION } from '../src/server/prompts.ts';
import { MAX_COMMAND_CHARS } from '../src/server/workspace-shell.ts';

const ok = (text: string) => ({ ok: true, text });

function host(overrides: Partial<LoopToolHost> = {}): LoopToolHost {
  return {
    reply: () => ok('replied'),
    notify: () => ok('notified'),
    setExpression: () => ok('expression'),
    writeHandoff: () => ok('handoff'),
    writeChangeNote: () => ok('change note'),
    scheduleSelfCheck: () => ok('scheduled'),
    listSelfChecks: () => ok('listed'),
    cancelSelfCheck: () => ok('cancelled'),
    askAgent: () => ok('asked'),
    ...overrides,
  };
}

const names = (h: LoopToolHost) => createLoopTools(h).map(tool => tool.name);

// ADR 0018 and ADR 0019: the shell is the only way to memory. The named memory tools are gone, not deprecated.
test('run_shell is registered with a runner, and the old memory tools are registered by nobody', () => {
  const withShell = names(host({ runShell: () => ok('ran') }));
  assert.ok(withShell.includes(RUN_SHELL_TOOL_NAME));
  assert.equal(RUN_SHELL_TOOL_NAME, 'run_shell');
  assert.equal(names(host()).includes(RUN_SHELL_TOOL_NAME), false);
  for (const gone of ['remember', 'recall', 'read_memory', 'forget', 'run_memory_shell']) {
    assert.equal(withShell.includes(gone), false, gone);
    assert.equal(LOOP_TOOL_NAMES.includes(gone), false, gone);
  }
  // Everything else is as ADR 0008 left it, with the night's change note added by ADR 0020.
  assert.deepEqual([...LOOP_TOOL_NAMES].sort(), ['ask_agent', 'cancel_self_check', 'list_self_checks', 'notify_owner',
    'reply_to_mac', 'schedule_self_check', 'set_mac_avatar_expression', 'write_change_note', 'write_handoff_note']);
});

// ADR 0047: Pi's read comes with the runner, pointed at the workspace, and last, so every definition before it stays put.
test('read is registered with a runner, after every other tool, and never without one', () => {
  const capture = async () => ({ ok: true as const, exitCode: 0, stdout: '', stdoutTruncated: false });
  const withShell = names(host({ runShell: () => ok('ran'), capture }));
  assert.equal(READ_TOOL_NAME, 'read');
  assert.equal(withShell.at(-1), READ_TOOL_NAME);
  assert.deepEqual(withShell.slice(0, -1), names(host({ runShell: () => ok('ran') })));
  assert.equal(names(host()).includes(READ_TOOL_NAME), false);
  for (const builtIn of ['bash', 'edit', 'write', 'grep', 'find', 'ls']) assert.equal(withShell.includes(builtIn), false, builtIn);
});

/**
 * The backend prefills slowly, so the tool definitions must sit on the prefix cache: the description is one fixed
 * string, never built from a setting or from what the image happens to hold (ADR 0019).
 */
test('the run_shell description is a fixed string, not built from settings or from the image', () => {
  const first = createLoopTools(host({ runShell: () => ok('a') })).find(tool => tool.name === RUN_SHELL_TOOL_NAME);
  const second = createLoopTools(host({ runShell: () => ok('b') })).find(tool => tool.name === RUN_SHELL_TOOL_NAME);
  assert.equal(first!.description, RUN_SHELL_DESCRIPTION);
  assert.equal(second!.description, RUN_SHELL_DESCRIPTION);

  // The only number in it is the one limit that does not change with the deployment, and it is the real one.
  assert.deepEqual([...RUN_SHELL_DESCRIPTION.matchAll(/\d+/g)].map(match => match[0]), [String(MAX_COMMAND_CHARS)]);
  assert.equal(MAX_COMMAND_CHARS, 8000);
});

test('the run_shell description says where writing lands and how a long command is left running', () => {
  for (const phrase of ['bash -c', '/memory', '/work', '/home/natsumi', 'ps', 'kill', '8000']) {
    assert.ok(RUN_SHELL_DESCRIPTION.includes(phrase), phrase);
  }
  // Which commands the image holds is not promised: that list is what ADR 0019 did away with.
  for (const listed of ['ripgrep', 'coreutils', 'findutils', 'gawk', 'tzdata']) {
    assert.equal(RUN_SHELL_DESCRIPTION.includes(listed), false, listed);
  }
});

test('run_shell hands the command to the host and carries its sentence back', async () => {
  const commands: string[] = [];
  const tool = createLoopTools(host({ runShell: (command: string) => { commands.push(command); return ok('動きました'); } }))
    .find(t => t.name === RUN_SHELL_TOOL_NAME)!;
  const result = await tool.execute('call-1', { command: 'rg -n 合言葉 /memory' } as never, undefined, undefined, {} as never);
  assert.deepEqual(commands, ['rg -n 合言葉 /memory']);
  assert.equal((result.content[0] as { text: string }).text, '動きました');
});

// ADR 0024: natsumi is never asked for an event ID, and there is no tool to end an event with.
test('no tool takes an event ID and finish_event is gone', () => {
  const tools = createLoopTools(host({ runShell: () => ok('ran') }));
  assert.equal(LOOP_TOOL_NAMES.includes('finish_event'), false);
  assert.equal(tools.some(tool => tool.name === 'finish_event'), false);
  for (const tool of tools) {
    const properties = Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {});
    assert.equal(properties.some(name => name.includes('event_id')), false, tool.name);
    assert.doesNotMatch(tool.description, /event_id|finish_event/, tool.name);
  }
  const shape = (name: string) => Object.keys((tools.find(tool => tool.name === name)!.parameters as { properties: object }).properties);
  assert.deepEqual(shape('reply_to_mac'), ['text', 'expression', 'images']);
  assert.deepEqual(shape('notify_owner'), ['text', 'expression']);
  assert.deepEqual(shape('write_handoff_note'), ['text']);
  assert.deepEqual(shape('write_change_note'), ['text']);
});

type Schema = { required?: string[]; properties: Record<string, { anyOf?: { const: string }[] }> };

// ADR 0026: every line she sends carries the feeling she chose for it, from the expressions' own list, and must.
test('reply_to_mac and notify_owner require an expression from the avatar expressions', () => {
  const tools = createLoopTools(host());
  const expressionTool = tools.find(tool => tool.name === 'set_mac_avatar_expression')!;
  const choices = (schema: Schema) => schema.properties.expression!.anyOf!.map(choice => choice.const);
  for (const name of ['reply_to_mac', 'notify_owner']) {
    const schema = tools.find(tool => tool.name === name)!.parameters as unknown as Schema;
    assert.deepEqual([...schema.required!].sort(), ['expression', 'text'], name);
    assert.deepEqual(choices(schema), [...EXPRESSIONS], name);
    assert.deepEqual(choices(schema), choices(expressionTool.parameters as unknown as Schema), name);
  }
});

test('reply_to_mac and notify_owner hand the text and its expression to the host', async () => {
  const sent: [string, string, string][] = [];
  const tools = createLoopTools(host({
    reply: (text, expression) => { sent.push(['reply', text, expression]); return ok('replied'); },
    notify: (text, expression) => { sent.push(['notify', text, expression]); return ok('notified'); },
  }));
  const run = (name: string, args: object) => tools.find(tool => tool.name === name)!
    .execute('call-1', args as never, undefined, undefined, {} as never);
  await run('reply_to_mac', { text: 'はい', expression: 'happy' });
  await run('notify_owner', { text: 'あのね', expression: 'worried' });
  assert.deepEqual(sent, [['reply', 'はい', 'happy'], ['notify', 'あのね', 'worried']]);
});

// ADR 0045: she may show the owner images from /work with a reply, and only with a reply; a notice stays text alone.
test('reply_to_mac takes an optional list of paths under images, and notify_owner takes none', async () => {
  const tools = createLoopTools(host());
  const reply = JSON.parse(JSON.stringify(tools.find(tool => tool.name === 'reply_to_mac')!.parameters)) as
    { required: string[]; properties: Record<string, { type: string; items?: { type: string } }> };
  assert.deepEqual([...reply.required].sort(), ['expression', 'text']);
  assert.equal(reply.properties.images!.type, 'array');
  assert.equal(reply.properties.images!.items!.type, 'string');
  const notify = tools.find(tool => tool.name === 'notify_owner')!.parameters as { properties: object };
  assert.equal('images' in notify.properties, false);

  const handed: (string[] | undefined)[] = [];
  const run = (args: object) => createLoopTools(host({ reply: (_text, _expression, images) => { handed.push(images); return ok('replied'); } }))
    .find(tool => tool.name === 'reply_to_mac')!.execute('call-1', args as never, undefined, undefined, {} as never);
  await run({ text: '描きました', expression: 'happy', images: ['/work/images/cat.png', '/work/images/dog.png'] });
  await run({ text: 'はい', expression: 'happy' });
  assert.deepEqual(handed, [['/work/images/cat.png', '/work/images/dog.png'], undefined]);
  assert.match(REPLY_TO_MAC_DESCRIPTION, /images/);
  assert.match(REPLY_TO_MAC_DESCRIPTION, /\/work/);
  assert.doesNotMatch(NOTIFY_OWNER_DESCRIPTION, /images/);
});

/** The descriptions sit on the prefix cache like run_shell's (ADR 0019): fixed strings, whatever the host holds. */
test('the reply_to_mac and notify_owner descriptions are fixed strings that tell the feeling apart from the avatar', () => {
  const described = (h: LoopToolHost, name: string) => createLoopTools(h).find(tool => tool.name === name)!.description;
  for (const [name, fixed] of [['reply_to_mac', REPLY_TO_MAC_DESCRIPTION], ['notify_owner', NOTIFY_OWNER_DESCRIPTION]] as const) {
    assert.equal(described(host(), name), fixed, name);
    assert.equal(described(host({ runShell: () => ok('ran') }), name), fixed, name);
    assert.match(fixed, /expression/, name);
    assert.match(fixed, /set_mac_avatar_expression/, name);
  }
});

// ADR 0035 and ADR 0036: one tool for every agent, there with or without any configured, and its words never move.
test('ask_agent is always registered last, with a fixed description and a required continue', () => {
  const tools = createLoopTools(host());
  assert.equal(tools.at(-1)!.name, 'ask_agent');
  assert.deepEqual(names(host({ runShell: () => ok('ran') })).at(-1), 'ask_agent');
  const ask = tools.at(-1)!;
  assert.equal(ask.description, ASK_AGENT_DESCRIPTION);
  const schema = JSON.parse(JSON.stringify(ask.parameters)) as { properties: Record<string, { type: string }>; required: string[] };
  assert.deepEqual(Object.fromEntries(Object.entries(schema.properties).map(([name, value]) => [name, value.type])),
    { agent: 'string', message: 'string', continue: 'boolean' });
  assert.deepEqual([...schema.required].sort(), ['agent', 'continue', 'message']);
  // Where the list is, and the statuses the event carries; no agent's name, no number.
  for (const phrase of ['/manual/agents/INDEX.md', 'agent_reply', 'completed', 'failed', 'input_required', 'gave_up', 'continue']) {
    assert.ok(ASK_AGENT_DESCRIPTION.includes(phrase), phrase);
  }
  assert.equal(/\d/.test(ASK_AGENT_DESCRIPTION), false);
});
