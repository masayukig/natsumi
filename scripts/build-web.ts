/**
 * Builds the browser's app (ADR 0058) into dist/web/: src/web/main.ts bundled into one ES module, app.js, with its
 * source map, src/web/app.css beside it, and the service worker that shows Web Push, sw.js (ADR 0065). The server serves
 * these under /app/ by name.
 *
 *   node scripts/build-web.ts [--out <dir>]
 */
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string', default: `${root}dist/web` } } });

await rm(values.out, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: { app: 'src/web/main.ts' },
  outdir: values.out,
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari16'],
  platform: 'browser',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
});
// A classic script, not a module: every browser that has Web Push runs one as a service worker.
await build({
  absWorkingDir: root,
  entryPoints: { sw: 'src/web/sw.ts' },
  outdir: values.out,
  bundle: true,
  format: 'iife',
  target: ['es2022', 'safari16'],
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
await build({
  absWorkingDir: root,
  entryPoints: { app: 'src/web/app.css' },
  outdir: values.out,
  bundle: true,
  minify: true,
  target: ['safari16', 'chrome110', 'firefox110'],
  logLevel: 'warning',
});
console.log(`built the browser's app into ${values.out}`);
