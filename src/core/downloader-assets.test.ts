import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DOWNLOADER_ASSET_DIRS, validateProvider, type SourceProvider } from '../contracts';
import {
  ASSETS_DIR_ENV,
  assertDownloaderAssets,
  feedingProviders,
  projectDownloaderAssets,
  resolveAssetRoot,
} from './downloader-assets';
import { listProviders } from './registry';
import { pelotonProvider } from '../providers/peloton';
import { youtubeProvider } from '../providers/youtube';
import { inCoreUrlListProvider } from '../providers/in-core-url-list';

/**
 * Provider-contributed downloader assets (issue #40): a provider's declared tree is mirrored into
 * `<projectionDir>/.ytdrivarr/` of every Library it feeds — atomically, skip-if-unchanged, pruned —
 * and ONLY those. Fixture trees stand in for real providers; the last block checks the real
 * Peloton plugin tree resolves from source AND from the `pnpm build` layout.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN = 'ytdlp-plugins/yt_dlp_plugins/extractor/fake_extractor.py';

let root: string;
let assetRoot: string;
let projectionDir: string;

const provider = (id: string, kinds: SourceProvider['downloaderAssets'] = ['ytdlpPlugins']) => ({
  id,
  downloaderAssets: kinds,
});

async function writeTree(base: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(base, ...rel.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/** Every file under `dir` as `/`-separated relative paths (sorted). */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(dir.length + 1)
        .split('\\')
        .join('/'),
    )
    .sort();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ytdrivarr-assets-'));
  assetRoot = join(root, 'assets');
  projectionDir = join(root, 'projection');
  await writeTree(join(assetRoot, 'fakepelo', 'ytdlp-plugins'), {
    'yt_dlp_plugins/extractor/fake_extractor.py': 'IE = 1\n',
    // build/runtime junk that must never ship:
    'yt_dlp_plugins/extractor/__pycache__/fake_extractor.cpython-313.pyc': 'bytecode',
    'yt_dlp_plugins/.DS_Store': 'junk',
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('projectDownloaderAssets — mirror a feeding provider tree beside subscriptions.yaml', () => {
  it('copies the declared tree to <projectionDir>/.ytdrivarr/<kind dir>/ (no junk, no temp files)', async () => {
    const result = await projectDownloaderAssets(projectionDir, [provider('fakepelo')], {
      assetRoot,
    });
    expect(result.dir).toBe(join(projectionDir, '.ytdrivarr'));
    expect(result.written).toEqual([PLUGIN]);
    expect(await listFiles(result.dir)).toEqual([PLUGIN]);
    expect(await readFile(join(result.dir, ...PLUGIN.split('/')), 'utf8')).toBe('IE = 1\n');
  });

  it('gives a library no contributing provider feeds NOTHING (no .ytdrivarr dir at all)', async () => {
    const result = await projectDownloaderAssets(projectionDir, [provider('yt', [])], {
      assetRoot,
    });
    expect(result).toMatchObject({ written: [], removed: [], unchanged: 0 });
    await expect(stat(join(projectionDir, '.ytdrivarr'))).rejects.toThrow();
  });

  it('skips the write when the bytes are unchanged, rewrites when they change', async () => {
    await projectDownloaderAssets(projectionDir, [provider('fakepelo')], { assetRoot });
    const target = join(projectionDir, '.ytdrivarr', ...PLUGIN.split('/'));
    const before = (await stat(target)).mtimeMs;

    const again = await projectDownloaderAssets(projectionDir, [provider('fakepelo')], {
      assetRoot,
    });
    expect(again).toMatchObject({ written: [], removed: [], unchanged: 1 });
    expect((await stat(target)).mtimeMs).toBe(before);

    await writeTree(join(assetRoot, 'fakepelo', 'ytdlp-plugins'), {
      'yt_dlp_plugins/extractor/fake_extractor.py': 'IE = 2\n',
    });
    const changed = await projectDownloaderAssets(projectionDir, [provider('fakepelo')], {
      assetRoot,
    });
    expect(changed.written).toEqual([PLUGIN]);
    expect(await readFile(target, 'utf8')).toBe('IE = 2\n');
  });

  it('prunes files no provider ships any more (a renamed plugin must not stay loadable)', async () => {
    const out = join(projectionDir, '.ytdrivarr', 'ytdlp-plugins');
    await writeTree(out, {
      'yt_dlp_plugins/extractor/old_name.py': 'stale plugin',
      'yt_dlp_plugins/postprocessor/gone.py': 'stale',
      // the downloader's own bytecode cache + a concurrent projection's in-flight write stay put.
      'yt_dlp_plugins/extractor/__pycache__/old_name.cpython-313.pyc': 'bytecode',
      'yt_dlp_plugins/extractor/fake_extractor.py.tmp-42-1700000000000-abc': 'in flight',
    });
    const result = await projectDownloaderAssets(projectionDir, [provider('fakepelo')], {
      assetRoot,
    });
    expect(result.removed.sort()).toEqual([
      'ytdlp-plugins/yt_dlp_plugins/extractor/old_name.py',
      'ytdlp-plugins/yt_dlp_plugins/postprocessor/gone.py',
    ]);
    expect(await listFiles(out)).toEqual([
      'yt_dlp_plugins/extractor/__pycache__/old_name.cpython-313.pyc',
      'yt_dlp_plugins/extractor/fake_extractor.py',
      'yt_dlp_plugins/extractor/fake_extractor.py.tmp-42-1700000000000-abc',
    ]);
    // the emptied postprocessor/ dir is removed with its last file.
    await expect(stat(join(out, 'yt_dlp_plugins', 'postprocessor'))).rejects.toThrow();
  });

  it('removes the assets once no feeding provider contributes them (the library stopped being fed)', async () => {
    await projectDownloaderAssets(projectionDir, [provider('fakepelo')], { assetRoot });
    await writeFile(join(projectionDir, 'subscriptions.yaml'), 'untouched');

    const result = await projectDownloaderAssets(projectionDir, [], { assetRoot });
    expect(result.removed).toEqual([PLUGIN]);
    await expect(stat(join(projectionDir, '.ytdrivarr'))).rejects.toThrow();
    // only the ytdrivarr-owned asset dir is touched, never the rest of the projection.
    expect(await readFile(join(projectionDir, 'subscriptions.yaml'), 'utf8')).toBe('untouched');
  });

  it('merges two providers into one namespace tree; the same path with different bytes is an error', async () => {
    await writeTree(join(assetRoot, 'other', 'ytdlp-plugins'), {
      'yt_dlp_plugins/extractor/other_extractor.py': 'OTHER = 1\n',
    });
    const merged = await projectDownloaderAssets(
      projectionDir,
      [provider('fakepelo'), provider('other')],
      { assetRoot },
    );
    expect(merged.written.sort()).toEqual([
      PLUGIN,
      'ytdlp-plugins/yt_dlp_plugins/extractor/other_extractor.py',
    ]);

    await writeTree(join(assetRoot, 'other', 'ytdlp-plugins'), {
      'yt_dlp_plugins/extractor/fake_extractor.py': 'DIFFERENT\n',
    });
    await expect(
      projectDownloaderAssets(projectionDir, [provider('fakepelo'), provider('other')], {
        assetRoot,
      }),
    ).rejects.toThrow(/conflict.*fakepelo.*other.*fake_extractor\.py/);
  });

  it('a declared tree missing on disk is a LOUD error, never a silent skip', async () => {
    await expect(
      projectDownloaderAssets(projectionDir, [provider('ghost')], { assetRoot }),
    ).rejects.toThrow(/downloader asset dir missing for provider "ghost".*YTDRIVARR_ASSETS_DIR/);
    await expect(assertDownloaderAssets([provider('ghost')], assetRoot)).rejects.toThrow(
      /missing for provider "ghost"/,
    );
  });

  it('the boot guard also refuses a declared tree that ships no files', async () => {
    await mkdir(join(assetRoot, 'empty', 'ytdlp-plugins', 'yt_dlp_plugins'), { recursive: true });
    await expect(assertDownloaderAssets([provider('empty')], assetRoot)).rejects.toThrow(
      /has no files/,
    );
    expect(await assertDownloaderAssets([provider('fakepelo')], assetRoot)).toEqual({
      assetRoot,
      files: 1,
    });
  });
});

describe('resolveAssetRoot — env override, bundle layout, source tree', () => {
  it('the env override is authoritative', () => {
    expect(resolveAssetRoot({ [ASSETS_DIR_ENV]: '/custom/assets' }, '/app/dist')).toBe(
      '/custom/assets',
    );
  });

  it('prefers <bundle dir>/assets (dist/index.js beside dist/assets) when it exists', async () => {
    const dist = join(root, 'dist');
    await mkdir(join(dist, 'assets'), { recursive: true });
    expect(resolveAssetRoot({}, dist)).toBe(join(dist, 'assets'));
  });

  it('falls back to the source tree (src/core → src/providers) for dev/vitest', () => {
    expect(resolveAssetRoot({})).toBe(join(repoRoot, 'src', 'providers'));
  });
});

describe('which libraries are fed — provider declarations', () => {
  it('Peloton contributes its yt-dlp plugin tree; YouTube and the URL-list provider contribute nothing', () => {
    expect(pelotonProvider.downloaderAssets).toEqual(['ytdlpPlugins']);
    expect(youtubeProvider.downloaderAssets ?? []).toEqual([]);
    expect(inCoreUrlListProvider.downloaderAssets ?? []).toEqual([]);
  });

  it('feedingProviders = the providers with at least one ENABLED source in the library', () => {
    const ids = (sources: { providerId: string; enabled: boolean }[]) =>
      feedingProviders(sources).map((p) => p.id);
    expect(ids([{ providerId: 'youtube', enabled: true }])).toEqual(['youtube']);
    expect(
      ids([
        { providerId: 'youtube', enabled: true },
        { providerId: 'peloton', enabled: false },
        { providerId: 'peloton', enabled: true },
      ]).sort(),
    ).toEqual(['peloton', 'youtube']);
    // every Peloton activity unmonitored → Peloton no longer feeds it (nothing of it is emitted).
    expect(ids([{ providerId: 'peloton', enabled: false }])).toEqual([]);
    // a source of a provider no longer in the registry contributes nothing (never throws here).
    expect(ids([{ providerId: 'retired', enabled: true }])).toEqual([]);
  });

  it('validateProvider rejects an unknown downloader asset kind', () => {
    const bad = { ...youtubeProvider, downloaderAssets: ['nope'] } as unknown as SourceProvider;
    expect(() => validateProvider(bad)).toThrow(/unknown downloader asset kind "nope"/);
  });
});

describe('the real Peloton plugin tree ships from source AND from the `pnpm build` layout', () => {
  it('resolves from the source tree (dev/vitest) and passes the boot guard', async () => {
    const { files } = await assertDownloaderAssets(listProviders());
    expect(files).toBeGreaterThan(0);
  });

  it('scripts/build-assets.mjs copies every declared tree into dist/assets/<id>/<dir>, minus bytecode', async () => {
    const out = join(root, 'dist', 'assets');
    await promisify(execFile)(process.execPath, [
      join(repoRoot, 'scripts', 'build-assets.mjs'),
      out,
    ]);
    // the bundle layout satisfies the same boot guard the image runs.
    await assertDownloaderAssets(listProviders(), out);
    for (const p of listProviders()) {
      for (const kind of p.downloaderAssets ?? []) {
        const built = await listFiles(join(out, p.id, DOWNLOADER_ASSET_DIRS[kind]));
        expect(built.length).toBeGreaterThan(0);
        expect(built.some((f) => f.includes('__pycache__') || f.endsWith('.pyc'))).toBe(false);
        expect(built.every((f) => f.startsWith('yt_dlp_plugins/'))).toBe(true);
      }
    }
    // projecting from the built layout lands the plugin where the downloader looks for it.
    const result = await projectDownloaderAssets(projectionDir, [pelotonProvider], {
      assetRoot: out,
    });
    expect(result.written.length).toBeGreaterThan(0);
    expect(
      result.written.every((f) => f.startsWith('ytdlp-plugins/yt_dlp_plugins/extractor/')),
    ).toBe(true);
  });
});
