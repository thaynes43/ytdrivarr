import { count, eq } from 'drizzle-orm';
import { subscriptionEntries, type SubscriptionEntryRow } from '../db/schema';
import { inTransaction, resolveDb } from '../db/client';
import type { Database, DbClient } from '../db';
import { numberFromOverrides, type PublishedNumbering } from '../core/dedup';
import type { SubscriptionEntry } from '../contracts';

/**
 * Persist the deduped + numbered SubscriptionEntries for a Source (DESIGN-045 D-06). The CORE owns
 * this — providers only produce entries. `replaceEntriesForSource` reflects removals (entries no
 * longer discovered disappear) while the caller re-stamps prior numbering first, so the
 * delete+insert can never renumber a surviving item.
 */

export async function loadPublishedNumbering(
  sourceId: string,
  exec?: DbClient,
): Promise<Map<string, PublishedNumbering>> {
  const d = resolveDb(exec) as Database;
  const rows = await d
    .select({
      entryKey: subscriptionEntries.entryKey,
      season: subscriptionEntries.seasonNumber,
      episode: subscriptionEntries.episodeNumber,
    })
    .from(subscriptionEntries)
    .where(eq(subscriptionEntries.sourceId, sourceId));
  const map = new Map<string, PublishedNumbering>();
  for (const row of rows) {
    map.set(row.entryKey, { season: row.season, episode: row.episode });
  }
  return map;
}

export async function replaceEntriesForSource(
  sourceId: string,
  entries: SubscriptionEntry[],
  exec?: DbClient,
): Promise<SubscriptionEntryRow[]> {
  return inTransaction(exec, async (tx) => {
    await tx.delete(subscriptionEntries).where(eq(subscriptionEntries.sourceId, sourceId));
    if (entries.length === 0) return [];
    const values = entries.map((entry) => ({
      sourceId,
      entryKey: entry.entryKey,
      displayName: entry.displayName,
      downloadRef: entry.downloadRef,
      preset: entry.preset,
      chip: entry.chip ?? null,
      overrides: entry.overrides ?? null,
      ytdlOptions: entry.ytdlOptions ?? null,
      assets: entry.assets ?? null,
      seasonNumber: numberFromOverrides(entry, 'season_number'),
      episodeNumber: numberFromOverrides(entry, 'episode_number'),
    }));
    return tx.insert(subscriptionEntries).values(values).returning();
  });
}

export async function listEntriesForSource(
  sourceId: string,
  exec?: DbClient,
): Promise<SubscriptionEntryRow[]> {
  const d = resolveDb(exec) as Database;
  return d.select().from(subscriptionEntries).where(eq(subscriptionEntries.sourceId, sourceId));
}

/** Per-source entry tallies in one grouped query — the console Sources table's Entries column. */
export async function countEntriesBySource(exec?: DbClient): Promise<Map<string, number>> {
  const d = resolveDb(exec) as Database;
  const rows = await d
    .select({ sourceId: subscriptionEntries.sourceId, entries: count() })
    .from(subscriptionEntries)
    .groupBy(subscriptionEntries.sourceId);
  return new Map(rows.map((r) => [r.sourceId, Number(r.entries)]));
}

export interface MergeEntriesResult {
  added: number;
  updated: number;
  total: number;
}

/**
 * MERGE (upsert) entries for a Source WITHOUT wiping its existing rows (DESIGN-045 D-06). This is
 * the out-of-process report path (D-03): a Peloton scrape returns only the NEW classes it found, so
 * `replaceEntriesForSource` semantics would delete every prior class. Instead we upsert by the
 * `(sourceId, entryKey)` identity — new classes insert, an already-known classId updates in place.
 * The caller MUST have already run `preservePublishedNumbering` so a re-reported class keeps its
 * immutable season/episode (the re-key guard, Q-02 §6 #8); this writer never renumbers on its own.
 */
export async function mergeEntriesForSource(
  sourceId: string,
  entries: SubscriptionEntry[],
  exec?: DbClient,
): Promise<MergeEntriesResult> {
  if (entries.length === 0) {
    return { added: 0, updated: 0, total: 0 };
  }
  return inTransaction(exec, async (tx) => {
    const existing = await tx
      .select({ entryKey: subscriptionEntries.entryKey })
      .from(subscriptionEntries)
      .where(eq(subscriptionEntries.sourceId, sourceId));
    const known = new Set(existing.map((r) => r.entryKey));

    let added = 0;
    let updated = 0;
    for (const entry of entries) {
      const values = {
        sourceId,
        entryKey: entry.entryKey,
        displayName: entry.displayName,
        downloadRef: entry.downloadRef,
        preset: entry.preset,
        chip: entry.chip ?? null,
        overrides: entry.overrides ?? null,
        ytdlOptions: entry.ytdlOptions ?? null,
        assets: entry.assets ?? null,
        seasonNumber: numberFromOverrides(entry, 'season_number'),
        episodeNumber: numberFromOverrides(entry, 'episode_number'),
      };
      if (known.has(entry.entryKey)) updated += 1;
      else added += 1;
      await tx
        .insert(subscriptionEntries)
        .values(values)
        .onConflictDoUpdate({
          target: [subscriptionEntries.sourceId, subscriptionEntries.entryKey],
          set: {
            displayName: values.displayName,
            downloadRef: values.downloadRef,
            preset: values.preset,
            chip: values.chip,
            overrides: values.overrides,
            ytdlOptions: values.ytdlOptions,
            assets: values.assets,
            seasonNumber: values.seasonNumber,
            episodeNumber: values.episodeNumber,
            updatedAt: new Date(),
          },
        });
    }
    return { added, updated, total: known.size + added };
  });
}
