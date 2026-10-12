import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeChecks, type Judge } from '../src/eval/checks.ts';
import { parseCheck } from '../src/eval/scene.ts';
import type { RunRecord } from '../src/eval/record.ts';

const DOVE_MESSAGE = JSON.stringify({ kind: 'post', to: { file: '/sources/slack/work/dev/2026-09-27.jsonl', path: '.[36]' }, text: '見ました！' });

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    scene: 'fixture', variant: 'base', run: 1, model: { provider: 'natsumi-compatible', id: 'fixture' }, dryRun: true,
    startedAt: '2026-09-27T06:08:30.000Z', ms: 1200, outcome: 'ok', modelCalls: 3,
    tokens: { input: 300, cacheRead: 100, output: 50 }, instructions: { chars: 100, sha256: 'a'.repeat(64) },
    priorMessages: 0,
    prompt: '<events>\n{"type":"ping"}\n</events>', events: [{ type: 'ping' }],
    calls: [],
    tools: [
      { call: 1, name: 'read', args: { path: '/manual/slack.md' }, result: '# Slack\n読み方', isError: false },
      { call: 1, name: 'run_shell', args: { command: "jq -s '.[36]' /sources/slack/work/dev/2026-09-27.jsonl" },
        result: 'コマンドは終了コード 0 で終わりました。\n標準出力:\n{"from":"田中","text":"@natsumi 見て"}', isError: false },
      { call: 2, name: 'ask_agent', args: { agent: 'poppo', message: DOVE_MESSAGE, continue: false }, result: '受け付けました', isError: false },
      { call: 3, name: 'reply_to_mac', args: { text: 'おはよう', expression: 'happy' }, result: '送りました', isError: false },
    ],
    replies: [{ kind: 'reply', text: 'おはよう、今日もよろしくね', expression: 'happy' }],
    dove: [{ message: DOVE_MESSAGE, ok: true }],
    checks: [],
    ...overrides,
  };
}

const check = (id: string, spec: Record<string, unknown>) => parseCheck({ id, ...spec }, `checks.${id}`);

async function judge(spec: Record<string, unknown>, run = record(), options: Parameters<typeof judgeChecks>[2] = {}) {
  const [result] = await judgeChecks(run, [check('c', spec)], options);
  return result!;
}

test('a tool that was called passes, within the bounds given', async () => {
  assert.equal((await judge({ called: 'reply_to_mac' })).pass, true);
  assert.equal((await judge({ called: 'reply_to_mac', max: 0 })).pass, false);
  assert.equal((await judge({ called: 'notify_owner' })).pass, false);
  assert.equal((await judge({ notCalled: 'notify_owner' })).pass, true);
  assert.equal((await judge({ notCalled: 'reply_to_mac' })).pass, false);
  assert.equal((await judge({ called: 'reply_to_mac', args: { expression: '^happy$' } })).pass, true);
  assert.equal((await judge({ called: 'reply_to_mac', args: { expression: '^sad$' } })).pass, false);
});

test('shell commands are matched by a regular expression, and outputs by a string they contain', async () => {
  assert.equal((await judge({ shell: 'jq -s' })).pass, true);
  assert.equal((await judge({ shell: 'sed -n' })).pass, false);
  assert.equal((await judge({ shell: 'jq', max: 0 })).pass, false);
  assert.equal((await judge({ output: '@natsumi 見て' })).pass, true);
  assert.equal((await judge({ output: '関係ない' })).pass, false);
});

test('a file counts as read through read or through a shell command that names it', async () => {
  assert.equal((await judge({ read: '/manual/slack.md' })).pass, true);
  assert.equal((await judge({ read: '/sources/slack/work/dev/2026-09-27.jsonl' })).pass, true);
  assert.equal((await judge({ read: '/sources/slack/work/dev' })).pass, true);
  assert.equal((await judge({ notRead: '/sources/slack/work/random' })).pass, true);
  assert.equal((await judge({ notRead: '/manual/slack.md' })).pass, false);
});

test('a request to another agent is matched by the agent, the message and where it replies to', async () => {
  const file = '/sources/slack/work/dev/2026-09-27.jsonl';
  assert.equal((await judge({ asked: { agent: 'poppo', to: { file, path: '.[36]' } } })).pass, true);
  assert.equal((await judge({ asked: { agent: 'poppo', to: { file, path: '.[35]' } } })).pass, false);
  assert.equal((await judge({ asked: { agent: 'poppo', to: { file: '/sources/slack/work/dev' } } })).pass, false);
  assert.equal((await judge({ asked: { agent: 'poppo', message: '見ました' } })).pass, true);
  assert.equal((await judge({ asked: { agent: 'scholar' } })).pass, false);
});

test('replies, model calls and the way the turn ended are checked on the record', async () => {
  assert.equal((await judge({ reply: 'よろしく' })).pass, true);
  assert.equal((await judge({ reply: 'さようなら' })).pass, false);
  assert.equal((await judge({ modelCalls: { max: 3 } })).pass, true);
  assert.equal((await judge({ modelCalls: { max: 2 } })).pass, false);
  assert.equal((await judge({ finished: true })).pass, true);
  assert.equal((await judge({ finished: true }, record({ outcome: 'model-call-limit' }))).pass, false);
});

