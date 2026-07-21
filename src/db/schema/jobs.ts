import { pgTable, uuid, text, jsonb, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { jobKindEnum, jobStatusEnum } from './enums';
import { runs } from './runs';

/**
 * The out-of-process transport job table (DESIGN-045 D-03) — the SEAM ONLY. When an
 * `out_of_process` provider's discovery/remediation is dispatched, the core enqueues a row here;
 * a plugin-owned worker container would claim it (claim/heartbeat columns), do the credentialed
 * scrape, and report back. M1 ships the table + the enqueue path; there is NO Peloton worker yet
 * (that is M3). The core NEVER imports Selenium — this table is the whole contract.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: jobKindEnum('kind').notNull(),
    providerId: text('provider_id').notNull(),
    /** the discovery/remediation Run this job finalizes (M3) — nullable for the M1 enqueue seam and
     * for jobs never tied to a Run. The worker's report/fail path finalizes this Run (D-03/D-10). */
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatusEnum('status').notNull().default('queued'),
    // --- claim / heartbeat protocol (the transport seam) ---
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('jobs_status_idx').on(t.status)],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
