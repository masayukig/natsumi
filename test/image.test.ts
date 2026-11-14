import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { loadAvatar } from '../src/server/avatar.ts';
import { writeAvatarManual } from '../src/server/avatar-manual.ts';

const dockerfile = () => readFile(new URL('../Dockerfile', import.meta.url).pathname, 'utf8');

// Every stage is built on the same Debian, trixie (13): the Node, Debian and Ruby bases name it in their tags, and Go's
// tag, which names none, is on it too, so nothing built in one stage meets another Debian's libraries in the next.
test('every stage of the Dockerfile is built on Debian trixie', async () => {
  const bases = [...(await dockerfile()).matchAll(/^FROM (\S+)/gm)].map(match => match[1] ?? '');
  assert.ok(bases.length > 0);
  for (const base of bases) {
    assert.doesNotMatch(base, /bookworm/, base);
    if (/^(node|debian|ruby):/.test(base)) assert.match(base, /trixie/, base);
  }
});

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
  assert.match(stage, /go install [^\n]*github\.com\/yuanying\/sdctl@v\d+\.\d+\.\d+\b/);
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

// PNG is heavy, so what natsumi draws is JPEG (sdctl v0.3.2 and later; the image has v0.4.0). The server takes either by its content (ADR 0044, 0045).
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

// ADR 0085: the CLIs that use the relays are in everyone's workspace. An instance whose way out is closed has them too,
// and they reach nothing. gh is not Debian's package: it is fetched at a fixed release (ADR 0099).
test('the workspace image installs ssh\'s client, curl and the passwd wrapper ssh runs under', async () => {
  const install = /apt-get install (?:[^\n\\]|\\\n)*/.exec(await workspaceStage());
  assert.ok(install, 'the workspace stage installs no packages');
  const packages = install[0].split(/\s+/);
  for (const name of ['openssh-client', 'curl', 'ca-certificates', 'libnss-wrapper']) assert.ok(packages.includes(name), `${name}: ${install[0]}`);
});

const kubectlStage = async () => {
  const text = await dockerfile();
  const start = text.indexOf(' AS kubectl\n');
  assert.notEqual(start, -1, 'no stage fetches kubectl');
  return text.slice(start, text.indexOf('\nFROM ', start));
};

test('the workspace image has kubectl of a fixed 1.37 release, checked against its published checksum', async () => {
  const stage = await kubectlStage();
  assert.match(stage, /^ARG KUBECTL_VERSION=v1\.37\.\d+$/m);
  assert.match(stage, /https:\/\/dl\.k8s\.io\/release\/\$\{KUBECTL_VERSION\}\/bin\/linux\/\$\{TARGETARCH\}\/kubectl\b/);
  assert.match(stage, /kubectl\.sha256/);
  assert.match(stage, /sha256sum --check/);
  assert.match(await workspaceStage(), /^COPY --from=kubectl \/out\/kubectl \/usr\/local\/bin\/kubectl$/m);
});

test('Renovate reads the version of kubectl as a Kubernetes release', async () => {
  const config = JSON.parse(await readFile(`${root}renovate.json`, 'utf8')) as {
    customManagers: { managerFilePatterns: string[]; matchStrings: string[]; depNameTemplate?: string; datasourceTemplate?: string }[];
  };
  const text = await dockerfile();
  const found = config.customManagers.flatMap(manager => manager.matchStrings.map(pattern => ({ manager, match: new RegExp(pattern).exec(text) })))
    .filter(({ match }) => match?.groups?.currentValue?.startsWith('v1.37.'));
  assert.equal(found.length, 1, 'no custom manager, or more than one, reads the kubectl version');
  const { manager, match } = found[0]!;
  assert.deepEqual(manager.managerFilePatterns, ['/^Dockerfile$/']);
  assert.equal(match![0], `ARG KUBECTL_VERSION=${match!.groups!.currentValue}`);
  assert.equal(manager.depNameTemplate, 'kubernetes/kubernetes');
  assert.equal(manager.datasourceTemplate, 'github-releases');
});

