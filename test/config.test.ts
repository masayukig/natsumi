import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigError, envReference, LETS_ENCRYPT_PRODUCTION, LETS_ENCRYPT_STAGING, loadConfig, parseConfig } from '../src/server/config.ts';

const pi = () => ({
  agentDirectory: '/srv/natsumi-pi/agent',
  sessionDirectory: '/srv/natsumi-pi/sessions',
  authPath: '/srv/natsumi-pi/agent/auth.json',
  model: { provider: 'openai-codex', id: 'gpt-5.5' },
  voiceEnabled: false,
});

const tls = () => ({ certFile: '/run/secrets/natsumi-tls-cert', keyFile: '/run/secrets/natsumi-tls-key' });
const listen = () => ({ host: '::', port: 8443, tls: tls() });
const github = () => ({
  clientId: 'Iv1.fixtureclient',
  clientSecretEnv: 'NATSUMI_GITHUB_CLIENT_SECRET',
  callbackUrl: 'https://natsumi.example.test/auth/github/callback',
  allowedUserId: 4242001,
});
const SCHEDULE_DEFAULTS = {
  memoryFileMaxChars: 32000,
  alwaysMemoryMaxChars: 2000,
  shellWaitSeconds: 75,
  workspaceSizeWarnBytes: 1073741824,
  awakeHours: { start: '08:00', end: '23:00' },
  pingIntervalMinutes: 30,
  selfCheck: { minDelayMinutes: 5, maxDelayDays: 7, maxPending: 5, maxPerDay: 20 },
  expressionResetMinutes: 3,
  reviewModelCalls: 40,
  reviewTimeoutMinutes: 30,
  eventModelCalls: 8,
  eventTimeoutMinutes: 10,
  turnFold: 'off',
};
const base = () => ({ pi: pi(), publicOrigin: 'https://natsumi.example.test', listen: listen(), github: github() });

function rejects(raw: unknown, path: string, reason?: RegExp) {
  assert.throws(() => parseConfig(raw), (error: unknown) => {
    assert.ok(error instanceof ConfigError, String(error));
    assert.equal(error.path, path);
    if (reason) assert.match(error.message, reason);
    return true;
  });
}

test('a valid config becomes a typed server config', () => {
  assert.deepEqual(parseConfig(base()), {
    pi: { agentDirectory: pi().agentDirectory, sessionDirectory: pi().sessionDirectory, authPath: pi().authPath, voiceEnabled: false,
      routes: [{ name: 'default', model: pi().model, compactionThreshold: 60000 }], defaultRoute: 'default', thinking: 'on' },
    publicOrigin: 'https://natsumi.example.test',
    listen: { host: '::', port: 8443, tls: tls() },
    github: {
      clientId: 'Iv1.fixtureclient',
      clientSecret: { env: 'NATSUMI_GITHUB_CLIENT_SECRET' },
      callbackUrl: 'https://natsumi.example.test/auth/github/callback',
      allowedUserId: 4242001,
    },
    loop: { timeZone: 'UTC', nightlyRotationAt: '04:00', compactionThreshold: 60000, compactionKeepRecent: 20000, ...SCHEDULE_DEFAULTS },
  });
  const { clientSecretEnv: _, ...rest } = github();
  assert.deepEqual(parseConfig({ ...base(), github: { ...rest, clientSecretFile: '/run/secrets/github-client-secret' } }).github.clientSecret,
    { file: '/run/secrets/github-client-secret' });
});

test('the shipped example config is valid', async () => {
  const config = await loadConfig(new URL('../config.example.json', import.meta.url).pathname);
  assert.equal(config.pi.voiceEnabled, false);
  assert.notEqual(config.listen.tls, false);
});

test('invalid values name the offending setting', () => {
  rejects(null, 'config', /object/);
  rejects({}, 'pi', /required/);
  rejects({ ...base(), pi: { ...pi(), agentDirectory: 'relative/agent' } }, 'pi.agentDirectory', /absolute/);
  rejects({ ...base(), pi: { ...pi(), sessionDirectory: '' } }, 'pi.sessionDirectory');
  rejects({ ...base(), pi: { ...pi(), authPath: 42 } }, 'pi.authPath');
  rejects({ ...base(), pi: { ...pi(), model: { provider: 'openai-codex' } } }, 'pi.model.id', /required/);
  rejects({ ...base(), pi: { ...pi(), voiceEnabled: true } }, 'pi.voiceEnabled', /not supported/);
});

test('thinking is on unless the config switches it off', () => {
  assert.equal(parseConfig(base()).pi.thinking, 'on');
  assert.equal(parseConfig({ ...base(), pi: { ...pi(), thinking: 'off' } }).pi.thinking, 'off');
  for (const thinking of [true, 'medium', '', null]) rejects({ ...base(), pi: { ...pi(), thinking } }, 'pi.thinking', /on.*off/);
});

test('the loop section sets the time zone, the nightly switch and the compaction limit, each with a default', () => {
  const loop = { timeZone: 'Asia/Tokyo', nightlyRotationAt: '03:30', compactionThreshold: 80000, compactionKeepRecent: 10000, ...SCHEDULE_DEFAULTS };
  assert.deepEqual(parseConfig({ ...base(), loop }).loop, loop);
  assert.deepEqual(parseConfig({ ...base(), loop: { timeZone: 'Asia/Tokyo' } }).loop,
    { timeZone: 'Asia/Tokyo', nightlyRotationAt: '04:00', compactionThreshold: 60000, compactionKeepRecent: 20000, ...SCHEDULE_DEFAULTS });
  assert.equal(parseConfig({ ...base(), loop: { nightlyRotationAt: false } }).loop.nightlyRotationAt, false);
  rejects({ ...base(), loop: { timeZone: 'Mars/Olympus' } }, 'loop.timeZone', /time zone/);
  for (const time of ['4:00', '24:00', '04:60', '', true]) rejects({ ...base(), loop: { nightlyRotationAt: time } }, 'loop.nightlyRotationAt', /HH:MM/);
  for (const tokens of [0, 1.5, -1, '60000', 5000]) rejects({ ...base(), loop: { compactionThreshold: tokens } }, 'loop.compactionThreshold');
  rejects({ ...base(), loop: { compactionThreshold: 20000, compactionKeepRecent: 20000 } }, 'loop.compactionKeepRecent', /smaller/);
});

