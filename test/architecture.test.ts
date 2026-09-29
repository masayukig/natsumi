import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The direction of the imports under src/ (ADR 0058): the layers the runtime settings, the browser's ways in and the
 * browser's app keep, and no cycle anywhere. The imports are read from the text of the files, type-only ones included, since a type
 * points at what a module is written against as much as a value does.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src');

interface Edge { to: string; specifier: string }

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

/** Every `import … from`, `export … from`, bare `import '…'` and `import('…')` of a file, as repository paths. */
function importsOf(file: string): Edge[] {
  const text = readFileSync(file, 'utf8');
  const specifiers = [
    ...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;'"]*?\sfrom\s+'([^']+)'/g),
    ...text.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g),
    ...text.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g),
  ].map(match => match[1]!);
  return specifiers.map(specifier => ({
    specifier,
    to: specifier.startsWith('.') ? relative(ROOT, resolve(dirname(file), specifier)) : specifier,
  }));
}

const graph = new Map(sourceFiles(SOURCE).map(file => [relative(ROOT, file), importsOf(file)]));
const internal = (edges: Edge[]) => edges.filter(edge => graph.has(edge.to));

/** The layers of ADR 0058, lowest first. A module takes only from the layers below its own, or its own component. The
 * settings' rules and shapes are the contract's, shared with the browser's app, so their lowest layer is there. */
const DOMAIN = 'src/shared/protocol/settings.ts';
const STORE = 'src/server/settings/store.ts';
const SERVICE = 'src/server/settings/service.ts';
const BROWSER = 'src/server/browser/';
/** The ways in (WebSocket and HTTP) and where everything is put together: the only ones that may take the service. */
const INTERFACES = ['src/server/connections.ts', 'src/server/http.ts'];
const COMPOSITION = ['src/server/server.ts', 'src/server/main.ts', 'src/fake-server/main.ts'];

test('the layers of the runtime settings are where the ADR puts them', () => {
  for (const file of [DOMAIN, STORE, SERVICE]) assert.ok(graph.has(file), `${file} exists`);
  assert.ok([...graph.keys()].some(file => file.startsWith(BROWSER)), 'the browser’s ways in have a directory of their own');
});

test('the settings’ rules and shapes import nothing at all, not even Node', () => {
  assert.deepEqual(importsOf(join(ROOT, DOMAIN)).map(edge => edge.specifier), []);
});

test('the settings store takes only the domain and the data directory’s small helpers', () => {
  const allowed = new Set([DOMAIN, 'src/server/paths.ts', 'src/server/data-directory.ts']);
  for (const edge of internal(graph.get(STORE)!)) assert.ok(allowed.has(edge.to), `${STORE} imports ${edge.to}`);
});

test('the settings service takes only the store and the domain: the loop is reached through ports of its own', () => {
  const allowed = new Set([DOMAIN, STORE]);
  for (const edge of internal(graph.get(SERVICE)!)) assert.ok(allowed.has(edge.to), `${SERVICE} imports ${edge.to}`);
});

test('only the ways in and the composition take the service, and only the composition and HTTP take the browser’s modules', () => {
  const takesService = new Set([...INTERFACES, ...COMPOSITION, SERVICE]);
  for (const [file, edges] of graph) {
    for (const edge of internal(edges)) {
      if (edge.to === SERVICE) assert.ok(takesService.has(file), `${file} imports the settings service`);
      if (edge.to.startsWith(BROWSER) && !file.startsWith(BROWSER)) {
        assert.ok(['src/server/http.ts', 'src/server/dashboard.ts', ...COMPOSITION].includes(file), `${file} imports ${edge.to}`);
      }
    }
  }
});

test('nothing below the ways in reaches up to them', () => {
  const upper = new Set([...INTERFACES, ...COMPOSITION]);
  for (const [file, edges] of graph) {
    if (!file.startsWith('src/server/settings/') && !file.startsWith(BROWSER)) continue;
    for (const edge of internal(edges)) assert.ok(!upper.has(edge.to), `${file} imports ${edge.to}`);
  }
});

/**
 * The browser's app (ADR 0058), the way the Mac app is built (mac/CLAUDE.md): a passive view and a mediator.
 *
 *   src/shared/protocol/  the contract's types and readers, which the server uses too
 *   src/web/core/         state, events, effects, the mediator and the derivation of the props: pure functions
 *   src/web/adapters/     the socket, the storage and the avatar's list: the outside, turned into events
 *   src/web/view/         Preact components drawing the props and handing back events
 *   src/web/main.ts       where the real socket and the DOM are put together
 */
const PROTOCOL = 'src/shared/protocol/';
const CORE = 'src/web/core/';
const ADAPTERS = 'src/web/adapters/';
const VIEW = 'src/web/view/';
const MAIN = 'src/web/main.ts';
const under = (file: string, ...places: string[]) => places.some(place => file === place || file.startsWith(place));
const isPreact = (specifier: string) => specifier === 'preact' || specifier.startsWith('preact/');

