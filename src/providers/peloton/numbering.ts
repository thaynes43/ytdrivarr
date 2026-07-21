/**
 * Peloton numbering + classId extraction (DESIGN-045 D-06) — ported from the donor
 * `scraper_strategy.py` (`extract_duration_from_title` lines 187-201; the per-duration episode
 * counter lines 98-114) and `episodes_from_subscriptions.py` (classId extraction, lines 262-272).
 *
 * TWO parity decisions the donor left latent, resolved here (Q-03 §"Peloton logic"):
 *
 *  1. RAW duration, NOT rounded. `season_number = duration` from the RAW `^\s*(\d+)\s*min` parse;
 *     the donor's `round(d/5)*5` default (`media_source_strategy.py`) is DEAD CODE the scrape path
 *     never reaches. Keep RAW.
 *  2. GLOBAL per-duration episode numbering — the numbering state is keyed by DURATION ONLY (this is
 *     the M3 interface CONTRACT the out-of-process worker consumes: `episodeNumbering:{<duration>:
 *     <max>}`). `season_number` IS the duration in minutes; the seed for each duration is the current
 *     max episode across ALL activities of that duration and the worker continues that one sequence
 *     (donor pre-increment: a duration whose max is E7 gives the next new class E8).
 *
 *  NOTE (integration risk, flagged to the coordinator): the donor's `application.py` rebuilds the
 *  numbering dict PER ACTIVITY from that activity's own `max_episode`, and the live file's disjoint
 *  per-activity episode blocks at a shared season (e.g. season 30: Cardio E221-222 vs Cycling
 *  E2026-2150, with large gaps) are more consistent with PER-(activity,duration) counters than one
 *  shared duration counter. This module implements the flat duration-keyed CONTRACT as specified
 *  (so it matches the parallel worker's payload shape); if the estate needs per-activity continuation
 *  the contract must change on BOTH sides together.
 */

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

/** The shape an existing persisted entry contributes to the numbering seed (season = duration). */
export interface NumberedLike {
  seasonNumber: number | null;
  episodeNumber: number | null;
}

/**
 * The GLOBAL-per-duration seed the discovery payload carries to the worker (the CONTRACT shape
 * `{<duration>: <max>}`): for each duration (= season_number) present in the source's persisted
 * entries, the CURRENT MAX episode number across ALL activities of that duration. The worker
 * continues each duration's sequence from this max.
 */
export function episodeNumberingFromEntries(
  entries: readonly NumberedLike[],
): Record<string, number> {
  const maxByDuration: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.seasonNumber === null || entry.episodeNumber === null) continue;
    const key = String(entry.seasonNumber);
    if ((maxByDuration[key] ?? 0) < entry.episodeNumber) maxByDuration[key] = entry.episodeNumber;
  }
  return maxByDuration;
}

/**
 * The canonical next-episode rule the worker mirrors (donor pre-increment): given the running
 * per-duration max map and a duration, return the next episode number AND record it back so the next
 * class of the same duration continues the sequence. Keyed by duration ONLY (the GLOBAL-per-duration
 * contract). Kept core-side as the parity reference + for tests.
 */
export function nextEpisodeNumber(numbering: Record<string, number>, duration: number): number {
  const key = String(duration);
  const next = (numbering[key] ?? 0) + 1;
  numbering[key] = next;
  return next;
}