test('the loop section sets the awake hours, the ping, the self-check limits and the expression reset, each with a default', () => {
  const schedule = {
    awakeHours: { start: '22:00', end: '06:30' },
    pingIntervalMinutes: 45,
    selfCheck: { minDelayMinutes: 10, maxDelayDays: 3, maxPending: 2, maxPerDay: 8 },
    expressionResetMinutes: 1,
  };
  assert.deepEqual(parseConfig({ ...base(), loop: schedule }).loop, { ...parseConfig(base()).loop, ...schedule });
  assert.equal(parseConfig({ ...base(), loop: { pingIntervalMinutes: false } }).loop.pingIntervalMinutes, false);
  // Limits left out keep their defaults.
  assert.deepEqual(parseConfig({ ...base(), loop: { selfCheck: { maxPerDay: 3 } } }).loop.selfCheck,
    { ...SCHEDULE_DEFAULTS.selfCheck, maxPerDay: 3 });
  for (const time of ['8:00', '24:00', 800, undefined]) {
    rejects({ ...base(), loop: { awakeHours: { start: time, end: '23:00' } } }, 'loop.awakeHours.start', /HH:MM/);
  }
  rejects({ ...base(), loop: { awakeHours: { start: '08:00', end: '08:00' } } }, 'loop.awakeHours.end', /differ/);
  rejects({ ...base(), loop: { awakeHours: { start: '08:00', end: '23:00', timeZone: 'UTC' } } }, 'loop.awakeHours.timeZone', /unknown/);
  for (const minutes of [0, 4, 1.5, '30', true]) rejects({ ...base(), loop: { pingIntervalMinutes: minutes } }, 'loop.pingIntervalMinutes');
  for (const minutes of [0, -1, 2.5, '3']) rejects({ ...base(), loop: { expressionResetMinutes: minutes } }, 'loop.expressionResetMinutes');
  for (const key of ['minDelayMinutes', 'maxDelayDays', 'maxPending', 'maxPerDay']) {
    for (const value of [0, -1, 1.5, '5']) rejects({ ...base(), loop: { selfCheck: { [key]: value } } }, `loop.selfCheck.${key}`);
  }
  rejects({ ...base(), loop: { selfCheck: { minDelayMinutes: 1440 * 7, maxDelayDays: 7 } } }, 'loop.selfCheck.minDelayMinutes', /shorter/);
  rejects({ ...base(), loop: { selfCheck: { perHour: 3 } } }, 'loop.selfCheck.perHour', /unknown/);
});

test('the loop section sets the nightly review limits, each with a default (ADR 0018)', () => {
  // The review reads and rewrites memory file by file, so it gets more calls and more time than an ordinary turn.
  const defaults = parseConfig(base()).loop;
  assert.equal(defaults.reviewModelCalls, 40);
  assert.equal(defaults.reviewTimeoutMinutes, 30);
  const set = parseConfig({ ...base(), loop: { reviewModelCalls: 12, reviewTimeoutMinutes: 5 } }).loop;
  assert.deepEqual([set.reviewModelCalls, set.reviewTimeoutMinutes], [12, 5]);
  for (const calls of [0, -1, 1.5, '40', true]) rejects({ ...base(), loop: { reviewModelCalls: calls } }, 'loop.reviewModelCalls');
  for (const minutes of [0, -1, 2.5, '30', false]) rejects({ ...base(), loop: { reviewTimeoutMinutes: minutes } }, 'loop.reviewTimeoutMinutes');
});

// ADR 0047: folding is off until the owner turns it on, in the config or on the command line.
test('the loop section says whether ended turns are folded, off by default', () => {
  assert.equal(parseConfig(base()).loop.turnFold, 'off');
  assert.equal(parseConfig({ ...base(), loop: { turnFold: 'on' } }).loop.turnFold, 'on');
  for (const value of [true, 'yes', 1]) rejects({ ...base(), loop: { turnFold: value } }, 'loop.turnFold', /"on" or "off"/);
});

test('the loop section sets an ordinary turn\'s limits, each with a default', () => {
  // The defaults are the limits an ordinary turn has always had; a deployment raises them in its config.
  const defaults = parseConfig(base()).loop;
  assert.equal(defaults.eventModelCalls, 8);
  assert.equal(defaults.eventTimeoutMinutes, 10);
  const set = parseConfig({ ...base(), loop: { eventModelCalls: 20, eventTimeoutMinutes: 15 } }).loop;
  assert.deepEqual([set.eventModelCalls, set.eventTimeoutMinutes], [20, 15]);
  for (const calls of [0, -1, 1.5, '8', true]) rejects({ ...base(), loop: { eventModelCalls: calls } }, 'loop.eventModelCalls');
  for (const minutes of [0, -1, 2.5, '10', false]) rejects({ ...base(), loop: { eventTimeoutMinutes: minutes } }, 'loop.eventTimeoutMinutes');
});

test('the workspace shell is off unless the loop names the runner socket by absolute path', () => {
  assert.equal('workspaceSocket' in parseConfig(base()).loop, false);
  assert.equal(parseConfig({ ...base(), loop: { workspaceSocket: '/run/natsumi-workspace/runner.sock' } }).loop.workspaceSocket,
    '/run/natsumi-workspace/runner.sock');
  for (const socket of ['run/runner.sock', '', 42]) rejects({ ...base(), loop: { workspaceSocket: socket } }, 'loop.workspaceSocket');
  rejects({ ...base(), loop: { rotateAt: '04:00' } }, 'loop.rotateAt', /unknown/);
});

// The rename of ADR 0019. Ignoring the old name would leave the shell silently switched off.
test('the old memoryShellSocket name stops startup and says what it became', () => {
  rejects({ ...base(), loop: { memoryShellSocket: '/run/natsumi-tools/runner.sock' } }, 'loop.memoryShellSocket',
    /renamed to workspaceSocket/);
});

test('the shell wait and the size warning have defaults and bounds', () => {
  const defaults = parseConfig(base()).loop;
  assert.equal(defaults.shellWaitSeconds, 75);
  assert.equal(defaults.workspaceSizeWarnBytes, 1073741824);
  const set = parseConfig({ ...base(), loop: { shellWaitSeconds: 120, workspaceSizeWarnBytes: 2 * 1024 * 1024 } }).loop;
  assert.equal(set.shellWaitSeconds, 120);
  assert.equal(set.workspaceSizeWarnBytes, 2 * 1024 * 1024);
  // Shorter than the runner's own response limit, and the answer never comes back.
  for (const seconds of [0, 9, 1.5, '75', true]) rejects({ ...base(), loop: { shellWaitSeconds: seconds } }, 'loop.shellWaitSeconds');
  for (const bytes of [0, 1023, 1.5, '1024']) rejects({ ...base(), loop: { workspaceSizeWarnBytes: bytes } }, 'loop.workspaceSizeWarnBytes');
});