// ssh looks itself up in /etc/passwd as it starts and stops without a line, which the UID a deployment picks may not
// have (1001 on Kubernetes, ADR 0033). The ssh in PATH is a wrapper that lends ssh alone a line through nss_wrapper.
test('the ssh in PATH is a wrapper around the real one, and only it is preloaded with nss_wrapper', async () => {
  assert.match(await workspaceStage(), /^COPY --chmod=755 docker\/ssh\/ssh \/usr\/local\/bin\/ssh$/m);
  const wrapper = await readFile(`${root}docker/ssh/ssh`, 'utf8');
  assert.match(wrapper, /\/usr\/bin\/ssh "\$@"/);
  assert.match(wrapper, /LD_PRELOAD=libnss_wrapper\.so/);
  assert.doesNotMatch(wrapper, /^export /m, 'the preload is for ssh, set on its command line only');
});

// ADR 0088: Ruby is in everyone's workspace: the official build of a fixed 4.0 release, taken from its image with what
// it needs to run, and a C compiler for the gems that build an extension. build-essential is left out (g++ and
// dpkg-dev are not needed for a C extension), and so is Debian's Ruby, 3.1, which the Ruby CLIs are not tested on.
const rubyStage = async () => {
  const text = await dockerfile();
  const start = text.indexOf(' AS ruby\n');
  assert.notEqual(start, -1, 'no stage holds Ruby');
  return text.slice(text.lastIndexOf('\nFROM ', start) + 1, text.indexOf('\nFROM ', start));
};

test('the workspace image installs what the official Ruby runs with and a C compiler, and no Debian Ruby nor build-essential', async () => {
  const install = /apt-get install (?:[^\n\\]|\\\n)*/.exec(await workspaceStage());
  assert.ok(install, 'the workspace stage installs no packages');
  const packages = install[0].split(/\s+/);
  for (const name of ['libyaml-0-2', 'libffi8', 'libgmp10', 'libssl3t64', 'zlib1g', 'gcc', 'make', 'libc6-dev']) {
    assert.ok(packages.includes(name), `${name}: ${install[0]}`);
  }
  for (const name of ['ruby', 'ruby-dev', 'ruby-bundler', 'build-essential']) assert.ok(!packages.includes(name), `${name}: ${install[0]}`);
});

