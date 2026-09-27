import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { endpointsOf, isolatedEnvironment, runIsolated, startRelay } from '../src/eval/isolation.ts';
import { bwrapAvailable } from '../src/eval/workspace.ts';
import type { ModelFile } from '../src/eval/model-file.ts';

const REPOSITORY = join(import.meta.dirname, '..');
const skip = (await bwrapAvailable()) ? false : 'bubblewrap cannot make a sandbox here';

/** A TCP server on this machine's loopback that says who it is and closes. */
async function speaker(word: string): Promise<{ port: number; server: Server }> {
  const server = createServer(socket => socket.end(word));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  return { port: (server.address() as { port: number }).port, server };
}

// Run inside the sandbox: every way out it can think of, and one way it is allowed. Prints what happened as JSON.
const PROBE = `
import { connect } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { startBridge } from ${JSON.stringify(join(REPOSITORY, 'src', 'eval', 'isolation.ts'))};
const [allowed, denied, writable, readonly] = process.argv.slice(2);
const env = JSON.parse(process.env.NATSUMI_EVAL_ISOLATED);
await startBridge(env.relay);
const result = {};
const tcp = (host, port) => new Promise(done => {
  const socket = connect({ host, port: Number(port) });
  socket.setTimeout(3000, () => { socket.destroy(); done('timeout'); });
  let text = '';
  socket.on('data', chunk => { text += chunk; });
  socket.on('end', () => done('reached:' + text));
  socket.on('error', error => done(error.code));
});
const tunnel = (target) => new Promise(done => {
  const socket = connect({ host: '127.0.0.1', port: 3128 });
  let text = '';
  socket.on('connect', () => socket.write('CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\n\\r\\n'));
  socket.on('data', chunk => { text += chunk; });
  socket.on('close', () => done(text));
  socket.on('error', error => done(error.code));
});
result.direct = await tcp('127.0.0.1', allowed);
result.outside = await tcp('192.0.2.1', 443);
result.tunnel = await tunnel('127.0.0.1:' + allowed);
result.refused = await tunnel('127.0.0.1:' + denied);
result.fetch = await fetch('https://denied.example.invalid/').then(() => 'reached', error => String(error.cause?.code ?? error.message));
result.write = await writeFile(writable + '/ok', 'x').then(() => 'ok', error => error.code);
result.readonly = await writeFile(readonly + '/no', 'x').then(() => 'ok', error => error.code);
result.secret = process.env.SLACK_BOT_TOKEN ?? null;
console.log(JSON.stringify(result));
process.exit(0);
`;

test('isolated, the evaluation reaches nothing but the relay, and the relay only the endpoints allowed', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-isolation-'));
  const allowed = await speaker('ALLOWED');
  const denied = await speaker('DENIED');
  try {
    const writable = join(root, 'writable');
    const readonly = join(root, 'readonly');
    await mkdir(writable);
    await mkdir(readonly);
    await writeFile(join(root, 'probe.mjs'), PROBE);
    const relaySocket = join(writable, 'relay.sock');
    const relay = await startRelay({ socketPath: relaySocket, allow: [`127.0.0.1:${allowed.port}`] });
    const out = join(writable, 'out.json');
    const env = isolatedEnvironment({ relaySocket, runnerSocket: join(writable, 'runner.sock'), tmp: writable, pass: {} });
    // The caller's own secrets are not handed in.
    process.env.SLACK_BOT_TOKEN = 'fixture-not-a-token';
    let code: number;
    try {
      code = await runIsolated({ command: ['sh', '-c', `"${process.execPath}" "${join(root, 'probe.mjs')}" "$@" > "${out}"`, 'probe',
        String(allowed.port), String(denied.port), writable, readonly], writable: [writable], env, cwd: root });
    } finally { delete process.env.SLACK_BOT_TOKEN; }
    await relay.close();
    assert.equal(code, 0);
    const result = JSON.parse(await (await import('node:fs/promises')).readFile(out, 'utf8'));
    // The machine's loopback is not the sandbox's, and there is no route anywhere.
    assert.equal(result.direct, 'ECONNREFUSED');
    assert.match(result.outside, /ENETUNREACH|EHOSTUNREACH|timeout/);
    // Through the relay: the allowed endpoint answers, any other is turned back.
    assert.match(result.tunnel, /^HTTP\/1\.1 200 [^]*ALLOWED$/);
    assert.match(result.refused, /^HTTP\/1\.1 403/);
    // Node's own fetch goes through the relay too, which is how the models are reached; this name is refused.
    assert.notEqual(result.fetch, 'reached');
    assert.ok(relay.refused.includes('denied.example.invalid:443'), relay.refused.join(','));
    assert.deepEqual(relay.passed, [`127.0.0.1:${allowed.port}`]);
    assert.equal(result.write, 'ok');
    assert.equal(result.readonly, 'EROFS');
    assert.equal(result.secret, null);
  } finally {
    allowed.server.close();
    denied.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the way out is the endpoints of the models named, and a provider with none known is refused', () => {
  const compatible = { target: { provider: 'natsumi-compatible', model: 'm' }, compatible: true, thinking: 'on', shown: { provider: 'x', id: 'm' },
    endpoint: { baseUrl: 'https://llm.example.net:8443/v1', apiKey: { env: 'K' } } } as unknown as ModelFile;
  const plus = { target: { provider: 'openai-codex', model: 'gpt-6-sol' }, compatible: false, thinking: 'on', shown: { provider: 'x', id: 'm' },
    authPath: '/x/auth.json' } as ModelFile;
  assert.deepEqual(endpointsOf([compatible, plus, plus]), ['auth.openai.com:443', 'chatgpt.com:443', 'llm.example.net:8443']);
  assert.deepEqual(endpointsOf([]), []);
  assert.throws(() => endpointsOf([{ ...plus, target: { provider: 'somewhere', model: 'x' } }]), /somewhere/);
});