test('the memory repository defaults to the data directory, and a file limit too small is refused', () => {
  // Left out, the loop puts the repository in the data directory: the config cannot name that path.
  assert.equal('memoryRepository' in parseConfig(base()).loop, false);
  assert.equal(parseConfig({ ...base(), loop: { memoryRepository: '/srv/natsumi-memory' } }).loop.memoryRepository, '/srv/natsumi-memory');
  for (const path of ['memory', '', 42]) rejects({ ...base(), loop: { memoryRepository: path } }, 'loop.memoryRepository');
  assert.equal(parseConfig(base()).loop.memoryFileMaxChars, 32000);
  assert.equal(parseConfig({ ...base(), loop: { memoryFileMaxChars: 8000 } }).loop.memoryFileMaxChars, 8000);
  for (const chars of [0, 999, 1.5, '32000', true]) rejects({ ...base(), loop: { memoryFileMaxChars: chars } }, 'loop.memoryFileMaxChars');
});

// The always-memory rides in every prompt, so it has a limit of its own, far below one memory file's (ADR 0020).
test('the always-memory has its own smaller limit, with a default and a floor', () => {
  assert.equal(parseConfig(base()).loop.alwaysMemoryMaxChars, 2000);
  assert.equal(parseConfig({ ...base(), loop: { alwaysMemoryMaxChars: 800 } }).loop.alwaysMemoryMaxChars, 800);
  for (const chars of [0, 199, 1.5, '2000', true]) rejects({ ...base(), loop: { alwaysMemoryMaxChars: chars } }, 'loop.alwaysMemoryMaxChars');
});

test('an OpenAI-compatible endpoint is chosen explicitly, with its key referenced by env or file', () => {
  const endpoint = { baseUrl: 'https://llm.example.test/v1', apiKeyEnv: 'NATSUMI_PI_API_KEY' };
  const compatible = { ...pi(), model: { provider: 'natsumi-compatible', id: 'fixture-model' }, compatible: endpoint };
  assert.deepEqual(parseConfig({ ...base(), pi: compatible }).pi.routes[0]!.compatible,
    { baseUrl: 'https://llm.example.test/v1', apiKey: { env: 'NATSUMI_PI_API_KEY' }, contextWindow: 128000 });
  const { apiKeyEnv: _key, ...noKey } = endpoint;
  assert.deepEqual(parseConfig({ ...base(), pi: { ...compatible, compatible: { ...noKey, apiKeyFile: '/run/secrets/pi-api-key' } } }).pi.routes[0]!.compatible?.apiKey,
    { file: '/run/secrets/pi-api-key' });
  assert.equal(parseConfig({ ...base(), pi: { ...compatible, compatible: { ...endpoint, baseUrl: 'http://127.0.0.1:8080/v1' } } }).pi.routes[0]!.compatible?.baseUrl,
    'http://127.0.0.1:8080/v1');
  assert.equal('compatible' in parseConfig(base()).pi.routes[0]!, false);

  rejects({ ...base(), pi: { ...compatible, compatible: noKey } }, 'pi.compatible.apiKeyEnv', /apiKeyFile/);
  rejects({ ...base(), pi: { ...compatible, compatible: { ...endpoint, apiKeyFile: '/run/secrets/pi-api-key' } } }, 'pi.compatible.apiKeyFile', /only one/);
  rejects({ ...base(), pi: { ...compatible, compatible: { ...endpoint, baseUrl: 'http://llm.example.test/v1' } } }, 'pi.compatible.baseUrl', /https/);
  rejects({ ...base(), pi: { ...compatible, compatible: { ...endpoint, timeout: 5 } } }, 'pi.compatible.timeout', /unknown/);
  rejects({ ...base(), pi: { ...compatible, compatible: { ...endpoint, apiKey: 'sk-fixture' } } }, 'pi.compatible.apiKey', /secret/);
  // No implicit route: the compatible provider and the compatible section always come together.
  rejects({ ...base(), pi: { ...pi(), compatible: endpoint } }, 'pi.model.provider', /natsumi-compatible/);
  const { compatible: _endpoint, ...withoutEndpoint } = compatible;
  rejects({ ...base(), pi: withoutEndpoint }, 'pi.compatible', /required/);
});

// The window is what Pi believes the model can hold; the endpoint's own may be far larger (a llama.cpp slot).
test('a compatible endpoint\'s context window is 128000 unless set, and must be a positive integer', () => {
  const compatible = (endpoint: Record<string, unknown>) => ({ ...base(), pi: { ...pi(),
    model: { provider: 'natsumi-compatible', id: 'fixture-model' },
    compatible: { baseUrl: 'https://llm.example.test/v1', apiKeyEnv: 'NATSUMI_PI_API_KEY', ...endpoint } } });
  assert.equal(parseConfig(compatible({})).pi.routes[0]!.compatible?.contextWindow, 128000);
  assert.equal(parseConfig(compatible({ contextWindow: 262144 })).pi.routes[0]!.compatible?.contextWindow, 262144);
  for (const tokens of [0, -1, 1.5, '262144', null, true]) {
    rejects(compatible({ contextWindow: tokens }), 'pi.compatible.contextWindow', /integer/);
  }
});

