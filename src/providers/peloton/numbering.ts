/**
 * Peloton numbering + classId extraction (DESIGN-045 D-06) — ported from the donor
 * `scraper_strategy.py` (`extract_duration_from_title` lines 187-201) and `application.py`
 * (the per-activity episode counter, lines 341-386, seeded from `ActivityData.max_episode`,
 * `core/models.py:30` — `Dict[int, int]  # season -> highest episode number`).
 *
 * TWO parity decisions the donor left latent, resolved here (Q-03 §"Peloton logic"):
 *
 *  1. RAW duration, NOT rounded. `season_number = duration` from the RAW `^\s*(\d+)\s*min` parse;
 *     the donor's `round(d/5)*5` default (`media_source_strategy.py`) is DEAD CODE the scrape path
 *     never reaches. Keep RAW (35 stays 35, 22 stays 22).
 *  2. PER-ACTIVITY, per-duration episode numbering (the CORRECTED M3 interface contract — supersedes
 *     the earlier flat global-per-duration model). The donor `application.py` (lines 341-347) rebuilds
 *     the numbering dict PER ACTIVITY: `episode_numbering = dict(merged_data[activity].max_episode)` —
 *     a fresh `{season(=duration): max_episode}` dict seeded from THAT activity's own per-season max
 *     (merged across disk + subscriptions), handed to that activity's ScrapingConfig. So the seed the
 *     out-of-process worker consumes is nested:
 *
 *         episodeNumbering: { [activitySlug]: { [durationString]: maxEpisode } }
 *
 *     Each activity continues ITS OWN sequence (donor pre-increment): cardio S30 max E222 → next E223
 *     while cycling S30 max E2150 → next E2151 — disjoint bands at the SAME season, impossible under
 *     one shared duration counter. The live file proves it: within a single 15-day purge window,
 *     season 30 carries Cardio E221-222 alongside Cycling E2026-2150. This module and the parallel
 *     worker's payload shape are changed together to match EXACTLY.
 */

import { activitySlugFromChip } from './folder-mapping';

/**
 * The per-activity, per-duration numbering seed the discovery payload carries to the worker (the
 * CONTRACT shape): `{ [activitySlug]: { [durationString]: maxEpisode } }`. Duration keys are
 * stringified integers (JSON object keys); values are the current MAX `episode_number` for that
 * (activity, duration). Mirrors the donor `Dict[Activity, ActivityData]` where each activity's
 * `ActivityData.max_episode` is `Dict[int, int]` (season → highest episode).
 */
export type NestedNumbering = Record<string, Record<string, number>>;

/**
 * Parse the class duration in minutes from a Peloton class title — RAW minutes (donor
 * `extract_duration_from_title`): primary `^\s*(\d+)\s*min` (case-insensitive), fallback the first
 * bare integer anywhere, else 0.
 */
export function parseDurationMinutes(title: string): number {
  const primary = /^\s*(\d+)\s*min/i.exec(title);
  if (primary?.[1]) return Number.parseInt(primary[1], 10);
  const fallback = /\b(\d+)\b/.exec(title);
  if (fallback?.[1]) return Number.parseInt(fallback[1], 10);
  return 0;
}

/**
 * Extract the Peloton classId from a download/player URL, matching the donor's string ops for BOTH
 * URL forms:
 *   - `.../classes/player/{classId}` → substring after the LAST `/classes/player/`, cut at `?`/`#`.
 *   - `...?classId={classId}&...`    → substring after `classId=`, cut at the first `&`.
 * Returns undefined when neither form is present (the caller decides whether that's an error).
 */
export function extractClassId(url: string): string | undefined {
  if (url.includes('/classes/player/')) {
    const afterPath = url.split('/classes/player/').at(-1) ?? '';
    const classId = afterPath.split('?')[0]?.split('#')[0] ?? '';
    return classId.length > 0 ? classId : undefined;
  }
  if (url.includes('classId=')) {
    const afterParam = url.split('classId=').at(-1) ?? '';
    const classId = afterParam.split('&')[0] ?? '';
    return classId.length > 0 ? classId : undefined;
  }
  return undefined;
}

/** Build the per-class player URL the emitted `download:` carries (donor scraper_strategy line 111). */
export function playerUrl(classId: string): string {
  return `https://members.onepeloton.com/classes/player/${classId}`;
}

/**
 * The shape an existing persisted entry contributes to the numbering seed. `chip` (the
 * `= {Activity} ({N} min)` group label WITHOUT the leading `= `) carries the activity — resolved to
 * its canonical slug via `activitySlugFromChip`; `seasonNumber` IS the duration in minutes.
 */
export interface NumberedLike {
  chip: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

/**
 * The per-(activity, duration) seed the discovery payload carries to the worker: for each activity
 * present in the source's persisted entries, the CURRENT MAX episode number per duration. The worker
 * continues each activity's own duration sequence from this max. Entries whose activity slug can't be
 * resolved from their chip, or with null numbering, contribute to no activity bucket (donor: an
 * unmapped activity is dropped, `activity_based_path_strategy._map_activity_name` → None).
 */
export function episodeNumberingFromEntries(entries: readonly NumberedLike[]): NestedNumbering {
  const result: NestedNumbering = {};
  for (const entry of entries) {
    if (entry.seasonNumber === null || entry.episodeNumber === null) continue;
    const slug = activitySlugFromChip(entry.chip);
    if (!slug) continue;
    const durationKey = String(entry.seasonNumber);
    const byDuration = (result[slug] ??= {});
    if ((byDuration[durationKey] ?? 0) < entry.episodeNumber) {
      byDuration[durationKey] = entry.episodeNumber;
    }
  }
  return result;
}

/**
 * Merge two nested numbering maps taking the MAX episode per (activity, duration) key (donor
 * `ActivityData.merge_collections`, `core/models.py:53-71` — `max(ep1, ep2)` per season per
 * activity). Used to fold the optional disk scan into the subscription-derived seed (D-06). Disjoint
 * keys from either side survive; where both carry a key, the larger episode wins. Neither input is
 * mutated.
 */
export function mergeNumbering(a: NestedNumbering, b: NestedNumbering): NestedNumbering {
  const result: NestedNumbering = {};
  for (const source of [a, b]) {
    for (const [slug, byDuration] of Object.entries(source)) {
      const target = (result[slug] ??= {});
      for (const [durationKey, episode] of Object.entries(byDuration)) {
        if ((target[durationKey] ?? 0) < episode) target[durationKey] = episode;
      }
    }
  }
  return result;
}

/**
 * The canonical next-episode rule the worker mirrors (donor pre-increment,
 * `ActivityData.get_next_episode` = `max_episode.get(season, 0) + 1`): given the running per-activity
 * nested max map, an activity slug, and a duration, return the next episode number AND record it back
 * so the next class of the SAME (activity, duration) continues the sequence. Keyed by (activity,
 * duration) so each activity advances independently. Kept core-side as the parity reference + tests.
 */
export function nextEpisodeNumber(
  numbering: NestedNumbering,
  activity: string,
  duration: number,
): number {
  const byDuration = (numbering[activity] ??= {});
  const key = String(duration);
  const next = (byDuration[key] ?? 0) + 1;
  byDuration[key] = next;
  return next;
}
