import { z } from 'zod';

/**
 * C4 (DESIGN-045 D-07/D-15) — a provider's declared discovery cadence, deliberately split from
 * the downloader every-15-minutes clock. YouTube is event-driven (re-emit on an admin/member edit) with an
 * optional slow safety cadence; Peloton is cron (nightly scrape) PLUS a bearer-freshness SLA
 * tighter than expiry so the downloader never runs an expired token.
 */
export const schedulingSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('event_driven'),
    /** an optional slow safety re-emit (cron expression). */
    safetyCron: z.string().optional(),
  }),
  z.object({
    mode: z.literal('cron'),
    cron: z.string(),
    /** the bearer-freshness SLA: refresh credentials at least this often (seconds). */
    credentialRefreshSec: z.number().int().positive().optional(),
  }),
]);
export type SchedulingDeclaration = z.infer<typeof schedulingSchema>;
