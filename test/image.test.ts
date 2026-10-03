import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { loadAvatar } from '../src/server/avatar.ts';
import { writeAvatarManual } from '../src/server/avatar-manual.ts';

const dockerfile = () => readFile(new URL('../Dockerfile', import.meta.url).pathname, 'utf8');

// The stage that ships is the one with no name: every stage above it is a builder or a separate image.
async function shippingStage() {
  const lines = (await dockerfile()).split('\n');
  const start = lines.findLastIndex(line => line.startsWith('FROM ') && !line.includes(' AS '));
  assert.notEqual(start, -1, 'the Dockerfile ends with no unnamed stage');
  return lines.slice(start);
}

const directive = (stage: string[], keyword: string) => {
  const line = stage.find(candidate => candidate.startsWith(`${keyword} `));
  assert.ok(line, `the shipping stage has no ${keyword}`);
  return line.slice(keyword.length + 1);
};

const buildCopies = (stage: string[]) => stage
  .filter(line => line.startsWith('COPY --from=build '))
  .map(line => {
    const [, , source, destination] = line.split(/\s+/);
    return { source: source!, destination: destination! };
  });

// The directories under src/ that the server's entrypoint reaches through the imports that stay in the output (an
// `import type` is erased by the build). A new one, like src/shared, has to be copied into the image too.
async function directoriesTheServerRuns() {
  const source = new URL('../src/', import.meta.url).pathname;
  const imports = /^(?:import|export)\s+(type\s+)?(?:[^;']*?\sfrom\s+)?'(\.{1,2}\/[^']+)'/gm;
  const seen = new Set<string>();
  const pending = [join(source, 'server/main.ts')];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, typeOnly, specifier] of (await readFile(file, 'utf8')).matchAll(imports)) {
      if (!typeOnly) pending.push(resolve(dirname(file), specifier!));
    }
  }
  return [...new Set([...seen].map(file => relative(source, file).split(sep)[0]!))];
}

test('the image takes from the build only the code the server runs and the browser’s bundle, never the probe', async () => {
  const sources = buildCopies(await shippingStage()).map(copy => copy.source).sort();
  const directories = await directoriesTheServerRuns();
  assert.ok(directories.includes('shared'), `the walk missed src/shared: ${directories.join(' ')}`);
  assert.ok(!directories.includes('probe'));
  assert.deepEqual(sources, [...directories.map(directory => `/app/dist/src/${directory}`), '/app/dist/web'].sort());
});

test('the entrypoint runs a file that the image has copied in', async () => {
  const stage = await shippingStage();
  const workdir = directive(stage, 'WORKDIR');
  const roots = buildCopies(stage).map(copy => resolve(workdir, copy.destination));
  const entrypoint = JSON.parse(directive(stage, 'ENTRYPOINT')) as string[];
  const main = entrypoint.find(argument => argument.endsWith('.js'));
  assert.ok(main, 'the entrypoint runs no JavaScript file');
  assert.ok(roots.some(root => main.startsWith(`${root}/`)), `${main} is outside ${roots.join(' ')}`);
});

// Pi's CLI, run in the server's container to log in, looks for rg and fd (as fd or fdfind) when it starts, and warns
// when it cannot download them offline. The thinking loop leaves Pi's own grep and find off; this only quiets the CLI.
test('the image installs ripgrep and fd-find for Pi\'s CLI', async () => {
  const stage = (await shippingStage()).join('\n');
  const install = /apt-get install [^\n]*(?:\\\n[^\n]*)*/.exec(stage);
  assert.ok(install, 'the shipping stage installs no packages');
  const packages = install[0].split(/\s+/);
  assert.ok(packages.includes('ripgrep'), install[0]);
  assert.ok(packages.includes('fd-find'), install[0]);
});

// ADR 0044: natsumi draws with sdctl in the workspace, at a fixed version, with the default params baked in beside it.
const workspaceStage = async () => {
  const text = await dockerfile();
  const start = text.indexOf(' AS workspace\n');
  return text.slice(start, text.indexOf('\nFROM ', start));
};
const root = new URL('..', import.meta.url).pathname;

test('the workspace image has sdctl built from a fixed version of its source', async () => {
  const text = await dockerfile();
  const stage = text.slice(text.indexOf(' AS sdctl\n'), text.indexOf('\nFROM ', text.indexOf(' AS sdctl\n')));
  assert.ok(text.includes(' AS sdctl\n'), 'no stage builds sdctl');
  assert.match(stage, /go install [^\n]*github\.com\/yuanying\/sdctl@v0\.3\.3\b/);
  assert.doesNotMatch(stage, /@latest/);
  assert.match(await workspaceStage(), /^COPY --from=sdctl \/out\/sdctl \/usr\/libexec\/sdctl$/m);
});

// ADR 0057: the params are the avatar's, or the server's default, and the server writes them where the image's config
// points; the image holds none of its own.
test('the default params are the server\'s, for Anima, with a negative prompt and the model set per request', async () => {
  assert.doesNotMatch(await workspaceStage(), /anima\.yaml/);
  const config = parse(await readFile(`${root}docker/sdctl/config.yaml`, 'utf8')) as Record<string, unknown>;
  assert.equal(config.params, '/manual/avatar/sdctl-params.yaml');
  assert.match(await workspaceStage(), /^RUN mkdir -p \/manual\/agents \/manual\/avatar$/m);
  const params = (await loadAvatar(undefined)).sdctlParams;
  assert.equal(params, await readFile(`${root}assets/avatars/natsumi/sdctl-params.yaml`, 'utf8'));
  assert.match(params, /^negative_prompt: "[^"]+"$/m);
  // The model and its modules go with each request: the relay refuses POST options, so `models set` is no way.
  assert.match(params, /^override_settings:\n  sd_model_checkpoint: "anima_2_9_Anima-2.9B-preview-v1"\n  forge_additional_modules:\n    - "qwen_image_vae\.safetensors"\n    - "qwen_3_06b_base\.safetensors"$/m);
  for (const key of ['steps', 'width', 'height', 'cfg_scale', 'sampler', 'scheduler', 'seed']) assert.match(params, new RegExp(`^${key}: `, 'm'), key);
  assert.doesNotMatch(params, /^prompt:/m, 'the prompt is hers to write');
});

// The runner gives a command none of the container's environment (ADR 0019), so the defaults cannot live there: sdctl
// in PATH is a wrapper that points the real one at a config file in the image, whichever shell runs it.
test('the workspace image gives sdctl its defaults in a config file that the sdctl in PATH always reads', async () => {
  const stage = await workspaceStage();
  assert.match(stage, /^COPY --chmod=755 docker\/sdctl\/sdctl \/usr\/local\/bin\/sdctl$/m);
  assert.match(stage, /^COPY docker\/sdctl\/config\.yaml \/etc\/sdctl\/config\.yaml$/m);
  assert.doesNotMatch(stage, /^ENV SDCTL_/m, 'a command run by the runner never sees the image\'s environment');
  const wrapper = await readFile(`${root}docker/sdctl/sdctl`, 'utf8');
  assert.match(wrapper, /^exec \/usr\/libexec\/sdctl --config \/etc\/sdctl\/config\.yaml "\$@"$/m);
  const config = await readFile(`${root}docker/sdctl/config.yaml`, 'utf8');
  // The relay's address is the environment overlay's promise: the egress proxy listens there.
  assert.match(config, /^url: http:\/\/127\.0\.0\.1:17860$/m);
  assert.match(config, /^params: \/manual\/avatar\/sdctl-params\.yaml$/m);
  assert.match(config, /^output_dir: \/work\/images$/m);
});

// PNG is heavy, so what natsumi draws is JPEG (sdctl v0.3.2 and later; the image has v0.3.3). The server takes either by its content (ADR 0044, 0045).
test('sdctl writes JPEG by default in the workspace', async () => {
  const config = parse(await readFile(`${root}docker/sdctl/config.yaml`, 'utf8')) as Record<string, unknown>;
  assert.equal(config.format, 'jpeg');
});

// A name given with -o wins over the config by its extension, so an example with `.png` would have her draw PNG.
test('the manuals name what natsumi draws with .jpg, not .png', async () => {
  for (const page of ['assets/manual/images.md', 'manual/slack.md']) {
    const text = await readFile(`${root}${page}`, 'utf8');
    assert.doesNotMatch(text, /\/work\/images\/[^\s`]*\.png/, page);
  }
  assert.match(await readFile(`${root}assets/manual/images.md`, 'utf8'), /JPEG/);
});

// natsumi reads and shapes JSON in the workspace (ADR 0019): jq, beside python3.
test('the workspace image installs jq', async () => {
  const install = /apt-get install (?:[^\n\\]|\\\n)*/.exec(await workspaceStage());
  assert.ok(install, 'the workspace stage installs no packages');
  assert.ok(install[0].split(/\s+/).includes('jq'), install[0]);
});

// What natsumi runs reaches the runner, and the runner gives a command only PATH, HOME, LANG and TZ (ADR 0019): none of
// the container's environment. So sdctl's defaults are checked where she uses it, through the runner of the built
// workspace image, against a fake image server on the relay's address. It needs docker, and skips without it.
const hasDocker = await promisify(execFile)('docker', ['info']).then(() => true, () => false);
const workspaceTag = 'natsumi-workspace:test';
const relay = 'http://127.0.0.1:17860';

function docker(args: string[], input?: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise(stdout) : reject(new Error(`docker ${args[0]} exited ${code}: ${stderr}`)));
    child.stdin.end(input ?? '');
  });
}

// A client of the runner's socket, run inside the container so the test needs no socket shared with the host.
const runnerClient = [
  'import socket, sys',
  's = socket.socket(socket.AF_UNIX)',
  's.connect("/run/natsumi-workspace/runner.sock")',
  's.sendall(sys.stdin.buffer.read())',
  'sys.stdout.buffer.write(s.makefile("rb").readline())',
].join('\n');

type RunnerResult = { exitCode: number | null; stdout: string; stderr: string };

async function throughRunner(container: string, command: string): Promise<RunnerResult> {
  const answer = await docker(['exec', '-i', container, 'python3', '-c', runnerClient], `${JSON.stringify({ command })}\n`);
  return JSON.parse(answer) as RunnerResult;
}

// Builds the workspace image and runs it the way the Pod does, with no network, until its runner answers.
async function startWorkspace(t: TestContext, name: string) {
  // The host network only for the build: some hosts resolve no names on the default bridge.
  await docker(['build', '--network', 'host', '--target', 'workspace', '--tag', workspaceTag, root]);
  const container = `natsumi-workspace-test-${name}-${process.pid}`;
  await docker(['run', '--detach', '--rm', '--name', container, '--network', 'none', '--read-only', '--init',
    '--tmpfs', '/tmp:mode=1777', '--tmpfs', '/run/natsumi-workspace:uid=1000,gid=1000,mode=755',
    '--tmpfs', '/work:uid=1000,gid=1000,mode=755', '--tmpfs', '/home/natsumi:uid=1000,gid=1000,mode=755',
    '--tmpfs', '/manual/avatar:mode=755', workspaceTag, 'serve']);
  t.after(() => docker(['rm', '--force', container]).catch(() => undefined));
  // What the server writes from the avatar on every start, which the deployment shows read-only as /manual/avatar
  // (ADR 0057). Put in by root, as the Docker daemon may not see this host's files to bind them.
  const avatar = await mkdtemp(join(tmpdir(), 'natsumi-workspace-avatar-'));
  t.after(() => rm(avatar, { recursive: true, force: true }));
  await writeAvatarManual(avatar, await loadAvatar(undefined));
  for (const file of ['images.md', 'sdctl-params.yaml']) {
    await docker(['exec', '-i', '--user', '0', container, 'sh', '-c', `cat > /manual/avatar/${file} && chmod 644 /manual/avatar/${file}`],
      await readFile(join(avatar, file), 'utf8'));
  }
  for (let attempt = 0; ; attempt++) {
    const ready = await docker(['exec', container, '/usr/libexec/natsumi-workspace-runner', 'check']).then(() => true, () => false);
    if (ready) break;
    assert.ok(attempt < 50, 'the runner never answered');
    await new Promise(wait => setTimeout(wait, 100));
  }
  return container;
}

// Answers what `sdctl txt2img` asks with default params that name modules, and writes down every request.
const fakeImageServer = `
import base64, http.server, json, struct, zlib
# A real 1x1 PNG: sdctl decodes it to write JPEG.
def png():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\\x00\\xff\\xff\\xff")) + chunk(b"IEND", b""))
class Handler(http.server.BaseHTTPRequestHandler):
    def answer(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def record(self, body):
        with open("/tmp/fake-sd/requests.jsonl", "a") as log:
            log.write(json.dumps({"method": self.command, "path": self.path, "body": body}) + "\\n")
    def do_GET(self):
        self.record(None)
        if self.path == "/sdapi/v1/sd-modules":
            return self.answer([])
        self.send_error(404)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.record(body)
        if self.path == "/sdapi/v1/txt2img":
            return self.answer({"images": [base64.b64encode(png()).decode()], "info": "{}"})
        self.send_error(404)
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(("127.0.0.1", 17860), Handler)
open("/tmp/fake-sd/ready", "w").close()
server.serve_forever()
`;

test('through the runner, as run_shell runs it, sdctl draws JPEG through the relay with the default params into /work/images', {
  skip: hasDocker ? false : 'docker is not available',
  timeout: 30 * 60_000,
}, async t => {
  const container = await startWorkspace(t, 'sdctl');

  const started = await throughRunner(container, [
    'mkdir -p /tmp/fake-sd',
    `cat > /tmp/fake-sd/server.py <<'PY'${fakeImageServer}PY`,
    'python3 /tmp/fake-sd/server.py >/tmp/fake-sd/log 2>&1 &',
    'for _ in $(seq 100); do [ -e /tmp/fake-sd/ready ] && exit 0; sleep 0.1; done; cat /tmp/fake-sd/log; exit 1',
  ].join('\n'));
  assert.equal(started.exitCode, 0, `the fake image server did not start: ${started.stdout}${started.stderr}`);
  const prompt = await throughRunner(container, `mkdir -p /work/prompts && printf 'prompt: "a white cat"\\n' > /work/prompts/cat.yaml`);
  assert.equal(prompt.exitCode, 0, prompt.stderr);

  const params = (await loadAvatar(undefined)).sdctlParams;
  const negative = /^negative_prompt: "([^"]+)"$/m.exec(params)![1];
  const drawn = async (saved: string) => {
    assert.match(saved, /^\/work\/images\/output-[^/\s]+\.jpg\n$/);
    const requests = (await throughRunner(container, 'cat /tmp/fake-sd/requests.jsonl')).stdout.trim().split('\n')
      .map(line => JSON.parse(line) as { method: string; path: string; body: Record<string, unknown> | null });
    const drawing = requests.findLast(request => request.path === '/sdapi/v1/txt2img');
    assert.ok(drawing, 'no txt2img reached the relay');
    assert.equal(drawing.body!.prompt, 'a white cat');
    assert.equal(drawing.body!.negative_prompt, negative);
    assert.equal(drawing.body!.steps, 32);
    assert.equal((drawing.body!.override_settings as Record<string, unknown>).sd_model_checkpoint, 'anima_2_9_Anima-2.9B-preview-v1');
    // JPEG begins with FF D8 FF.
    const head = await throughRunner(container, `head -c 3 ${saved.trim()} | od -An -tx1`);
    assert.equal(head.stdout.trim(), 'ff d8 ff');
  };

  // natsumi's run_shell: the runner's environment only.
  const viaRunner = await throughRunner(container, 'sdctl txt2img --prompt /work/prompts/cat.yaml');
  assert.equal(viaRunner.exitCode, 0, `sdctl failed through the runner: ${viaRunner.stderr}`);
  await drawn(viaRunner.stdout);

  // The owner's shell in the container (kubectl exec), which has the environment the Pod gives it.
  const viaShell = await docker(['exec', '--env', `SDCTL_URL=${relay}`, container,
    'bash', '-c', 'sdctl txt2img --prompt /work/prompts/cat.yaml']);
  await drawn(viaShell);
});

test('through the runner, as run_shell runs it, jq is on PATH', {
  skip: hasDocker ? false : 'docker is not available',
  timeout: 30 * 60_000,
}, async t => {
  const container = await startWorkspace(t, 'jq');
  const version = await throughRunner(container, 'jq --version');
  assert.equal(version.exitCode, 0, `jq failed through the runner: ${version.stderr}`);
  assert.match(version.stdout, /^jq-\d+\.\d+/);
  const filtered = await throughRunner(container, `printf '{"a":[1,2]}' | jq -c '.a | map(. * 2)'`);
  assert.equal(filtered.stdout, '[2,4]\n');
});

const serverTag = 'natsumi-server:test';
let serverImage: Promise<string> | undefined;
// Built once for the tests below. The host network only for the build, as for the workspace.
const buildServer = () => serverImage ??= docker(['build', '--network', 'host', '--tag', serverTag, root]);

// The same, in the image that ships: Pi finds the commands on PATH under these names.
test('the server image has rg and fdfind on PATH', {
  skip: hasDocker ? false : 'docker is not available',
  timeout: 30 * 60_000,
}, async () => {
  await buildServer();
  for (const command of ['rg', 'fdfind']) {
    const version = await docker(['run', '--rm', '--network', 'none', '--entrypoint', command, serverTag, '--version']);
    assert.match(version, /\d+\.\d+/, `${command} --version printed ${version}`);
  }
});

// The entrypoint loads every module the server runs before it reads its arguments, so a file the image left out fails
// here as it would on start. `avatar check` needs no config, no data directory and no network.
test('the server image runs its entrypoint', {
  skip: hasDocker ? false : 'docker is not available',
  timeout: 30 * 60_000,
}, async () => {
  await buildServer();
  const checked = await docker(['run', '--rm', '--network', 'none', '--read-only', serverTag, 'avatar', 'check', 'nanashi']);
  assert.match(checked, /^errors \(the server does not start\): none$/m);
});
