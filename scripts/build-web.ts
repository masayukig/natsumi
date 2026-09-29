/**
 * Builds the browser's app (ADR 0058) into dist/web/: src/web/main.ts bundled into one ES module, app.js, with its
 * source map, and src/web/app.css beside it. The server serves these under /app/ by name.
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