test('the workspace image has Ruby 4.0 from the official image of the same Debian, pinned by tag and digest', async () => {
  const stage = await rubyStage();
  assert.match(stage, /^FROM ruby:4\.0\.\d+-slim-trixie@sha256:[0-9a-f]{64} AS ruby$/m);
  assert.match(await dockerfile(), /^FROM debian:trixie-slim AS workspace$/m);
  const workspace = await workspaceStage();
  assert.match(workspace, /^COPY --from=ruby \/out\/local\/ \/usr\/local\/$/m);
  assert.match(workspace, /^COPY --from=ruby \/out\/bundler\/ \/usr\/libexec\/bundler\/$/m);
  assert.match(stage, /mv \/out\/local\/bin\/bundle \/out\/local\/bin\/bundler \/out\/bundler\//);
  for (const name of ['bundle', 'bundler']) {
    assert.match(workspace, new RegExp(`^COPY --chmod=755 docker/bundler/bundle /usr/local/bin/${name}$`, 'm'));
  }
});

// The bundler is the one Ruby ships, moved with it by the ruby image's tag: no version of its own to pin or hold back.
test('bundler has no version of its own in the Dockerfile or in Renovate\'s config', async () => {
  const config = JSON.parse(await readFile(`${root}renovate.json`, 'utf8')) as {
    customManagers: { matchStrings: string[]; depNameTemplate?: string }[];
    packageRules: { matchDepNames?: string[]; matchPackageNames?: string[] }[];
  };
  assert.doesNotMatch(await dockerfile(), /BUNDLER_VERSION|gem install/);
  assert.ok(!config.customManagers.some(manager => manager.depNameTemplate === 'bundler'));
  assert.ok(!config.packageRules.some(rule => [...rule.matchDepNames ?? [], ...rule.matchPackageNames ?? []].includes('bundler')));
});

// ADR 0088: sops encrypts the secrets a Ruby CLI renders, when it is asked to, with an age key. Debian
// trixie has no sops, so it is fetched like kubectl; age is Debian's, whose package apt checks, as age's releases
// publish no checksum to check them against.
const sopsStage = async () => {
  const text = await dockerfile();
  const start = text.indexOf(' AS sops\n');
  assert.notEqual(start, -1, 'no stage fetches sops');
  return text.slice(start, text.indexOf('\nFROM ', start));
};

test('the workspace image has sops of a fixed release, checked against its published checksums, and Debian\'s age', async () => {
  const stage = await sopsStage();
  assert.match(stage, /^ARG SOPS_VERSION=v3\.\d+\.\d+$/m);
  assert.match(stage, /https:\/\/github\.com\/getsops\/sops\/releases\/download\/\$\{SOPS_VERSION\}\/sops-\$\{SOPS_VERSION\}\.linux\.\$\{TARGETARCH\}/);
  assert.match(stage, /sops-\$\{SOPS_VERSION\}\.checksums\.txt/);
  assert.match(stage, /sha256sum --check/);
  const workspace = await workspaceStage();
  assert.match(workspace, /^COPY --from=sops \/out\/sops \/usr\/local\/bin\/sops$/m);
  const install = /apt-get install (?:[^\n\\]|\\\n)*/.exec(workspace);
  assert.ok(install, 'the workspace stage installs no packages');
  assert.ok(install[0].split(/\s+/).includes('age'), install[0]);
});

test('Renovate reads the version of sops as a release of getsops/sops', async () => {
  const config = JSON.parse(await readFile(`${root}renovate.json`, 'utf8')) as {
    customManagers: { managerFilePatterns: string[]; matchStrings: string[]; depNameTemplate?: string; datasourceTemplate?: string }[];
  };
  const text = await dockerfile();
  const found = config.customManagers.flatMap(manager => manager.matchStrings.map(pattern => ({ manager, match: new RegExp(pattern).exec(text) })))
    .filter(({ match }) => match?.[0].startsWith('ARG SOPS_VERSION='));
  assert.equal(found.length, 1, 'no custom manager, or more than one, reads the sops version');
  const { manager, match } = found[0]!;
  assert.deepEqual(manager.managerFilePatterns, ['/^Dockerfile$/']);
  assert.match(match!.groups!.currentValue!, /^v3\.\d+\.\d+$/);
  assert.equal(manager.depNameTemplate, 'getsops/sops');
  assert.equal(manager.datasourceTemplate, 'github-releases');
});

// ADR 0099: gh, GitHub's CLI, fetched like sops from its GitHub releases at a fixed version and checked against the
// checksums published with it. Its archives name the version without the v of the tag Renovate reads, and the
// architecture as Docker's TARGETARCH does.
const ghStage = async () => {
  const text = await dockerfile();
  const start = text.indexOf(' AS gh\n');
  assert.notEqual(start, -1, 'no stage fetches gh');
  return text.slice(start, text.indexOf('\nFROM ', start));
};

test('the workspace image has gh of a fixed release, checked against its published checksums', async () => {
  const stage = await ghStage();
  assert.match(stage, /^ARG GH_VERSION=v2\.\d+\.\d+$/m);
  assert.match(stage, /^ARG TARGETARCH$/m);
  assert.match(stage, /https:\/\/github\.com\/cli\/cli\/releases\/download\/\$\{GH_VERSION\}\/gh_\$\{version\}_linux_\$\{TARGETARCH\}\.tar\.gz/);
  assert.match(stage, /https:\/\/github\.com\/cli\/cli\/releases\/download\/\$\{GH_VERSION\}\/gh_\$\{version\}_checksums\.txt/);
  assert.match(stage, /sha256sum --check/);
  const workspace = await workspaceStage();
  const install = /apt-get install (?:[^\n\\]|\\\n)*/.exec(workspace);
  assert.ok(install, 'the workspace stage installs no packages');
  assert.ok(!install[0].split(/\s+/).includes('gh'), install[0]);
});

test('Renovate reads the version of gh as a release of cli/cli', async () => {
  const config = JSON.parse(await readFile(`${root}renovate.json`, 'utf8')) as {
    customManagers: { managerFilePatterns: string[]; matchStrings: string[]; depNameTemplate?: string; datasourceTemplate?: string }[];
  };
  const text = await dockerfile();
  const found = config.customManagers.flatMap(manager => manager.matchStrings.map(pattern => ({ manager, match: new RegExp(pattern).exec(text) })))
    .filter(({ match }) => match?.[0].startsWith('ARG GH_VERSION='));
  assert.equal(found.length, 1, 'no custom manager, or more than one, reads the gh version');
  const { manager, match } = found[0]!;
  assert.deepEqual(manager.managerFilePatterns, ['/^Dockerfile$/']);
  assert.match(match!.groups!.currentValue!, /^v2\.\d+\.\d+$/);
  assert.equal(manager.depNameTemplate, 'cli/cli');
  assert.equal(manager.datasourceTemplate, 'github-releases');
});

// ADR 0099: gh sends telemetry on every command, a TTY or not, unless GH_TELEMETRY or DO_NOT_TRACK says not to, and its
// config, where it can be turned off too, is under HOME. The runner passes neither variable (ADR 0019), so the gh in PATH
// is a wrapper that turns telemetry and the update notice off unless the command line says otherwise.
test('the workspace image puts gh out of PATH behind the wrapper in PATH', async () => {
  const workspace = await workspaceStage();
  assert.match(workspace, /^COPY --from=gh \/out\/gh \/usr\/libexec\/gh$/m);
  assert.match(workspace, /^COPY --chmod=755 docker\/gh\/gh \/usr\/local\/bin\/gh$/m);
});

test('the gh in PATH runs the real one with telemetry and the update notice off, unless the command line sets them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'natsumi-gh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stub = join(dir, 'real-gh');
  await writeFile(stub, '#!/bin/sh\nprintf \'%s\\n\' "args=$*" "telemetry=${GH_TELEMETRY-unset}" "notifier=${GH_NO_UPDATE_NOTIFIER-unset}"\n', { mode: 0o755 });
  const wrapper = join(dir, 'gh');
  const text = await readFile(`${root}docker/gh/gh`, 'utf8');
  assert.ok(text.includes('/usr/libexec/gh'), text);
  await writeFile(wrapper, text.replaceAll('/usr/libexec/gh', stub), { mode: 0o755 });
  const run = async (env: Record<string, string>) =>
    (await promisify(execFile)(wrapper, ['api', 'user', '--jq', '.login'], { env: { PATH: '/usr/bin:/bin', HOME: dir, ...env } })).stdout;

  assert.equal(await run({}), 'args=api user --jq .login\ntelemetry=false\nnotifier=1\n');
  assert.equal(await run({ GH_TELEMETRY: 'log', GH_NO_UPDATE_NOTIFIER: '' }), 'args=api user --jq .login\ntelemetry=log\nnotifier=\n');
});