test('the browser’s app has its layers where the design puts them', () => {
  for (const place of [PROTOCOL, CORE, ADAPTERS, VIEW]) {
    assert.ok([...graph.keys()].some(file => file.startsWith(place)), `${place} has modules`);
  }
  assert.ok(graph.has(MAIN), `${MAIN} exists`);
});

test('the contract takes nothing but itself: no Node, no DOM library, no package', () => {
  for (const [file, edges] of graph) {
    if (!under(file, PROTOCOL)) continue;
    for (const edge of edges) assert.ok(under(edge.to, PROTOCOL), `${file} imports ${edge.specifier}`);
  }
});

test('the core takes only itself and the contract', () => {
  for (const [file, edges] of graph) {
    if (!under(file, CORE)) continue;
    for (const edge of edges) assert.ok(under(edge.to, CORE, PROTOCOL), `${file} imports ${edge.specifier}`);
  }
});

test('the adapters and the view take the core and the contract, not each other; only the view takes Preact', () => {
  for (const [file, edges] of graph) {
    if (under(file, ADAPTERS)) {
      for (const edge of edges) assert.ok(under(edge.to, ADAPTERS, CORE, PROTOCOL), `${file} imports ${edge.specifier}`);
    }
    if (under(file, VIEW)) {
      for (const edge of edges) assert.ok(under(edge.to, VIEW, CORE, PROTOCOL) || isPreact(edge.specifier), `${file} imports ${edge.specifier}`);
    }
  }
});

test('only main.ts puts the app together, and it takes nothing from the server', () => {
  for (const edge of graph.get(MAIN)!) {
    assert.ok(under(edge.to, 'src/web/', PROTOCOL) || isPreact(edge.specifier), `${MAIN} imports ${edge.specifier}`);
  }
  for (const [file, edges] of graph) {
    for (const edge of edges) {
      if (edge.to === MAIN) assert.fail(`${file} imports ${MAIN}`);
      if (under(edge.to, 'src/web/')) assert.ok(under(file, 'src/web/'), `${file} imports ${edge.to}`);
      if (isPreact(edge.specifier)) assert.ok(under(file, VIEW) || file === MAIN, `${file} imports ${edge.specifier}`);
    }
  }
});

test('the contract is shared: the server takes it, and nothing in it takes the server', () => {
  const serverTakes = [...graph].filter(([file]) => under(file, 'src/server/'))
    .flatMap(([, edges]) => edges.map(edge => edge.to)).filter(to => under(to, PROTOCOL));
  assert.ok(serverTakes.length > 0, 'the server imports the shared contract');
});

/** The strongly connected components of more than one module, or of one that imports itself (Tarjan). */
function cycles(): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (file: string) => {
    index.set(file, next); low.set(file, next); next += 1;
    stack.push(file); onStack.add(file);
    for (const { to } of internal(graph.get(file)!)) {
      if (!index.has(to)) { visit(to); low.set(file, Math.min(low.get(file)!, low.get(to)!)); }
      else if (onStack.has(to)) low.set(file, Math.min(low.get(file)!, index.get(to)!));
    }
    if (low.get(file) !== index.get(file)) return;
    const component: string[] = [];
    let member: string;
    do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== file);
    if (component.length > 1 || internal(graph.get(file)!).some(edge => edge.to === file)) found.push(component.sort());
  };
  for (const file of graph.keys()) if (!index.has(file)) visit(file);
  return found;
}

/**
 * The cycles that were there before ADR 0058, left as they are for the owner to decide on. Each goes through a
 * type-only import (workspace-shell.ts takes `ToolOutcome` from loop-tools.ts), so none is a cycle when the code runs.
 * One mended is taken off this list; a new one fails.
 */
const KNOWN_CYCLES = [
  ['src/server/loop-tools.ts', 'src/server/read-tool.ts', 'src/server/search-memory.ts', 'src/server/workspace-shell.ts'],
];

test('no module under src/ reaches itself through its imports, but for the cycles known before', () => {
  assert.ok(graph.size > 100, 'the whole of src/ is read');
  const key = (cycle: string[]) => cycle.join(' ');
  assert.deepEqual(cycles().map(key).sort(), KNOWN_CYCLES.map(key).sort());
});

test('the reader of imports sees the ones it must: multi-line, type-only and re-exports', () => {
  const edges = importsOf(join(ROOT, 'src/server/server.ts')).map(edge => edge.to);
  assert.ok(edges.includes('src/server/config.ts'), 'a multi-line import');
  assert.ok(edges.includes('src/server/judge.ts'), 'a type-only import');
  assert.ok(importsOf(join(ROOT, 'src/server/connections.ts')).some(edge => edge.to === 'src/server/device-streams.ts'));
});
