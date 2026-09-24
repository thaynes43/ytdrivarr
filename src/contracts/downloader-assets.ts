/**
 * Downloader assets (issue #40) — files a provider CONTRIBUTES to the downloader of every Library it
 * feeds, so ytdrivarr hands ytdl-sub everything that provider's entries need, not just the YAML.
 * Provider-specific logic (a Peloton yt-dlp extractor override) therefore reaches ONLY the Libraries
 * a provider actually feeds; a YouTube-only Library gets nothing.
 *
 * Each kind maps to ONE directory name used on both sides of the copy:
 *   - source:    `<asset root>/<providerId>/<dir>` — `src/providers/<id>/<dir>` in the source tree,
 *                `dist/assets/<id>/<dir>` in the bundle (`scripts/build-assets.mjs` copies it);
 *   - projected: `<projectionDir>/.ytdrivarr/<dir>` — beside the Library's `subscriptions.yaml`,
 *                mirrored on every projection (`src/core/downloader-assets.ts`).
 *
 * - `ytdlpPlugins` — a yt-dlp plugin namespace tree (`yt_dlp_plugins/extractor/*.py`). The downloader
 *   puts `<projectionDir>/.ytdrivarr/ytdlp-plugins` on yt-dlp's plugin search path.
 */
export const DOWNLOADER_ASSET_DIRS = {
  ytdlpPlugins: 'ytdlp-plugins',
} as const;

export type DownloaderAssetKind = keyof typeof DOWNLOADER_ASSET_DIRS;

/** The ytdrivarr-owned directory inside a Library's projection dir that downloader assets land in. */
export const PROJECTED_ASSETS_DIR = '.ytdrivarr';

export function isDownloaderAssetKind(kind: string): kind is DownloaderAssetKind {
  return Object.hasOwn(DOWNLOADER_ASSET_DIRS, kind);
}
