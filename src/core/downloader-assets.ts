import { statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOWNLOADER_ASSET_DIRS,
  PROJECTED_ASSETS_DIR,
  type DownloaderAssetKind,
  type SourceProvider,
} from '../contracts';
import type { Source } from '../db/schema';
import { logger } from '../logger';
import { atomicWrite } from './projection';
import { listProviders } from './registry';

/**
 * Downloader-asset projection (issue #40 — `contracts/downloader-assets.ts`). A provider declares
 * `downloaderAssets`; on EVERY projection of a Library the core mirrors the trees of the providers
 * that FEED it (≥1 enabled Source) into `<projectionDir>/.ytdrivarr/<kind dir>/`, next to the
 * Library's `subscriptions.yaml`, so the downloader that mounts the projection gets the provider's
 * files with the YAML. Live: the Peloton Library projects to `/projections/peloton` (the downloader's
 * `/media/peloton`), so its yt-dlp plugin lands at
 * `/media/peloton/.ytdrivarr/ytdlp-plugins/yt_dlp_plugins/extractor/ytdrivarr_peloton.py`.
 *
 * Each kind dir under `.ytdrivarr/` is OWNED by this projection: files are written with the same
 * atomic write-temp-then-rename as the YAML (skipped when the bytes are unchanged), files no feeding
 * provider ships any more are pruned (a renamed plugin must never linger and double-register), and a
 * Library no provider contributes to has the kind dir removed. Python's `__pycache__` (the
 * downloader may write one beside a plugin) and in-flight `.tmp-` siblings are left alone.
 *
 * A declared tree that is missing on disk is a LOUD error — at boot (`assertDownloaderAssets`, a
 * misbuilt image fails to start) and on every projection — never a silent skip: without the plugin
 * the downloader silently falls back to the broken built-in extractor.
 */

/** Env override for the provider asset root (authoritative when set). */
export const ASSETS_DIR_ENV = 'YTDRIVARR_ASSETS_DIR';

/**
 * Resolve the provider asset root — the directory holding `<providerId>/<kind dir>/` trees.
 * `YTDRIVARR_ASSETS_DIR` wins when set; otherwise `<bundle dir>/assets` (production: `dist/index.js`
 * beside `dist/assets/`, which `scripts/build-assets.mjs` fills during `pnpm build`), else the
 * source tree `src/providers` (dev / vitest: this module runs from `src/core/`).
 */
export function resolveAssetRoot(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  const override = env[ASSETS_DIR_ENV]?.trim();
  if (override) return override;
  const bundled = join(moduleDir, 'assets');
  return isDirSync(bundled) ? bundled : join(moduleDir, '..', 'providers');
}

/** One provider's declared asset tree, resolved to a directory on disk. */
export interface DownloaderAssetSource {
  providerId: string;
  kind: DownloaderAssetKind;
  dir: string;
}

type AssetProvider = Pick<SourceProvider, 'id' | 'downloaderAssets'>;

/** Resolve every declared tree of `providers` under `assetRoot`; a missing tree THROWS. */
export async function resolveDownloaderAssetSources(
  providers: readonly AssetProvider[],
  assetRoot: string = resolveAssetRoot(),
): Promise<DownloaderAssetSource[]> {
  const sources: DownloaderAssetSource[] = [];
  for (const provider of providers) {
    for (const kind of provider.downloaderAssets ?? []) {
      const dirName = DOWNLOADER_ASSET_DIRS[kind];
      const dir = join(assetRoot, provider.id, dirName);
      if (!(await isDir(dir))) {
        throw new Error(
          `downloader asset dir missing for provider "${provider.id}" (${kind}): ${dir} — ` +
            `asset root ${assetRoot}; set ${ASSETS_DIR_ENV} or rebuild (\`pnpm build\` copies ` +
            `src/providers/${provider.id}/${dirName} into dist/assets)`,
        );
      }
      sources.push({ providerId: provider.id, kind, dir });
    }
  }
  return sources;
}

/**
 * Boot guard: every registered provider's declared tree exists AND ships at least one file. Throws
 * otherwise, so a misbuilt image fails at startup instead of at the nightly projection.
 */
export async function assertDownloaderAssets(
  providers: readonly AssetProvider[] = listProviders(),
  assetRoot: string = resolveAssetRoot(),
): Promise<{ assetRoot: string; files: number }> {
  let files = 0;
  for (const source of await resolveDownloaderAssetSources(providers, assetRoot)) {
    const found = await listAssetFiles(source.dir);
    if (found.size === 0) {
      throw new Error(
        `downloader asset dir for provider "${source.providerId}" (${source.kind}) has no files: ${source.dir}`,
      );
    }
    files += found.size;
  }
  return { assetRoot, files };
}

/**
 * The providers FEEDING a Library: those with at least one ENABLED Source in it — exactly the
 * providers whose entries the projection can carry (an unmonitored Source contributes nothing to
 * `subscriptions.yaml`, so it contributes no assets either). Always the Library's WHOLE source list,
 * never a run's scope: a YouTube-scoped tick re-projects a mixed Library too.
 */
export function feedingProviders(
  sources: readonly Pick<Source, 'providerId' | 'enabled'>[],
): SourceProvider[] {
  const ids = new Set(sources.filter((s) => s.enabled).map((s) => s.providerId));
  return listProviders().filter((p) => ids.has(p.id));
}

