import { pgTable, uuid, text, jsonb, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { mediaKindEnum } from './enums';
import { libraries } from './libraries';

/**
 * Source (T-215 / DESIGN-045 D-02) — a subscribe-able content origin the service manages, and the
 * cross-Library identity ytdl-sub has no representation for (dedup is the service's job). `ref` is
 * the provider-specific handle (a YouTube channel URL; a Peloton discipline). A Source is what a
 * member's Edit mutates (D-18). Every mutation writes an audit row in the SAME transaction (D-08)
 * — enforced by the single-writer in `src/domain/sources.ts` and its guard test.
 */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    /** the registered provider id (the typed registry key — D-04). */
    providerId: text('provider_id').notNull(),
    /** the provider's source class/kind. */
    kind: text('kind').notNull(),
    /** video | music, set at subscribe time — drives the preset family (D-12). */
    mediaKind: mediaKindEnum('media_kind').notNull().default('video'),
    displayName: text('display_name').notNull(),
    ref: text('ref').notNull(),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    /** the machine-level creator marker (the calling API key label; NO user identity — D-21). */
    createdBy: text('created_by').notNull().default('api'),
    /** opaque caps context the app attaches (role/cap at add-time); the service does not interpret it. */
    capsContext: jsonb('caps_context').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('sources_library_id_idx').on(t.libraryId)],
);

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
