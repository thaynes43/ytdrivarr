import { pgEnum } from 'drizzle-orm/pg-core';

/** video | music — carried by both Source.mediaKind and Library.libraryKind (D-02/D-12). */
export const mediaKindEnum = pgEnum('media_kind', ['video', 'music']);

/** A Run's scope (D-02). */
export const runScopeEnum = pgEnum('run_scope', ['all', 'library', 'source']);
/** What triggered a Run (D-02). */
export const runTriggerEnum = pgEnum('run_trigger', ['cron', 'api', 'edit']);
/** A Run's terminal/interim status (D-02/D-10). */
export const runStatusEnum = pgEnum('run_status', ['running', 'ok', 'warn', 'error']);

/** RemediationJob action + status (D-09). */
export const remediationActionEnum = pgEnum('remediation_action', ['redownload', 'replace']);
export const remediationStatusEnum = pgEnum('remediation_status', [
  'queued',
  'running',
  'ok',
  'error',
]);

/** The out-of-process transport job table (D-03) — the seam only; NO Peloton worker in M1. */
export const jobKindEnum = pgEnum('job_kind', ['discovery', 'remediation']);
export const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'claimed',
  'running',
  'done',
  'error',
]);

/** The machine-level source-change audit action (D-08 — API-key-scoped, NO user identity). */
export const sourceAuditActionEnum = pgEnum('source_audit_action', [
  'create',
  'update',
  'delete',
  'enable',
  'disable',
]);
