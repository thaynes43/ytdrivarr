import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { sourceAuditActionEnum } from './enums';

/**
 * Audit Row (DESIGN-045 D-08; hard rule 6 applied service-side) — every Source mutation writes one
 * of these in the SAME transaction as the mutation it records. This is the MACHINE-LEVEL change
 * history: scoped to the calling API key (`apiKeyId`), with NO user identity (the service has no
 * user management — D-21). The user-attributed audit lives app-side in haynesnetwork (D-18).
 *
 * `sourceId` is intentionally NOT a FK: a delete's audit row must survive the row it records, so
 * the trail is not cascade-deleted with the Source.
 */
export const sourceAudit = pgTable(
  'source_audit',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id').notNull(),
    action: sourceAuditActionEnum('action').notNull(),
    /** a label/fingerprint of the calling API key — machine-level, never a member (D-08/D-21). */
    apiKeyId: text('api_key_id').notNull().default('api'),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('source_audit_source_id_idx').on(t.sourceId)],
);

export type SourceAuditRow = typeof sourceAudit.$inferSelect;
export type NewSourceAuditRow = typeof sourceAudit.$inferInsert;