export interface DownloaderAssetsProjection {
  /** `<projectionDir>/.ytdrivarr` */
  dir: string;
  /** paths (relative to `dir`, `/`-separated) written because they were new or changed. */
  written: string[];
  /** files already byte-identical (not rewritten). */
  unchanged: number;
  /** paths (relative to `dir`) pruned because no feeding provider ships them any more. */
  removed: string[];
}

/**
 * Mirror the declared trees of `providers` into `<projectionDir>/.ytdrivarr/`. Pass the providers
 * that FEED the Library (`feedingProviders`); an empty list removes whatever an earlier projection
 * left there. Two providers shipping the same path with different bytes is an error.
 */
export async function projectDownloaderAssets(
  projectionDir: string,
  providers: readonly AssetProvider[],
  opts: { assetRoot?: string } = {},
): Promise<DownloaderAssetsProjection> {
  const base = join(projectionDir, PROJECTED_ASSETS_DIR);
  const result: DownloaderAssetsProjection = { dir: base, written: [], unchanged: 0, removed: [] };
  const sources = await resolveDownloaderAssetSources(providers, opts.assetRoot);

  // desired content per kind dir: `<relative path>` → bytes (+ which provider shipped it).
  const desired = new Map<string, Map<string, { content: Buffer; providerId: string }>>();
  for (const source of sources) {
    const kindDir = DOWNLOADER_ASSET_DIRS[source.kind];
    const files =
      desired.get(kindDir) ?? new Map<string, { content: Buffer; providerId: string }>();
    desired.set(kindDir, files);
    for (const [rel, abs] of await listAssetFiles(source.dir)) {
      const content = await readFile(abs);
      const prior = files.get(rel);
      if (prior && !prior.content.equals(content)) {
        throw new Error(
          `downloader asset conflict: providers "${prior.providerId}" and "${source.providerId}" ` +
            `both ship ${kindDir}/${rel} with different content`,
        );
      }
      files.set(rel, { content, providerId: source.providerId });
    }
  }

  for (const kindDir of Object.values(DOWNLOADER_ASSET_DIRS)) {
    const target = join(base, kindDir);
    const files = desired.get(kindDir);

    if (!files || files.size === 0) {
      // Not fed by any contributing provider (any more): nothing of this kind may linger.
      if (await isDir(target)) {
        for (const rel of (await listAssetFiles(target)).keys()) {
          result.removed.push(posix.join(kindDir, rel));
        }
        await rm(target, { recursive: true, force: true });
      }
      continue;
    }

    for (const [rel, { content }] of files) {
      const path = join(target, ...rel.split('/'));
      const current = await readFile(path).catch(() => undefined);
      if (current?.equals(content)) {
        result.unchanged += 1;
        continue;
      }
      await mkdir(dirname(path), { recursive: true });
      await atomicWrite(path, content);
      result.written.push(posix.join(kindDir, rel));
    }

    // Prune what no feeding provider ships (a renamed/removed plugin must not stay loadable).
    for (const [rel, abs] of await listAssetFiles(target, { includeDotfiles: true })) {
      if (files.has(rel) || isInFlightTemp(rel)) continue;
      await rm(abs, { force: true });
      result.removed.push(posix.join(kindDir, rel));
    }
    await removeEmptyDirs(target);
  }

  // Drop an emptied `.ytdrivarr/` (ENOENT / ENOTEMPTY both mean there is nothing to do).
  await rmdir(base).catch(() => undefined);
  return result;
}

/** `projectDownloaderAssets` for a Library's full source list, logging what changed. */
export async function projectLibraryAssets(
  projectionDir: string,
  sources: readonly Pick<Source, 'providerId' | 'enabled'>[],
  opts: { assetRoot?: string } = {},
): Promise<DownloaderAssetsProjection> {
  const providers = feedingProviders(sources);
  const result = await projectDownloaderAssets(projectionDir, providers, opts);
  if (result.written.length > 0 || result.removed.length > 0) {
    logger.info(
      {
        dir: result.dir,
        providers: providers.map((p) => p.id),
        written: result.written,
        removed: result.removed,
        unchanged: result.unchanged,
      },
      'downloader assets projected',
    );
  }
  return result;
}

// --- fs helpers -------------------------------------------------------------------------------

/** Build/runtime junk never shipped or policed: Python bytecode caches. */
function isBytecode(name: string): boolean {
  return name === '__pycache__' || name.endsWith('.pyc');
}

/** An atomic write in flight (`<file>.tmp-<pid>-…`, projection.ts) — a concurrent projection's. */
function isInFlightTemp(rel: string): boolean {
  return /\.tmp-\d+-/.test(rel);
}

/**
 * Regular files under `root`, keyed by `/`-separated relative path, sorted. Skips bytecode caches
 * and symlinks; skips dotfiles (editor/OS junk) unless `includeDotfiles` (the prune walk, so stray
 * files in an owned dir are still removed).
 */
async function listAssetFiles(
  root: string,
  opts: { includeDotfiles?: boolean } = {},
): Promise<Map<string, string>> {
  const found: [string, string][] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (isBytecode(entry.name)) continue;
      if (!opts.includeDotfiles && entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(abs, rel);
      else if (entry.isFile()) found.push([rel, abs]);
    }
  };
  await walk(root, '');
  found.sort(([a], [b]) => a.localeCompare(b));
  return new Map(found);
}

/** Remove now-empty directories below `root` (post-order); `root` itself is kept. */
async function removeEmptyDirs(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || isBytecode(entry.name)) continue;
    const dir = join(root, entry.name);
    await removeEmptyDirs(dir);
    if ((await readdir(dir)).length === 0) await rmdir(dir).catch(() => undefined);
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isDirSync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
