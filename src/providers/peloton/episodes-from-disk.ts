/**
 * Disk-aware episode numbering (DESIGN-045 D-06) — the DISK half of the donor's `merged_data`
 * (`file_manager.get_merged_episode_data` = disk ⊔ subscriptions, max per key). Ports
 * `io/peloton/episodes_from_disk.py` + `activity_based_path_strategy.py`:
 *
 *   - Walk `{scanRoot}` recursively; only LEAF directories are episode folders (donor `os.walk`
 *     `if dirs: continue` — a dir WITH subdirectories is an Activity/Instructor level, not an
 *     episode).
 *   - For a leaf path `{…}/{Activity}/{Instructor}/{S{season}E{episode} - {date} - {title}}`, parse
 *     `S(\d+)E(\d+)` from the leaf folder name (parts[-1]); activity = parts[-3] mapped via the
 *     activity map + bootcamp specials + the 50/50 inference (`mapActivityName`); instructor =
 *     parts[-2] (parsed by the donor, irrelevant to numbering).
 *   - Season IS the duration in minutes (same key space as the subscription seed), so the result
 *     nests identically: `{ [activitySlug]: { [durationString]: maxEpisode } }`.
 *
 * MALFORMED folders are SKIPPED, never fatal (donor returns None per unparseable path): a leaf with
 * no `SxxExx`, a path too short for Activity/Instructor/Episode, or an unmappable activity all drop
 * out silently. A missing `scanRoot` yields `{}` (donor warns + returns `{}`).
 */

import { readdirSync, type Dirent } from 'node:fs';
import { join, sep } from 'node:path';
import { mapActivityName } from './folder-mapping';
import type { NestedNumbering } from './numbering';

/** `S{season}E{episode}` anywhere in the leaf folder name (donor `re.search(r'S(\d+)E(\d+)')`). */
const EPISODE_RE = /S(\d+)E(\d+)/;

interface DiskEpisode {
  slug: string;
  season: number;
  episode: number;
}

/**
 * Parse a leaf directory path into `{ slug, season, episode }`, or undefined when it is not a valid
 * Peloton episode folder (donor `parse_episode_info`). Uses the FULL path tail: activity = parts[-3],
 * instructor = parts[-2], episode folder = parts[-1].
 */
function parseEpisodeFolder(dirPath: string): DiskEpisode | undefined {
  const parts = dirPath.split(sep);
  const folderName = parts.at(-1);
  if (!folderName) return undefined;

  const match = EPISODE_RE.exec(folderName);
  if (!match?.[1] || !match[2]) return undefined;
  const season = Number.parseInt(match[1], 10);
  const episode = Number.parseInt(match[2], 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return undefined;

  // Need at least {Activity}/{Instructor}/{Episode} (donor `len(parts) < 3` guard).
  const activityName = parts.at(-3);
  if (activityName === undefined) return undefined;

  const slug = mapActivityName(activityName);
  if (!slug) return undefined;

  return { slug, season, episode };
}

/**
 * Walk `dir` recursively, invoking `onLeaf` for every LEAF directory (one with no subdirectories).
 * Unreadable directories are skipped (never thrown) so a permissions blip or a race deleting a folder
 * mid-scan can't abort the whole scan.
 */
function walkLeafDirs(dir: string, onLeaf: (leafPath: string) => void): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs = entries.filter((e) => e.isDirectory());
  if (subdirs.length === 0) {
    onLeaf(dir);
    return;
  }
  for (const sub of subdirs) walkLeafDirs(join(dir, sub.name), onLeaf);
}

/**
 * Scan `scanRoot` for downloaded Peloton episode folders and return the per-(activity, duration)
 * episode maxima. In-cluster `scanRoot` is `/projections/peloton` (the core mounts the media tree at
 * `/projections`; the downloader sees the same tree at `/media/peloton`). A missing/empty tree yields
 * `{}`. The result is meant to be merged (`mergeNumbering`) with the subscription-derived seed.
 */
export function episodesFromDisk(scanRoot: string): NestedNumbering {
  const result: NestedNumbering = {};
  walkLeafDirs(scanRoot, (leafPath) => {
    const parsed = parseEpisodeFolder(leafPath);
    if (!parsed) return;
    const byDuration = (result[parsed.slug] ??= {});
    const key = String(parsed.season);
    if ((byDuration[key] ?? 0) < parsed.episode) byDuration[key] = parsed.episode;
  });
  return result;
}
