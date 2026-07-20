import type { SubscriptionEntry } from '../contracts';

/**
 * Core-owned dedup (DESIGN-045 D-06; Q-02 §6 #2) — ytdl-sub dedups only WITHIN a subscription;
 * cross-source/library identity is the SERVICE's job. Collapse entries that share an `entryKey`,
 * keeping the first occurrence's identity (stable across re-renders).
 */
export function dedupEntries(entries: SubscriptionEntry[]): SubscriptionEntry[] {
  const byKey = new Map<string, SubscriptionEntry>();
  for (const entry of entries) {
    if (!byKey.has(entry.entryKey)) {
      byKey.set(entry.entryKey, entry);
    }
  }
  return [...byKey.values()];
}

export interface PublishedNumbering {
  season: number | null;
  episode: number | null;
}

/**
 * The IMMUTABLE season/episode guard (DESIGN-045 D-06; Q-02 §6 #8) — once published, numbering
 * must not change (Plex/Jellyfin matching breaks on re-key; the repo's IDs-never-renumbered
 * doctrine). Given freshly discovered entries and the numbering already published for their keys,
 * re-stamp the prior numbers so a re-discovery can never renumber an existing item.
 */
export function preservePublishedNumbering(
  entries: SubscriptionEntry[],
  published: Map<string, PublishedNumbering>,
): SubscriptionEntry[] {
  return entries.map((entry) => {
    const prior = published.get(entry.entryKey);
    if (!prior || (prior.season === null && prior.episode === null)) return entry;
    const overrides: Record<string, unknown> = { ...(entry.overrides ?? {}) };
    if (prior.season !== null) overrides.season_number = prior.season;
    if (prior.episode !== null) overrides.episode_number = prior.episode;
    return { ...entry, overrides };
  });
}

/** Read a numeric override (season_number/episode_number) off an entry, else null. */
export function numberFromOverrides(
  entry: SubscriptionEntry,
  key: 'season_number' | 'episode_number',
): number | null {
  const value = entry.overrides?.[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
