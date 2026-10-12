import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CODEMODE_TOOL_NAME, withCodemode } from '../src/server/codemode.ts';
import { DEFAULT_CODEMODE, RESERVED_TOOL_NAMES, type DeclaredToolConfig } from '../src/server/config.ts';
import { createDeclaredTools, DECLARED_TOOL_DETAILS } from '../src/server/declared-tools.ts';
import { createLoopTools, type LoopToolHost, type ToolOutcome } from '../src/server/loop-tools.ts';
import { WorkspaceShell } from '../src/server/workspace-shell.ts';
import { startFakeRunner, type FakeRunner } from './support/fake-runner.ts';

// The tools an instance declares in its config (ADR 0075), from the definition the model is shown to the runner's answer.

const tool = (fields: Partial<DeclaredToolConfig> = {}): DeclaredToolConfig => ({
  name: 'weather', description: '天気を調べる。',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  exposure: 'model-only', command: ['/tools/weather', '--units', 'metric'], timeoutSeconds: 30, maxOutputChars: 8000, ...fields,
});

const outcome = (text: string): ToolOutcome => ({ ok: true, text });
const host = (): LoopToolHost => ({
  reply: () => outcome(''), notify: () => outcome(''), setExpression: () => outcome(''), writeHandoff: () => outcome(''),
  writeChangeNote: () => outcome(''), scheduleSelfCheck: () => outcome(''), listSelfChecks: () => outcome(''),
  cancelSelfCheck: () => outcome(''), askAgent: () => outcome(''), runShell: () => outcome(''),
  capture: async () => ({ ok: true as const, exitCode: 0, stdout: '', stdoutTruncated: false }),
});

test('no declared tool may take the name of one natsumi has, of codemode or of one of Pi\'s own', () => {
  for (const name of [...createLoopTools(host()).map(defined => defined.name), CODEMODE_TOOL_NAME, 'bash', 'edit', 'write', 'grep', 'find', 'ls']) {
    assert.ok(RESERVED_TOOL_NAMES.has(name), name);
  }
});

test('a declared tool is shown to the model as it was written, and its call goes to the runner with the arguments as JSON', async () => {
  const calls: { tool: DeclaredToolConfig; input: string }[] = [];
  const [defined] = createDeclaredTools([tool()], async (declared, input) => { calls.push({ tool: declared, input }); return outcome('晴れ'); });
  assert.equal(defined!.name, 'weather');
  assert.equal(defined!.description, '天気を調べる。');
  assert.deepEqual(JSON.parse(JSON.stringify(defined!.parameters)), tool().parameters);
  const result = await defined!.execute('call-1', { city: '東京' } as never, undefined, undefined, undefined as never);
  assert.deepEqual(result.content, [{ type: 'text', text: '晴れ' }]);
  assert.deepEqual(result.details, DECLARED_TOOL_DETAILS);
  assert.notEqual(result.isError, true);
  assert.equal(calls[0]!.tool.name, 'weather');
  assert.deepEqual(JSON.parse(calls[0]!.input), { city: '東京' });
});

test('a declared tool that failed comes back as an error the dashboard can still tell is a declared one', async () => {
  const [defined] = createDeclaredTools([tool()], async () => ({ ok: false, text: '失敗しました。' }));
  const result = await defined!.execute('call-1', { city: '東京' } as never, undefined, undefined, undefined as never);
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: '失敗しました。' }]);
  assert.deepEqual(result.details, DECLARED_TOOL_DETAILS);
});

test('with Codemode off, declared tools are the model\'s like every other tool; on, each is reached as it declares', () => {
  const tools = [...createLoopTools(host()), ...createDeclaredTools([tool({ name: 'only_model' }), tool({ name: 'both', exposure: 'direct' }),
    tool({ name: 'scripts', exposure: 'codemode' })], async () => outcome(''))];
  const exposures = new Map([['only_model', 'model-only' as const], ['both', 'direct' as const], ['scripts', 'codemode' as const]]);
  const off = withCodemode(tools, DEFAULT_CODEMODE, () => undefined, exposures);
  assert.deepEqual(off.extensions, []);
  assert.equal(off.tools.declared, undefined);
  assert.ok(off.tools.definitions.every(defined => !('exposure' in defined)));

  const on = withCodemode(tools, { ...DEFAULT_CODEMODE, enabled: true }, () => undefined, exposures);
  const exposure = Object.fromEntries(on.tools.definitions.map(defined => [defined.name, (defined as { exposure?: string }).exposure]));
  assert.equal(exposure.only_model, 'model-only');
  assert.equal(exposure.both, 'direct');
  assert.equal(exposure.scripts, 'codemode');
  assert.equal(exposure.run_shell, 'direct');
  assert.equal(on.tools.names.at(-1), CODEMODE_TOOL_NAME);
  // The one for scripts alone is left off what the model is shown; the rest are declared as they were.
  assert.deepEqual(on.tools.declared, on.tools.names.filter(name => name !== 'scripts'));

  // Declaring none leaves Codemode as it was without them: nothing is held back from the declarations.
  const plain = withCodemode(createLoopTools(host()), { ...DEFAULT_CODEMODE, enabled: true }, () => undefined, new Map());
  assert.equal(plain.tools.declared, undefined);
});