test('every result says how it was judged', async () => {
  const run = record();
  const results = await judgeChecks(run, [check('rule', { called: 'reply_to_mac' }), check('fn', { function: 'repliedHappy' }),
    check('llm', { rubric: '自然に返している' })], {
    functions: { repliedHappy: (seen: RunRecord) => seen.replies.some(reply => reply.expression === 'happy') },
    judge: { judge: async (rubric: string) => ({ pass: rubric === '自然に返している', detail: 'よい' }) },
  });
  assert.deepEqual(results.map(result => [result.id, result.by, result.pass]), [['rule', 'rule', true], ['fn', 'function', true], ['llm', 'llm', true]]);
});

test('a check that cannot be judged is left unjudged rather than failed', async () => {
  const broken: Judge = { judge: async () => { throw new Error('the judge is away'); } };
  const llm = await judge({ rubric: 'x' }, record(), { judge: broken });
  assert.equal(llm.pass, null);
  assert.match(llm.detail, /判定できません/);
  const missing = await judge({ function: 'nowhere' });
  assert.equal(missing.pass, null);
  const noJudge = await judge({ rubric: 'x' });
  assert.equal(noJudge.pass, null);
  const throwing = await judge({ function: 'boom' }, record(), { functions: { boom: () => { throw new Error('boom'); } } });
  assert.equal(throwing.pass, null);
});

test('a function may answer with a reason as well as the verdict', async () => {
  const result = await judge({ function: 'why' }, record(), { functions: { why: () => ({ pass: false, detail: '親を読んでいない' }) } });
  assert.deepEqual([result.pass, result.detail], [false, '親を読んでいない']);
});

/** Three calls of 100, 120 and 150 input tokens, ending 150, 500 and 900 ms after the event was handed over. */
const CALLS: RunRecord['calls'] = [
  { ms: 100, at: 150, stopReason: 'toolUse', input: 100, cacheRead: 0, output: 10, thinkingChars: 0, text: '' },
  { ms: 200, at: 500, stopReason: 'toolUse', input: 120, cacheRead: 80, output: 20, thinkingChars: 0, text: '' },
  { ms: 300, at: 900, stopReason: 'stop', input: 150, cacheRead: 100, output: 30, thinkingChars: 0, text: '' },
];

test('a rule met by a call says the first call it was met at, with the tokens and the time up to it', async () => {
  const run = record({ calls: CALLS, replies: [{ kind: 'reply', text: 'おはよう、今日もよろしくね', expression: 'happy', call: 3 }] });
  const at = async (spec: Record<string, unknown>) => (await judge(spec, run)).reached?.call;
  assert.deepEqual((await judge({ called: 'reply_to_mac' }, run)).reached,
    { call: 3, ms: 900, tokens: { input: 370, cacheRead: 180, output: 60 } });
  assert.deepEqual((await judge({ read: '/manual/slack.md' }, run)).reached, { call: 1, ms: 150, tokens: { input: 100, cacheRead: 0, output: 10 } });
  assert.equal(await at({ shell: 'jq -s' }), 1);
  assert.equal(await at({ output: '@natsumi 見て' }), 1);
  assert.equal(await at({ read: '/sources/slack/work/dev' }), 1);
  assert.equal(await at({ asked: { agent: 'poppo' } }), 2);
  assert.equal(await at({ reply: 'よろしく' }), 3);
});

test('a rule counted more than once is met at the call that brings the count to its min', async () => {
  const run = record({ calls: CALLS, tools: [
    { call: 1, name: 'run_shell', args: { command: 'ls /work' }, result: '', isError: false },
    { call: 2, name: 'run_shell', args: { command: 'ls /memory' }, result: '', isError: false },
    { call: 3, name: 'run_shell', args: { command: 'ls /home/natsumi' }, result: '', isError: false },
  ] });
  assert.equal((await judge({ shell: '^ls', min: 2 }, run)).reached?.call, 2);
  assert.equal((await judge({ shell: '^ls', min: 3 }, run)).reached?.call, 3);
});

test('no call is said when the rule failed, or when it is not met at a call', async () => {
  const run = record({ calls: CALLS });
  const reached = async (spec: Record<string, unknown>, options: Parameters<typeof judgeChecks>[2] = {}) =>
    (await judge(spec, run, options)).reached;
  // Failed: never met, or met and then gone past its max.
  assert.equal(await reached({ called: 'notify_owner' }), undefined);
  assert.equal(await reached({ called: 'reply_to_mac', min: 2 }), undefined);
  assert.equal(await reached({ read: '/manual/slack.md', max: 0 }), undefined);
  // Passed, but by something not done or by the whole turn: no call brings it about.
  assert.equal(await reached({ notCalled: 'notify_owner' }), undefined);
  assert.equal(await reached({ notRead: '/sources/slack/work/random' }), undefined);
  assert.equal(await reached({ modelCalls: { max: 3 } }), undefined);
  assert.equal(await reached({ finished: true }), undefined);
  assert.equal(await reached({ called: 'notify_owner', min: 0 }), undefined);
  // A reply recorded before the replies carried their call.
  assert.equal(await reached({ reply: 'よろしく' }), undefined);
  // Functions and rubrics decide on the whole record.
  assert.equal(await reached({ function: 'yes' }, { functions: { yes: () => true } }), undefined);
  assert.equal(await reached({ rubric: 'x' }, { judge: { judge: async () => ({ pass: true, detail: '' }) } }), undefined);
});
