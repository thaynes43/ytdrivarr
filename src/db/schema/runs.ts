import { pgTable, uuid, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { runScopeEnum, runTriggerEnum, runStatusEnum } from './enums';

/**
 * Run (T-219 / DESIGN-045 D-02/D-10) — a first-class discovery/emit record. Runs are how health
 * surfaces: `telemetry` carries selector-drift hits + credential age; `counts` carries
 * discovered/new/deduped/emitted. This is the machine-level change history (D-08) — no user identity.
 */
export const runs = pgTable('runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  scope: runScopeEnum('scope').notNull(),
  /** the library or source id the scope points at (null for scope='all'). */
  scopeRef: uuid('scope_ref'),
  trigger: runTriggerEnum('trigger').notNull(),
  providerId: text('provider_id'),
  status: runStatusEnum('status').notNull().default('running'),
  counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
  telemetry: jsonb('telemetry').$type<Record<string, unknown>>().notNull().default({}),
  /** the owner's daily-review summary (D-10) — the structured Changes/Health/Issues object the
   * run-summary renderer builds on finalize; nullable so an in-flight run carries none yet. */
  summary: jsonb('summary').$type<Record<string, unknown>>(),
  logExcerpt: text('log_excerpt'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