// Compaction runs only between turns, so the context must still fit when a turn starts just under the threshold:
// the turn's own growth, the longest reply, and the margin Pi keeps below the window when it sizes a request.
test('a compaction threshold the context window cannot hold through one more turn is refused at startup', () => {
  const config = (contextWindow: number | undefined, compactionThreshold: number) => ({ ...base(), pi: { ...pi(),
    model: { provider: 'natsumi-compatible', id: 'fixture-model' },
    compatible: { baseUrl: 'https://llm.example.test/v1', apiKeyEnv: 'NATSUMI_PI_API_KEY',
      ...(contextWindow === undefined ? {} : { contextWindow }) } },
    loop: { compactionThreshold } });
  // Room above the threshold: a turn's growth (32768), the longest reply (16384) and Pi's margin (4096).
  const room = 32768 + 16384 + 4096;
  assert.equal(parseConfig(config(undefined, 60000)).loop.compactionThreshold, 60000);
  assert.equal(parseConfig(config(128000, 128000 - room)).loop.compactionThreshold, 128000 - room);
  rejects(config(128000, 128000 - room + 1), 'loop.compactionThreshold', /pi\.compatible\.contextWindow/);
  rejects(config(undefined, 128000), 'loop.compactionThreshold', /pi\.compatible\.contextWindow/);
  assert.equal(parseConfig(config(262144, 128000)).loop.compactionThreshold, 128000);
  // A subscription model's window comes from Pi's own model definition, which the config does not know.
  assert.equal(parseConfig({ ...base(), loop: { compactionThreshold: 200000 } }).loop.compactionThreshold, 200000);
});

test('the connection and GitHub sections are required', () => {
  const { publicOrigin: _o, ...noOrigin } = base();
  rejects(noOrigin, 'publicOrigin', /required/);
  const { listen: _l, ...noListen } = base();
  rejects(noListen, 'listen', /required/);
  const { github: _g, ...noGitHub } = base();
  rejects(noGitHub, 'github', /required/);
});

test('unknown settings are rejected instead of silently ignored', () => {
  rejects({ ...base(), wiki: { checkout: '/srv/wiki' } }, 'wiki', /unknown/);
  rejects({ ...base(), pi: { ...pi(), agentDir: '/srv/natsumi-pi/agent' } }, 'pi.agentDir', /unknown/);
  rejects({ ...base(), listen: { ...listen(), backlog: 5 } }, 'listen.backlog', /unknown/);
  rejects({ ...base(), github: { ...github(), allowedLogin: 'fictional-owner' } }, 'github.allowedLogin', /unknown/);
});

test('the data directory is chosen on the command line, not in the config', () => {
  rejects({ ...base(), dataDirectory: '/srv/natsumi-data' }, 'dataDirectory', /--data-dir/);
});

test('plaintext listening is refused unless the host is loopback', () => {
  for (const host of ['::', '0.0.0.0', '192.0.2.10', '2001:db8::10']) {
    rejects({ ...base(), listen: { host, port: 8080, tls: false } }, 'listen.tls', /loopback/);
  }
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    assert.equal(parseConfig({ ...base(), listen: { host, port: 8080, tls: false } }).listen.tls, false);
  }
  rejects({ ...base(), listen: { host: '::', port: 8443 } }, 'listen.tls', /required/);
  rejects({ ...base(), listen: { host: '::', port: 8443, tls: true } }, 'listen.tls');
  rejects({ ...base(), listen: { ...listen(), tls: { certFile: tls().certFile } } }, 'listen.tls.keyFile', /required/);
  rejects({ ...base(), listen: { ...listen(), tls: { ...tls(), certFile: 'cert.pem' } } }, 'listen.tls.certFile');
});

test('plaintext beyond loopback is accepted only when behindProxy says TLS ends in front of the server (ADR 0033)', () => {
  for (const host of ['::', '0.0.0.0', '192.0.2.10']) {
    assert.deepEqual(parseConfig({ ...base(), listen: { host, port: 8080, tls: false, behindProxy: true } }).listen,
      { host, port: 8080, tls: false, behindProxy: true });
  }
  // Loopback does not need it, and may still say it.
  assert.deepEqual(parseConfig({ ...base(), listen: { host: '127.0.0.1', port: 8080, tls: false, behindProxy: true } }).listen,
    { host: '127.0.0.1', port: 8080, tls: false, behindProxy: true });
  // false is the same as leaving it out: the ADR 0006 refusal stands.
  rejects({ ...base(), listen: { host: '::', port: 8080, tls: false, behindProxy: false } }, 'listen.tls', /loopback/);
  assert.deepEqual(parseConfig({ ...base(), listen: { host: '::1', port: 8080, tls: false, behindProxy: false } }).listen,
    { host: '::1', port: 8080, tls: false });
  rejects({ ...base(), listen: { host: '::', port: 8080, tls: false, behindProxy: 'yes' } }, 'listen.behindProxy', /true or false/);
  // The server terminating TLS itself and a proxy terminating it in front cannot both be meant.
  rejects({ ...base(), listen: { ...listen(), behindProxy: true } }, 'listen.behindProxy', /tls: false/);
  rejects({ ...base(), listen: { ...acmeListen(), behindProxy: true } }, 'listen.behindProxy', /tls: false/);
});

const acmeListen = (acme: unknown = {}) => ({ host: '::', port: 443, tls: { acme } });

test('ACME can be chosen instead of certificate files, defaulting to Let\'s Encrypt production on port 80', () => {
  assert.deepEqual(parseConfig({ ...base(), listen: acmeListen() }).listen,
    { host: '::', port: 443, tls: { acme: { directoryUrl: LETS_ENCRYPT_PRODUCTION, httpPort: 80 } } });
  assert.equal(LETS_ENCRYPT_PRODUCTION, 'https://acme-v02.api.letsencrypt.org/directory');
  const staging = { directoryUrl: LETS_ENCRYPT_STAGING, contactEmail: 'owner@example.test', httpPort: 8080 };
  assert.deepEqual(parseConfig({ ...base(), listen: acmeListen(staging) }).listen.tls, { acme: staging });
  // A local test CA over plain http is accepted only on loopback, like publicOrigin.
  const local = { directoryUrl: 'http://127.0.0.1:14000/directory', httpPort: 0 };
  assert.deepEqual(parseConfig({ ...base(), listen: acmeListen(local) }).listen.tls, { acme: local });
});

