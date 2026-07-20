import { eq } from 'drizzle-orm';
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
