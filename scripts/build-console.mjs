// Builds the operator console (DESIGN-045 D-20) with the SAME esbuild the service bundle uses —
// no extra toolchain. Output is a flat static dir the Hono app serves:
//   dist/public/index.html + console.js + console.css + favicon.svg
// Usage: node scripts/build-console.mjs [outdir]   (outdir defaults to dist/public)
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(process.argv[2] ?? join(repoRoot, 'dist', 'public'));
const consoleSrc = join(repoRoot, 'src', 'console');

await mkdir(outdir, { recursive: true });

// main.ts imports styles.css, so esbuild emits console.js AND console.css in one pass.
await build({
  entryPoints: { console: join(consoleSrc, 'main.ts') },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  outdir,
});

await cp(join(consoleSrc, 'index.html'), join(outdir, 'index.html'));
await cp(join(consoleSrc, 'favicon.svg'), join(outdir, 'favicon.svg'));

console.log(`console assets built → ${outdir}`);
