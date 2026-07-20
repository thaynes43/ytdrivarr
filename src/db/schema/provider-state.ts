import { pgTable, uuid, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * C5 (DESIGN-045 D-08) — each provider's durable, namespaced state area. YouTube's real state is
 * the Source list; a heavy provider (Peloton) parks machine state here (last bearer metadata,
 * scrape history, dedup ids). Keyed by (namespace, key). The `ProviderStateStore` the core injects
 * is a thin scoped view over this table.
 */
export const providerState = pgTable(
  'provider_state',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('provider_state_ns_key_uq').on(t.namespace, t.key)],
);

export type ProviderStateRow = typeof providerState.$inferSelect;
export type NewProviderStateRow = typeof providerState.$inferInsert;