// ── The runner's side, through a stand-in that speaks the same protocol ──

async function withRunner(programs: Record<string, string>, body: (runner: FakeRunner, shell: WorkspaceShell) => Promise<void>,
  options: { commandOnly?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'natsumi-declared-'));
  const runner = await startFakeRunner({ dir, programs, ...options });
  try { await body(runner, new WorkspaceShell({ socketPath: runner.path, timeZone: 'Asia/Tokyo' })); } finally {
    await runner.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const request = (fields: Partial<{ argv: string[]; input: string; timeoutSeconds: number; maxOutputChars: number }> = {}) => ({
  argv: ['/tools/weather', '--units', 'metric'], input: '{"city":"東京"}', timeoutSeconds: 5, maxOutputChars: 8000, ...fields,
});

test('the runner is sent the argv, the arguments on stdin, the timeout and the time zone, and stdout is the result', async () => {
  await withRunner({ '/tools/weather': 'read -r line; echo "args $*"; echo "in $line"; echo noise >&2' }, async (runner, shell) => {
    const result = await shell.runTool(request());
    assert.deepEqual(result, { ok: true, text: 'args --units metric\nin {"city":"東京"}\n' });
    assert.deepEqual(runner.tools, [{ argv: ['/tools/weather', '--units', 'metric'], stdin: '{"city":"東京"}', timeoutSeconds: 5 }]);
    assert.deepEqual(runner.timeZones, ['Asia/Tokyo']);
    assert.deepEqual(runner.commands, []);
  });
});

test('an empty stdout still says something, and a long one is cut at the tool\'s limit with a note', async () => {
  await withRunner({ '/tools/quiet': 'true', '/tools/loud': 'printf "あ%.0s" $(seq 1 50)' }, async (_runner, shell) => {
    assert.deepEqual(await shell.runTool(request({ argv: ['/tools/quiet'] })), { ok: true, text: '（出力は空でした）' });
    const loud = await shell.runTool(request({ argv: ['/tools/loud'], maxOutputChars: 10 }));
    assert.equal(loud.ok, true);
    assert.equal(loud.text, `${'あ'.repeat(10)}\n（出力が長いので先頭の 10 文字だけを返しています）`);
  });
});

test('an exit code other than 0 is a failure that says the code and what the tool wrote', async () => {
  await withRunner({ '/tools/broken': 'echo partial; echo "no city" >&2; exit 3' }, async (_runner, shell) => {
    const result = await shell.runTool(request({ argv: ['/tools/broken'] }));
    assert.equal(result.ok, false);
    assert.match(result.text, /終了コード 3/);
    assert.match(result.text, /標準出力:\npartial/);
    assert.match(result.text, /標準エラー出力:\nno city/);
  });
});

test('past its timeout the tool is stopped and the call fails', async () => {
  await withRunner({ '/tools/slow': 'echo started; sleep 5' }, async (_runner, shell) => {
    const started = Date.now();
    const result = await shell.runTool(request({ argv: ['/tools/slow'], timeoutSeconds: 1 }));
    assert.ok(Date.now() - started < 4000);
    assert.equal(result.ok, false);
    assert.match(result.text, /1 秒で終わらなかったので止めました/);
    assert.match(result.text, /started/);
  });
});

test('a program missing from /tools fails, and a runner older than the server says the images differ', async () => {
  await withRunner({}, async (_runner, shell) => {
    const result = await shell.runTool(request({ argv: ['/tools/missing'] }));
    assert.equal(result.ok, false);
    assert.match(result.text, /終了コード 127/);
  });
  await withRunner({ '/tools/weather': 'echo ok' }, async (_runner, shell) => {
    const result = await shell.runTool(request());
    assert.equal(result.ok, false);
    assert.match(result.text, /作業環境の image/);
  }, { commandOnly: true });
});

test('arguments too large for one request never leave the server', async () => {
  await withRunner({ '/tools/weather': 'cat' }, async (runner, shell) => {
    const result = await shell.runTool(request({ input: JSON.stringify({ text: 'あ'.repeat(30_000) }) }));
    assert.equal(result.ok, false);
    assert.match(result.text, /引数が大きすぎます/);
    assert.deepEqual(runner.tools, []);
  });
});

test('an unreachable runner fails the call without running anything', async () => {
  const shell = new WorkspaceShell({ socketPath: join(tmpdir(), 'natsumi-no-runner.sock') });
  const result = await shell.runTool(request());
  assert.equal(result.ok, false);
  assert.match(result.text, /接続できません/);
});
