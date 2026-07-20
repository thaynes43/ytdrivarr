import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { remediationActionEnum, remediationStatusEnum } from './enums';
import { sources } from './sources';

/**
 * RemediationJob (T-220 / DESIGN-045 D-09) — the per-item Fix unit (the WHY of the *arr shape).
 * For a URL source this is a stateless re-download; for Peloton an auth-gated re-fetch (M5). First
 * class so the app can poll status. `requestedBy` is the machine-level caller (API key), NOT a
 * member — all user attribution is app-side (D-08/D-18). M1 lands the table + the read/CRUD seam.
 */
export const remediationJobs = pgTable(
  'remediation_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    entryKey: text('entry_key').notNull(),
    action: remediationActionEnum('action').notNull(),
    status: remediationStatusEnum('status').notNull().default('queued'),
    requestedBy: text('requested_by').notNull().default('api'),
    /** the out-of-process worker run this dispatched to, if any (D-03). */
    providerRunId: uuid('provider_run_id'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('remediation_jobs_source_id_idx').on(t.sourceId)],
);

export type RemediationJob = typeof remediationJobs.$inferSelect;
export type NewRemediationJob = typeof remediationJobs.$inferInsert;