test('ACME and certificate files cannot be combined, and ACME settings are validated', () => {
  rejects({ ...base(), listen: { ...listen(), tls: { ...tls(), acme: {} } } }, 'listen.tls', /either/);
  rejects({ ...base(), listen: { ...listen(), tls: { certFile: tls().certFile, acme: {} } } }, 'listen.tls', /either/);
  rejects({ ...base(), listen: acmeListen('yes') }, 'listen.tls.acme', /object/);
  rejects({ ...base(), listen: acmeListen({ challenge: 'dns-01' }) }, 'listen.tls.acme.challenge', /unknown/);
  for (const directoryUrl of ['not a url', 'ftp://acme.example.test/directory', 'http://acme.example.test/directory',
    'https://user:pw@acme.example.test/directory', 'https://acme.example.test/directory#x', 42, '']) {
    rejects({ ...base(), listen: acmeListen({ directoryUrl }) }, 'listen.tls.acme.directoryUrl');
  }
  for (const contactEmail of ['mailto:owner@example.test', 'not-an-email', '', 'owner@example.test, other@example.test']) {
    rejects({ ...base(), listen: acmeListen({ contactEmail }) }, 'listen.tls.acme.contactEmail', /email/);
  }
  for (const httpPort of [-1, 65536, 1.5, '80']) rejects({ ...base(), listen: acmeListen({ httpPort }) }, 'listen.tls.acme.httpPort');
  rejects({ ...base(), listen: acmeListen({ httpPort: 443 }) }, 'listen.tls.acme.httpPort', /listen\.port/);
});

test('ACME needs a DNS host name in publicOrigin', () => {
  for (const host of ['192.0.2.10', '[2001:db8::10]', 'localhost', 'natsumi']) {
    const origin = `https://${host}`;
    rejects({ ...base(), publicOrigin: origin, listen: acmeListen(), github: { ...github(), callbackUrl: `${origin}/auth/github/callback` } },
      'publicOrigin', /host name/);
  }
});

test('the shipped ACME example config is valid', async () => {
  const config = await loadConfig(new URL('../config.acme.example.json', import.meta.url).pathname);
  assert.ok(config.listen.tls && 'acme' in config.listen.tls);
  assert.equal(config.listen.port, 443);
});

test('the listen address is an IP literal or localhost and a valid port', () => {
  rejects({ ...base(), listen: { ...listen(), host: 'natsumi.example.test' } }, 'listen.host', /IP address/);
  rejects({ ...base(), listen: { ...listen(), host: '' } }, 'listen.host');
  for (const port of [-1, 65536, 1.5, '8443']) rejects({ ...base(), listen: { ...listen(), port } }, 'listen.port');
  assert.equal(parseConfig({ ...base(), listen: { ...listen(), port: 0 } }).listen.port, 0);
});

test('the public origin is an https origin, or http only on loopback', () => {
  rejects({ ...base(), publicOrigin: 'http://natsumi.example.test' }, 'publicOrigin', /https/);
  rejects({ ...base(), publicOrigin: 'https://natsumi.example.test/app' }, 'publicOrigin', /origin/);
  rejects({ ...base(), publicOrigin: 'https://natsumi.example.test?x=1' }, 'publicOrigin', /origin/);
  rejects({ ...base(), publicOrigin: 'not a url' }, 'publicOrigin');
  const local = { ...base(), publicOrigin: 'http://127.0.0.1:8080',
    github: { ...github(), callbackUrl: 'http://127.0.0.1:8080/auth/github/callback' } };
  assert.equal(parseConfig(local).publicOrigin, 'http://127.0.0.1:8080');
  assert.equal(parseConfig({ ...base(), publicOrigin: 'https://natsumi.example.test/' }).publicOrigin, 'https://natsumi.example.test');
});

test('GitHub access is granted to one numeric user ID, never a login name', () => {
  for (const allowedUserId of ['fictional-owner', '4242001', 0, -5, 1.5, [4242001]]) {
    rejects({ ...base(), github: { ...github(), allowedUserId } }, 'github.allowedUserId', /numeric/);
  }
  rejects({ ...base(), github: { ...github(), clientId: '' } }, 'github.clientId');
});

test('the GitHub client secret is referenced exactly once, by env or file', () => {
  const { clientSecretEnv: _, ...none } = github();
  rejects({ ...base(), github: none }, 'github.clientSecretEnv', /clientSecretFile/);
  rejects({ ...base(), github: { ...github(), clientSecretFile: '/run/secrets/github-client-secret' } }, 'github.clientSecretFile', /only one/);
});

test('the GitHub callback URL is the callback path on the public origin', () => {
  rejects({ ...base(), github: { ...github(), callbackUrl: 'https://other.example.test/auth/github/callback' } }, 'github.callbackUrl', /publicOrigin/);
  rejects({ ...base(), github: { ...github(), callbackUrl: 'https://natsumi.example.test/callback' } }, 'github.callbackUrl', /\/auth\/github\/callback/);
  rejects({ ...base(), github: { ...github(), callbackUrl: 'https://natsumi.example.test/auth/github/callback?next=x' } }, 'github.callbackUrl');
});

test('secrets written directly into the config are refused without echoing them', () => {
  const secret = 'fixture-secret-value';
  for (const [raw, path] of [
    [{ ...base(), github: { ...github(), clientSecret: secret } }, 'github.clientSecret'],
    [{ ...base(), pi: { ...pi(), apiKey: secret } }, 'pi.apiKey'],
    [{ ...base(), pi: { ...pi(), accessToken: secret } }, 'pi.accessToken'],
    [{ ...base(), pi: { ...pi(), model: { provider: 'x', id: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' } } }, 'pi.model.id'],
    [{ ...base(), google: { privateKey: '-----BEGIN PRIVATE KEY-----' } }, 'google.privateKey'],
  ] as const) {
    assert.throws(() => parseConfig(raw), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.path, path);
      assert.match(error.message, /secret/);
      assert.doesNotMatch(error.message, /fixture-secret-value|ghp_|BEGIN/);
      return true;
    });
  }
});

test('secret references are environment variable names or secret file paths', () => {
  assert.equal(envReference('NATSUMI_GITHUB_CLIENT_SECRET', 'github.clientSecretEnv'), 'NATSUMI_GITHUB_CLIENT_SECRET');
  assert.throws(() => envReference('not an env name', 'github.clientSecretEnv'),
    (error: unknown) => error instanceof ConfigError && error.path === 'github.clientSecretEnv');
  // A value in an *Env / *File field that is not a name or path is treated as a leaked secret.
  rejects({ ...base(), github: { ...github(), clientSecretEnv: 'abc123-literal' } }, 'github.clientSecretEnv', /secret/);
  rejects({ ...base(), google: { credentialsFile: 'inline-json' } }, 'google.credentialsFile', /secret/);
});

test('an unreadable or malformed config file stops startup with a clear error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-config-'));
  try {
    await assert.rejects(loadConfig(join(root, 'missing.json')),
      (error: unknown) => error instanceof ConfigError && /cannot read/.test(error.message));
    await writeFile(join(root, 'broken.json'), '{ "pi": ');
    await assert.rejects(loadConfig(join(root, 'broken.json')),
      (error: unknown) => error instanceof ConfigError && /JSON/.test(error.message));
  } finally { await rm(root, { recursive: true, force: true }); }
});

