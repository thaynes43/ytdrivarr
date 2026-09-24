// Copies each provider's DOWNLOADER assets (issue #40) into the bundle so the runtime finds them
// beside dist/index.js — the layout `resolveAssetRoot()` (src/core/downloader-assets.ts) probes:
//   src/providers/<id>/ytdlp-plugins/  →  dist/assets/<id>/ytdlp-plugins/
// The core then mirrors a provider's tree into every Library that provider feeds. Python bytecode
// caches and dotfiles are never shipped. The output dir is rebuilt from scratch so a removed plugin
// file cannot survive in a stale dist.
// Usage: node scripts/build-assets.mjs [outdir]   (outdir defaults to dist/assets)
import { cp, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mirrors DOWNLOADER_ASSET_DIRS in src/contracts/downloader-assets.ts (the vitest suite runs this
// script and fails if a registered provider's declared tree is missing from the output).
const ASSET_DIRS = ['ytdlp-plugins'];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(process.argv[2] ?? join(repoRoot, 'dist', 'assets'));
const providersSrc = join(repoRoot, 'src', 'providers');

const isDir = async (path) => (await stat(path).catch(() => undefined))?.isDirectory() === true;
const shipped = (path) => {
  const name = basename(path);
  return name !== '__pycache__' && !name.endsWith('.pyc') && !name.startsWith('.');
};

await rm(outdir, { recursive: true, force: true });
const copied = [];
for (const provider of await readdir(providersSrc, { withFileTypes: true })) {
  if (!provider.isDirectory()) continue;
  for (const name of ASSET_DIRS) {
    const from = join(providersSrc, provider.name, name);
    if (!(await isDir(from))) continue;
    await cp(from, join(outdir, provider.name, name), { recursive: true, filter: shipped });
    copied.push(`${provider.name}/${name}`);
  }
}

console.log(`provider assets built → ${outdir} (${copied.join(', ') || 'none'})`);