// ADR 0088: Go's toolchain, the one the runner is built with, from the golang image Renovate already moves. The
// runner's PATH has no /usr/local/go/bin, so go and gofmt are linked into /usr/local/bin. GOTOOLCHAIN is local in
// $GOROOT/go.env, the lowest of Go's defaults: a go.mod asking for another Go fetches nothing. GOPROXY is left as Go
// ships it; the relay's port is the deployment's, set with `go env -w`.
const goStage = async () => {
  const text = await dockerfile();
  const start = text.indexOf(' AS go\n');
  assert.notEqual(start, -1, 'no stage holds the Go toolchain');
  return text.slice(text.lastIndexOf('\nFROM ', start) + 1, text.indexOf('\nFROM ', start));
};

test('the workspace image has the Go toolchain of the runner\'s golang image, on PATH, with GOTOOLCHAIN local', async () => {
  const stage = await goStage();
  const builders = [...(await dockerfile()).matchAll(/^FROM (golang:\S+) AS (\S+)$/gm)];
  assert.equal(new Set(builders.map(match => match[1])).size, 1, 'the stages build with different Go images');
  assert.match(stage, /^FROM golang:\S+ AS go$/m);
  assert.match(stage, /sed -i 's\/\^GOTOOLCHAIN=\.\*\/GOTOOLCHAIN=local\/' \/usr\/local\/go\/go\.env/);
  assert.match(stage, /grep -qx 'GOTOOLCHAIN=local' \/usr\/local\/go\/go\.env/);
  const workspace = await workspaceStage();
  assert.match(workspace, /^COPY --from=go \/usr\/local\/go \/usr\/local\/go$/m);
  assert.match(workspace, /ln -s \/usr\/local\/go\/bin\/go \/usr\/local\/go\/bin\/gofmt \/usr\/local\/bin\//);
});

// No bundler setting can be given to everyone without the environment, which the runner does not pass (ADR 0019), and
// Gem's own directory is on the read-only root. The bundle in PATH points GEM_HOME at Gem.user_dir, under HOME.
test('the bundle in PATH is a wrapper that installs under HOME unless GEM_HOME is given', async () => {
  const wrapper = await readFile(`${root}docker/bundler/bundle`, 'utf8');
  assert.match(wrapper, /GEM_HOME="\$\{GEM_HOME:-\$\(\/usr\/local\/bin\/ruby -e 'print Gem\.user_dir'\)\}"/);
  assert.match(wrapper, /exec "\/usr\/libexec\/bundler\/\$\{0##\*\/\}" "\$@"/);
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
// `uid` is the one it runs as: the image's own, or, as on Kubernetes, another one (ADR 0033). /memory is then an empty
// place owned by the image's UID, standing in for the memory repository the server owns.
async function startWorkspace(t: TestContext, name: string, uid = 1000) {
  // The host network only for the build: some hosts resolve no names on the default bridge.
  await docker(['build', '--network', 'host', '--target', 'workspace', '--tag', workspaceTag, root]);
  const container = `natsumi-workspace-test-${name}-${process.pid}`;
  const own = `uid=${uid},gid=${uid},mode=755`;
  // /work and /home/natsumi are not noexec, as on the deployment's volumes (ADR 0019); Docker's tmpfs is by default.
  await docker(['run', '--detach', '--rm', '--name', container, '--network', 'none', '--read-only', '--init',
    '--user', `${uid}:${uid}`, '--tmpfs', '/tmp:mode=1777', '--tmpfs', `/run/natsumi-workspace:${own}`,
    '--tmpfs', `/work:${own},exec`, '--tmpfs', `/home/natsumi:${own},exec`, '--tmpfs', '/memory:uid=1000,gid=1000,mode=777',
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

// The memory repository is the server's, and on Kubernetes the workspace runs as another UID (ADR 0033), so git
// would refuse it as of dubious ownership. The image trusts /memory, and only it, in the system config: the runner
// gives a command none of the image's environment (ADR 0019), but git reads /etc/gitconfig whatever the environment.
test('the workspace image trusts /memory, and nothing else, in the system git config', async () => {
  assert.match(await workspaceStage(), /^COPY docker\/workspace\/gitconfig \/etc\/gitconfig$/m);
  const config = await readFile(`${root}docker/workspace/gitconfig`, 'utf8');
  assert.deepEqual([...config.matchAll(/^\s*directory\s*=\s*(.*)$/gm)].map(match => match[1]), ['/memory']);
});

test('through the runner, as run_shell runs it as another UID, git reads the history of the memory the server owns', {
  skip: hasDocker ? false : 'docker is not available',
  timeout: 30 * 60_000,
}, async t => {
  const container = await startWorkspace(t, 'git', 1001);
  // The server's commit, made as the image's UID that stands in for it. The files are writable to the workspace, as
  // the shared group makes them on Kubernetes.
  await docker(['exec', '--user', '1000:1000', '--env', 'HOME=/tmp', container, 'sh', '-c',
    'umask 0 && cd /memory && git init -q && echo note > always.md && git add always.md'
    + ' && git -c user.name=natsumi -c user.email=natsumi@example.invalid commit -qm remembered']);
  const id = await throughRunner(container, 'id -u');
  assert.equal(id.stdout, '1001\n');
  // Without the image's config, git refuses the repository: this is what the setting is for.
  const refused = await throughRunner(container, 'GIT_CONFIG_NOSYSTEM=1 git -C /memory log --format=%s');
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr, /dubious ownership/);
  const log = await throughRunner(container, 'git -C /memory log --format=%s');
  assert.equal(log.exitCode, 0, log.stderr);
  assert.equal(log.stdout, 'remembered\n');
  const diff = await throughRunner(container, 'echo more >> /memory/always.md && git -C /memory diff --stat');
  assert.equal(diff.exitCode, 0, diff.stderr);
  assert.match(diff.stdout, /always\.md \| 1 \+/);
});

// ADR 0085: the connection settings are read-only files the deployment puts in (/tools), named on the command line, as
// the runner passes no KUBECONFIG. Here they stand in /tmp/tools. HOME is made unwritable first: none of these may need
// to write there, ssh's known_hosts least of all. With no network the commands get as far as connecting, and no further.
const sshConfig = [
  'Host node1',
  '  HostName 192.0.2.10',
  '  User root',
  '  IdentityAgent /run/ssh-agent/agent.sock',
  '  UserKnownHostsFile /tmp/tools/known_hosts',
  '  StrictHostKeyChecking yes',
  '',
].join('\n');
const kubeconfig = [
  'apiVersion: v1',
  'kind: Config',
  'clusters:',
  '- name: test',
  '  cluster: {server: "http://127.0.0.1:18443"}',
  'users:',
  '- name: test',
  '  user: {}',
  'contexts:',
  '- name: test',
  '  context: {cluster: test, user: test}',
  'current-context: test',
  '',
].join('\n');

for (const uid of [1000, 1001]) {
  test(`through the runner as UID ${uid}, kubectl, ssh, curl and gh run with their settings in files and write nothing to HOME`, {
    skip: hasDocker ? false : 'docker is not available',
    timeout: 30 * 60_000,
  }, async t => {
    const container = await startWorkspace(t, `cli-${uid}`, uid);
    const run = async (command: string) => {
      const result = await throughRunner(container, command);
      assert.equal(result.exitCode, 0, `${command}: ${result.stdout}${result.stderr}`);
      return result.stdout;
    };
    await run([
      'chmod 555 /home/natsumi',
      'mkdir -p /tmp/tools && touch /tmp/tools/known_hosts',
      `cat > /tmp/tools/ssh_config <<'EOF'\n${sshConfig}EOF`,
      `cat > /tmp/tools/kubeconfig <<'EOF'\n${kubeconfig}EOF`,
    ].join('\n'));

    assert.match(await run('kubectl version --client'), /^Client Version: v1\.37\.\d+$/m);
    assert.match((await throughRunner(container, 'ssh -V')).stderr, /^OpenSSH_/);
    assert.match(await run('curl --version'), /^curl \d+\.\d+/);
    assert.match(await run('gh --version'), /^gh version 2\.\d+\.\d+ /m);

    const resolved = await run('ssh -G -F /tmp/tools/ssh_config node1');
    for (const line of ['hostname 192.0.2.10', 'user root', 'identityagent /run/ssh-agent/agent.sock', 'userknownhostsfile /tmp/tools/known_hosts']) {
      assert.match(resolved, new RegExp(`^${line}$`, 'm'), line);
    }
    const connected = await throughRunner(container, 'ssh -F /tmp/tools/ssh_config -o BatchMode=yes -o ConnectTimeout=2 node1 true');
    assert.equal(connected.exitCode, 255);
    assert.match(connected.stderr, /connect to host 192\.0\.2\.10 port 22/);

    assert.equal(await run('kubectl --kubeconfig /tmp/tools/kubeconfig config view --minify -o jsonpath=\'{.clusters[0].cluster.server}\''), 'http://127.0.0.1:18443');
    const listed = await throughRunner(container, 'kubectl --kubeconfig /tmp/tools/kubeconfig get pods');
    assert.notEqual(listed.exitCode, 0);
    assert.match(listed.stderr, /The connection to the server 127\.0\.0\.1:18443 was refused/);

    assert.equal(await run('ls -A /home/natsumi'), '');
  });
}

// ADR 0088: a gem with a C extension, served from the loopback as a mirror behind a relay would be, is built and
// installed by a bare `bundle install` into Gem.user_dir under HOME, the root being read-only. Gem's default path holds
// that directory, so the gem loads under `bundle exec` and from a plain ruby alike.
const helloGem = [
  'mkdir -p /tmp/hello/ext/hello /tmp/hello/lib /tmp/hello/exe /tmp/gems/gems',
  `cat > /tmp/hello/hello.gemspec <<'RB'
Gem::Specification.new do |s|
  s.name = "hello"
  s.version = "0.1.0"
  s.summary = "A C extension"
  s.authors = ["natsumi"]
  s.license = "MIT"
  s.files = ["lib/hello.rb", "ext/hello/extconf.rb", "ext/hello/hello.c", "exe/hello"]
  s.extensions = ["ext/hello/extconf.rb"]
  s.bindir = "exe"
  s.executables = ["hello"]
end
RB`,
  `echo 'require "mkmf"; create_makefile("hello/hello")' > /tmp/hello/ext/hello/extconf.rb`,
  `cat > /tmp/hello/ext/hello/hello.c <<'C'
#include <ruby.h>
static VALUE greet(VALUE self) { return rb_str_new_cstr("hello from C"); }
void Init_hello(void) { rb_define_module_function(rb_define_module("Hello"), "greet", greet, 0); }
C`,
  `echo 'require "hello/hello"' > /tmp/hello/lib/hello.rb`,
  `printf '#!/usr/bin/env ruby\\nrequire "hello"\\nputs Hello.greet\\n' > /tmp/hello/exe/hello && chmod 755 /tmp/hello/exe/hello`,
  'cd /tmp/hello && gem build --quiet hello.gemspec --output /tmp/gems/gems/hello-0.1.0.gem >/dev/null 2>&1',
  // RubyGems 4 has no generate_index of its own, so the compact index rubygems.org serves is written by hand.
  `cd /tmp/gems && mkdir -p info && ruby -rdigest -e '
    File.write("info/hello", "---\\n0.1.0 |checksum:#{Digest::SHA256.file("gems/hello-0.1.0.gem").hexdigest}\\n")
    File.write("versions", "created_at: 2026-01-01T00:00:00Z\\n---\\nhello 0.1.0 #{Digest::MD5.file("info/hello").hexdigest}\\n")'`,
  '(cd /tmp/gems && python3 -m http.server --bind 127.0.0.1 18808 >/tmp/gems.log 2>&1 &)',
  'for _ in $(seq 100); do curl -fs -o /dev/null http://127.0.0.1:18808/versions && exit 0; sleep 0.1; done; cat /tmp/gems.log; exit 1',
].join('\n');

for (const uid of [1000, 1001]) {
  test(`through the runner as UID ${uid}, bundle install builds a gem's C extension into HOME, and bundle exec runs it`, {
    skip: hasDocker ? false : 'docker is not available',
    timeout: 30 * 60_000,
  }, async t => {
    const container = await startWorkspace(t, `ruby-${uid}`, uid);
    const run = async (command: string) => {
      const result = await throughRunner(container, command);
      assert.equal(result.exitCode, 0, `${command}: ${result.stdout}${result.stderr}`);
      return result.stdout;
    };
    assert.match(await run('ruby --version'), /^ruby 4\.0\./);
    assert.match(await run('bundle --version'), /^4\.0\.\d+$/m);
    assert.match(await run('bundler --version'), /^4\.0\.\d+$/m);
    await run(helloGem);
    await run(`mkdir -p /work/app && printf 'source "http://127.0.0.1:18808"\\ngem "hello"\\n' > /work/app/Gemfile`);

    await run('cd /work/app && bundle install');
    assert.equal(await run('cd /work/app && bundle exec hello'), 'hello from C\n');
    assert.equal(await run('ruby -e \'require "hello"; puts Hello.greet\''), 'hello from C\n');
    const home = (await run('ruby -e \'print Gem.user_dir\'')).trim();
    assert.match(home, /^\/home\/natsumi\/\.local\/share\/gem\/ruby\/4\.0\.0$/);
    assert.match(await run(`find ${home} -name hello.so`), /hello\.so$/m);
  });
}

// ADR 0088: sops finds the age key where it looks with no SOPS_AGE_KEY_FILE, under HOME, and encrypts and decrypts the
// way such a CLI calls it: through stdin and stdout, in the binary format, the rule picked by --filename-override.
for (const uid of [1000, 1001]) {
  test(`through the runner as UID ${uid}, sops encrypts and decrypts with an age key made under HOME`, {
    skip: hasDocker ? false : 'docker is not available',
    timeout: 30 * 60_000,
  }, async t => {
    const container = await startWorkspace(t, `sops-${uid}`, uid);
    const run = async (command: string) => {
      const result = await throughRunner(container, command);
      assert.equal(result.exitCode, 0, `${command}: ${result.stdout}${result.stderr}`);
      return result.stdout;
    };
    assert.match(await run('sops --version --disable-version-check'), /^sops 3\.\d+\.\d+/m);
    assert.match(await run('age --version'), /^v?1\.\d+\.\d+/m);
    await run('mkdir -p ~/.config/sops/age && age-keygen -o ~/.config/sops/age/keys.txt 2>/dev/null');
    const recipient = (await run('age-keygen -y ~/.config/sops/age/keys.txt')).trim();
    assert.match(recipient, /^age1[0-9a-z]+$/);
    await run(`mkdir -p /work/cluster/assets && printf 'creation_rules:\\n  - path_regex: assets/.*\\n    age: ${recipient}\\n' > /work/cluster/.sops.yaml`);

    const secret = 'a key\\n---\\nnot: yaml\\n';
    const encrypted = await run(`cd /work/cluster && printf '${secret}' | sops encrypt --input-type binary --output-type json --filename-override /work/cluster/assets/ca.key /dev/stdin > assets/ca.key && cat assets/ca.key`);
    const document = JSON.parse(encrypted) as { data: string; sops: { age: { recipient: string }[] } };
    assert.doesNotMatch(document.data, /a key/);
    assert.equal(document.sops.age[0]!.recipient, recipient);
    const decrypted = await run('cd /work/cluster && sops decrypt --input-type json --output-type binary --filename-override /work/cluster/assets/ca.key /dev/stdin < assets/ca.key');
    assert.equal(decrypted, 'a key\n---\nnot: yaml\n');
  });
}

// ADR 0088: with the runner's environment only, Go's places fall under HOME, and a module of the standard library
// builds with no network. A go.mod asking for a newer Go is refused rather than fetched.
for (const uid of [1000, 1001]) {
  test(`through the runner as UID ${uid}, go builds a module under /work with its caches under HOME, and fetches no toolchain`, {
    skip: hasDocker ? false : 'docker is not available',
    timeout: 30 * 60_000,
  }, async t => {
    const container = await startWorkspace(t, `go-${uid}`, uid);
    const run = async (command: string) => {
      const result = await throughRunner(container, command);
      assert.equal(result.exitCode, 0, `${command}: ${result.stdout}${result.stderr}`);
      return result.stdout;
    };
    const version = await run('go version');
    assert.match(version, /^go version go1\.\d+\.\d+ linux\//);
    assert.match(await run('gofmt -l /dev/null; echo ok'), /ok/);
    assert.equal(await run('go env GOTOOLCHAIN GOPATH GOMODCACHE GOCACHE'),
      'local\n/home/natsumi/go\n/home/natsumi/go/pkg/mod\n/home/natsumi/.cache/go-build\n');

    await run([
      'mkdir -p /work/hello && cd /work/hello',
      `printf 'module example.com/hello\\n\\ngo 1.22\\n' > go.mod`,
      `printf 'package main\\n\\nimport "fmt"\\n\\nfunc main() { fmt.Println("hello from Go") }\\n' > main.go`,
      'go build -o hello .',
    ].join('\n'));
    assert.equal(await run('/work/hello/hello'), 'hello from Go\n');
    assert.match(await run('ls /home/natsumi/.cache/go-build'), /\S/);

    const refused = await throughRunner(container, `cd /work/hello && printf 'module example.com/hello\\n\\ngo 1.99.0\\n' > go.mod && go build -o hello .`);
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.stderr, /requires go >= 1\.99\.0 \(running go 1\.\d+\.\d+; GOTOOLCHAIN=local\)/);
  });
}

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