const apns = () => ({ teamId: 'TEAM000001', keyId: 'KEY0000001', topic: 'net.example.natsumi', keyFile: '/run/secrets/natsumi_apns_key' });

test('APNs is off unless the apns section is given (ADR 0029)', () => {
  assert.equal('apns' in parseConfig(base()), false);
  assert.deepEqual(parseConfig({ ...base(), apns: apns() }).apns,
    { teamId: 'TEAM000001', keyId: 'KEY0000001', topic: 'net.example.natsumi', key: { file: '/run/secrets/natsumi_apns_key' } });
  const { keyFile: _, ...rest } = apns();
  assert.deepEqual(parseConfig({ ...base(), apns: { ...rest, keyEnv: 'NATSUMI_APNS_KEY' } }).apns?.key, { env: 'NATSUMI_APNS_KEY' });
});

test('the APNs key is referenced exactly once, and the IDs and topic are checked', () => {
  const { keyFile: _, ...noKey } = apns();
  rejects({ ...base(), apns: noKey }, 'apns.keyEnv', /required/);
  rejects({ ...base(), apns: { ...apns(), keyEnv: 'NATSUMI_APNS_KEY' } }, 'apns.keyFile', /only one/);
  rejects({ ...base(), apns: { ...apns(), keyFile: 'secrets/apns.p8' } }, 'apns.keyFile');
  for (const teamId of ['', 'team000001', 'TEAM00001', 'TEAM0000011', 12345]) rejects({ ...base(), apns: { ...apns(), teamId } }, 'apns.teamId');
  for (const keyId of ['', 'KEY-000001', 'KEY000001']) rejects({ ...base(), apns: { ...apns(), keyId } }, 'apns.keyId');
  for (const topic of ['', 'natsumi', 'net.example.natsumi/x', 'net..example', '.net.example', 'net.example natsumi']) {
    rejects({ ...base(), apns: { ...apns(), topic } }, 'apns.topic');
  }
  for (const topic of ['com.example.app', 'net.example.Natsumi-iOS', 'a.b']) assert.equal(parseConfig({ ...base(), apns: { ...apns(), topic } }).apns?.topic, topic);
  rejects({ ...base(), apns: { ...apns(), environment: 'sandbox' } }, 'apns.environment', /unknown/);
  rejects({ ...base(), apns: 'on' }, 'apns', /object/);
});

const a2a = () => ({
  tokenFile: '/var/run/secrets/natsumi/a2a-token',
  agents: { wiki: { url: 'https://agents.example.test/wiki-keeper/' } },
});

test('asking outside agents is off unless the a2a section is given, with 15 seconds and 24 hours by default (ADR 0035, ADR 0036)', () => {
  assert.equal('a2a' in parseConfig(base()), false);
  assert.deepEqual(parseConfig({ ...base(), a2a: a2a() }).a2a, {
    tokenFile: '/var/run/secrets/natsumi/a2a-token', pollIntervalSeconds: 15, giveUpAfterHours: 24,
    agents: { wiki: { url: 'https://agents.example.test/wiki-keeper/' } },
  });
  const tuned = parseConfig({ ...base(), a2a: { ...a2a(), pollIntervalSeconds: 60, giveUpAfterHours: 72 } }).a2a;
  assert.equal(tuned?.pollIntervalSeconds, 60);
  assert.equal(tuned?.giveUpAfterHours, 72);
  // A section with nobody in it is allowed: the list she reads then says there is nobody to ask.
  assert.deepEqual(parseConfig({ ...base(), a2a: { ...a2a(), agents: {} } }).a2a?.agents, {});
});

test('the a2a token is a file, read by path and never written in the config', () => {
  const { tokenFile: _, ...noToken } = a2a();
  rejects({ ...base(), a2a: noToken }, 'a2a.tokenFile', /required/);
  rejects({ ...base(), a2a: { ...a2a(), tokenFile: 'secrets/a2a-token' } }, 'a2a.tokenFile');
  rejects({ ...base(), a2a: { ...a2a(), token: 'eyJhbGciOi' } }, 'a2a.token', /secrets must not be written/);
});

test('each agent is a short lower-case name with an https URL of its own', () => {
  const agents = (value: unknown) => ({ ...base(), a2a: { ...a2a(), agents: value } });
  for (const name of ['Wiki', 'wiki keeper', '-wiki', 'ウィキ', 'a'.repeat(33)]) {
    rejects(agents({ [name]: { url: 'https://agents.example.test/' } }), `a2a.agents.${name}`, /name/);
  }
  for (const name of ['wiki', 'wiki-keeper', 'search2']) {
    assert.ok(parseConfig(agents({ [name]: { url: 'https://agents.example.test/' } })).a2a?.agents[name]);
  }
  for (const url of ['http://agents.example.test/', 'https://user:pass@agents.example.test/', 'https://agents.example.test/?a=1',
    'https://agents.example.test/#x', 'agents.example.test', 'ftp://agents.example.test/']) {
    rejects(agents({ wiki: { url } }), 'a2a.agents.wiki.url');
  }
  assert.equal(parseConfig(agents({ wiki: { url: 'http://127.0.0.1:8080/' } })).a2a?.agents.wiki?.url, 'http://127.0.0.1:8080/');
  rejects(agents({ wiki: {} }), 'a2a.agents.wiki.url', /required/);
  rejects(agents({ wiki: { url: 'https://agents.example.test/', tokenFile: '/run/other' } }), 'a2a.agents.wiki.tokenFile', /unknown/);
  rejects(agents([]), 'a2a.agents', /object/);
  rejects({ ...base(), a2a: { tokenFile: '/run/token' } }, 'a2a.agents', /required/);
});

test('the polling interval and the wait limit are whole numbers with a floor', () => {
  for (const pollIntervalSeconds of [0, 4, 7.5, '15']) {
    rejects({ ...base(), a2a: { ...a2a(), pollIntervalSeconds } }, 'a2a.pollIntervalSeconds');
  }
  for (const giveUpAfterHours of [0, -1, 1.5, '24']) {
    rejects({ ...base(), a2a: { ...a2a(), giveUpAfterHours } }, 'a2a.giveUpAfterHours');
  }
  rejects({ ...base(), a2a: { ...a2a(), retries: 3 } }, 'a2a.retries', /unknown/);
});

