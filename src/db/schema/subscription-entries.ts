import { pgTable, uuid, text, jsonb, integer, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { sources } from './sources';

/**
 * SubscriptionEntry (T-217 / DESIGN-045 D-06) — the persisted, deduped output of discovery: one
 * ytdl-sub subscription row. Season/episode numbers, once published, are IMMUTABLE (Plex/Jellyfin
 * matching breaks on re-key — the repo's IDs-never-renumbered doctrine, Q-02 §6 #8); the emitter's
 * numbering guard preserves them across re-renders. `entryKey` is unique per source (the dedup key).
 */
export const subscriptionEntries = pgTable(
  'subscription_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    entryKey: text('entry_key').notNull(),
    displayName: text('display_name').notNull(),
    downloadRef: text('download_ref').notNull(),
    preset: text('preset').notNull(),
    chip: text('chip'),
    overrides: jsonb('overrides').$type<Record<string, unknown>>(),
    ytdlOptions: jsonb('ytdl_options').$type<Record<string, unknown>>(),
    assets: jsonb('assets').$type<Record<string, unknown>>(),
    /** immutable-once-published numbering, denormalized from overrides for the re-key guard. */
    seasonNumber: integer('season_number'),
    episodeNumber: integer('episode_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('subscription_entries_source_key_uq').on(t.sourceId, t.entryKey),
    index('subscription_entries_source_id_idx').on(t.sourceId),
  ],
);

export type SubscriptionEntryRow = typeof subscriptionEntries.$inferSelect;
export type NewSubscriptionEntryRow = typeof subscriptionEntries.$inferInsert;