const slack = () => ({
  workspaces: { work: { botTokenEnv: 'NATSUMI_SLACK_WORK_BOT_TOKEN', appTokenFile: '/run/secrets/slack-work-app-token' } },
});

test('Slack is off unless the slack section is given, and has defaults for the rest (ADR 0012)', () => {
  assert.equal('slack' in parseConfig(base()), false);
  assert.deepEqual(parseConfig({ ...base(), slack: slack() }).slack, {
    workspaces: { work: { botToken: { env: 'NATSUMI_SLACK_WORK_BOT_TOKEN' }, appToken: { file: '/run/secrets/slack-work-app-token' } } },
    reaction: 'eyes', backfillDays: 90, maxImageBytes: 5 * 1024 * 1024, mentionContext: { messages: 5, chars: 500 }, updates: true,
    approvalExpiryDays: 7, placementFollowing: 2,
    judgeContext: { messages: 5, chars: 500 }, postImages: { maxBytes: 10 * 1024 * 1024, maxCount: 4 },
  });
  const tuned = parseConfig({ ...base(), slack: { ...slack(), reaction: 'white_check_mark', backfillDays: 1, maxImageBytes: 1048576,
    mentionContext: { messages: 3, chars: 200 }, updates: false } }).slack;
  assert.equal(tuned?.reaction, 'white_check_mark');
  assert.equal(tuned?.backfillDays, 1);
  assert.equal(tuned?.maxImageBytes, 1048576);
  assert.deepEqual(tuned?.mentionContext, { messages: 3, chars: 200 });
  assert.equal(tuned?.updates, false);
});

test('the Slack tokens are referenced by environment variable or file, never written in the config', () => {
  const workspace = (value: unknown) => ({ ...base(), slack: { workspaces: { work: value } } });
  rejects(workspace({ appTokenEnv: 'APP' }), 'slack.workspaces.work.botTokenEnv', /required/);
  rejects(workspace({ botTokenEnv: 'BOT' }), 'slack.workspaces.work.appTokenEnv', /required/);
  rejects(workspace({ botToken: 'xoxb-1-2-3', appTokenEnv: 'APP' }), 'slack.workspaces.work.botToken', /secrets must not be written/);
  rejects(workspace({ botTokenEnv: 'BOT', appTokenEnv: 'APP', userTokenEnv: 'USER' }), 'slack.workspaces.work.userTokenEnv', /unknown/);
});

test('each Slack workspace is a short lower-case name, and there is at least one', () => {
  const tokens = { botTokenEnv: 'BOT', appTokenEnv: 'APP' };
  for (const name of ['Work', 'my work', '-work', 'しごと', 'a'.repeat(33)]) {
    rejects({ ...base(), slack: { workspaces: { [name]: tokens } } }, `slack.workspaces.${name}`, /name/);
  }
  assert.ok(parseConfig({ ...base(), slack: { workspaces: { 'side-project2': tokens } } }).slack?.workspaces['side-project2']);
  rejects({ ...base(), slack: { workspaces: {} } }, 'slack.workspaces', /at least one/);
  rejects({ ...base(), slack: {} }, 'slack.workspaces', /required/);
});

test('the Slack limits are checked', () => {
  for (const reaction of ['', ':eyes:', 'Eyes', 'a b']) rejects({ ...base(), slack: { ...slack(), reaction } }, 'slack.reaction');
  for (const backfillDays of [0, 366, 1.5, '3']) rejects({ ...base(), slack: { ...slack(), backfillDays } }, 'slack.backfillDays');
  for (const maxImageBytes of [0, 1023, 20 * 1024 * 1024 + 1]) rejects({ ...base(), slack: { ...slack(), maxImageBytes } }, 'slack.maxImageBytes');
  assert.equal(parseConfig({ ...base(), slack: { ...slack(), backfillDays: 365 } }).slack?.backfillDays, 365);
  rejects({ ...base(), slack: { ...slack(), mentionContext: { messages: 21 } } }, 'slack.mentionContext.messages');
  rejects({ ...base(), slack: { ...slack(), mentionContext: { chars: 10 } } }, 'slack.mentionContext.chars');
  rejects({ ...base(), slack: { ...slack(), updates: 'yes' } }, 'slack.updates');
  rejects({ ...base(), slack: { ...slack(), channels: ['dev'] } }, 'slack.channels', /unknown/);
});

/** pi on the owner's own OpenAI-compatible model, whose endpoint, key and model the logprobs judge borrows by default. */
const compatiblePi = () => ({ ...pi(), model: { provider: 'natsumi-compatible', id: 'fixture-model' },
  compatible: { baseUrl: 'https://llm.example.test/v1', apiKeyEnv: 'NATSUMI_PI_API_KEY' } });
const JUDGE_THRESHOLDS = { owner: 0.5, return: 0.9 };

test('by default the dove judges with the logprobs of pi\'s own compatible model, at 0.5 and 0.9 (ADR 0040)', () => {
  assert.deepEqual(parseConfig({ ...base(), pi: compatiblePi(), slack: slack() }).slack?.judge, {
    method: 'logprobs', baseUrl: 'https://llm.example.test/v1', apiKey: { env: 'NATSUMI_PI_API_KEY' }, model: 'fixture-model',
    concurrency: 4, timeoutSeconds: 30, thresholds: JUDGE_THRESHOLDS,
  });
  // Without a compatible model there is nothing to judge with unless one is named: every draft then goes to the owner.
  assert.equal(parseConfig({ ...base(), slack: slack() }).slack?.judge, undefined);
});

test('the logprobs judge may point elsewhere, and pi\'s key never goes to another endpoint', () => {
  const judge = (value: unknown, piConfig: unknown = compatiblePi()) => ({ ...base(), pi: piConfig, slack: { ...slack(), judge: value } });
  assert.deepEqual(parseConfig(judge({ baseUrl: 'https://judge.example.test/v1', model: 'judge-model', concurrency: 2, timeoutSeconds: 60,
    thresholds: { owner: 0.4, return: 0.8 } })).slack?.judge, {
    method: 'logprobs', baseUrl: 'https://judge.example.test/v1', model: 'judge-model', concurrency: 2, timeoutSeconds: 60,
    thresholds: { owner: 0.4, return: 0.8 },
  });
  assert.deepEqual(parseConfig(judge({ baseUrl: 'https://judge.example.test/v1', model: 'm', apiKeyFile: '/run/secrets/judge-key' }, pi())).slack?.judge?.apiKey,
    { file: '/run/secrets/judge-key' });
  assert.equal(parseConfig(judge({ model: 'another-model' })).slack?.judge?.baseUrl, 'https://llm.example.test/v1');
  rejects(judge({}, pi()), 'slack.judge.baseUrl', /compatible/);
  rejects(judge({ baseUrl: 'https://judge.example.test/v1' }, pi()), 'slack.judge.model', /compatible/);
  for (const concurrency of [0, 17, 1.5]) rejects(judge({ concurrency }), 'slack.judge.concurrency');
  for (const timeoutSeconds of [4, 301]) rejects(judge({ timeoutSeconds }), 'slack.judge.timeoutSeconds');
  rejects(judge({ method: 'guess' }), 'slack.judge.method');
});

test('the Jev method: TypeSafe or a server that answers the same API, with or without a key', () => {
  const judge = (value: unknown) => ({ ...base(), slack: { ...slack(), judge: { method: 'jev', ...value as object } } });
  assert.deepEqual(parseConfig(judge({ apiKeyFile: '/run/secrets/jev-api-key' })).slack?.judge, {
    method: 'jev', baseUrl: 'https://api.typesafe.ai', apiKey: { file: '/run/secrets/jev-api-key' }, model: 'jev-latest',
    concurrency: 4, timeoutSeconds: 30, thresholds: JUDGE_THRESHOLDS,
  });
  assert.deepEqual(parseConfig(judge({ baseUrl: 'http://jev.example.internal:8080', model: 'local-judge' })).slack?.judge,
    { method: 'jev', baseUrl: 'http://jev.example.internal:8080', model: 'local-judge', concurrency: 4, timeoutSeconds: 30, thresholds: JUDGE_THRESHOLDS });
  assert.equal(parseConfig(judge({ baseUrl: 'http://127.0.0.1:8080', apiKeyEnv: 'K' })).slack?.judge?.baseUrl, 'http://127.0.0.1:8080');
  rejects(judge({ baseUrl: 'http://jev.example.internal:8080', apiKeyEnv: 'K' }), 'slack.judge.baseUrl', /https/);
  rejects(judge({ baseUrl: 'ftp://jev.example.internal' }), 'slack.judge.baseUrl');
  rejects(judge({ baseUrl: 'https://user:pw@jev.example.internal' }), 'slack.judge.baseUrl');
  rejects(judge({ baseUrl: 'https://jev.example.internal/?q=1' }), 'slack.judge.baseUrl');
  rejects(judge({ apiKey: 'fixture-key' }), 'slack.judge.apiKey', /secrets must not be written/);
  rejects(judge({ thresholds: { owner: 0.8, return: 0.5 } }), 'slack.judge.thresholds', /owner/);
  rejects(judge({ thresholds: { owner: -0.1 } }), 'slack.judge.thresholds.owner');
  rejects(judge({ thresholds: { return: 1.5 } }), 'slack.judge.thresholds.return');
  rejects(judge({ model: '' }), 'slack.judge.model');
  rejects(judge({ url: 'https://example.test' }), 'slack.judge.url', /unknown/);
  rejects({ ...base(), slack: { ...slack(), jev: {} } }, 'slack.jev', /unknown/);
});

test('the approvals and where a reply goes are checked', () => {
  const tuned = parseConfig({ ...base(), slack: { ...slack(), approvalExpiryDays: 1, placementFollowing: 0,
    judgeContext: { messages: 10, chars: 100 } } }).slack;
  assert.equal(tuned?.approvalExpiryDays, 1);
  assert.equal(tuned?.placementFollowing, 0);
  assert.deepEqual(tuned?.judgeContext, { messages: 10, chars: 100 });
  for (const approvalExpiryDays of [0, 91, 1.5]) rejects({ ...base(), slack: { ...slack(), approvalExpiryDays } }, 'slack.approvalExpiryDays');
  for (const placementFollowing of [-1, 21, 1.5]) rejects({ ...base(), slack: { ...slack(), placementFollowing } }, 'slack.placementFollowing');
  rejects({ ...base(), slack: { ...slack(), judgeContext: { messages: 0 } } }, 'slack.judgeContext.messages');
  rejects({ ...base(), slack: { ...slack(), judgeContext: { chars: 10 } } }, 'slack.judgeContext.chars');
});

// ADR 0044: how large and how many the images she asks the dove to post may be.
test('the limits on the images she posts are checked', () => {
  const tuned = parseConfig({ ...base(), slack: { ...slack(), postImages: { maxBytes: 2048, maxCount: 10 } } }).slack;
  assert.deepEqual(tuned?.postImages, { maxBytes: 2048, maxCount: 10 });
  assert.deepEqual(parseConfig({ ...base(), slack: { ...slack(), postImages: { maxCount: 1 } } }).slack?.postImages,
    { maxBytes: 10 * 1024 * 1024, maxCount: 1 });
  for (const maxBytes of [0, 1023, 50 * 1024 * 1024 + 1, 1.5]) {
    rejects({ ...base(), slack: { ...slack(), postImages: { maxBytes } } }, 'slack.postImages.maxBytes');
  }
  for (const maxCount of [0, 11, 1.5]) rejects({ ...base(), slack: { ...slack(), postImages: { maxCount } } }, 'slack.postImages.maxCount');
  rejects({ ...base(), slack: { ...slack(), postImages: { types: ['image/gif'] } } }, 'slack.postImages.types', /unknown/);
});

test('poppo is the dove\'s name, and no outside agent may take it', () => {
  rejects({ ...base(), a2a: { ...a2a(), agents: { poppo: { url: 'https://agents.example.test/poppo' } } } }, 'a2a.agents.poppo', /dove/);
});

test('the list of reactions is gone: a config that still has one is refused, and says why (ADR 0042)', () => {
  rejects({ ...base(), slack: { ...slack(), reactions: ['eyes'] } }, 'slack.reactions', /removed.*any emoji/);
  assert.equal('reactions' in (parseConfig({ ...base(), slack: slack() }).slack ?? {}), false);
});
