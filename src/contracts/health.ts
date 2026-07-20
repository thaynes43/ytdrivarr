import { z } from 'zod';

export const healthStatusSchema = z.enum(['ok', 'warn', 'error', 'unknown']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

/**
 * C1 `test()` / C7 (DESIGN-045 D-04/D-10) — the reachability/credential probe result surfaced by
 * GET /health and mirrored into the app's status read. The two first-class alarms are today's
 * silent failures: `credentialAgeSec` (bearer minted > SLA ago) and `selectorDriftHits` (a scrape
 * whose selectors returned zero/malformed hits). Optional so a trivial provider carries neither.
 */
export const healthResultSchema = z.object({
  status: healthStatusSchema,
  message: z.string().optional(),
  checkedAt: z.string(),
  credentialAgeSec: z.number().int().nonnegative().optional(),
  selectorDriftHits: z.number().int().nonnegative().optional(),
  lastSuccessfulDiscoveryAt: z.string().optional(),
});
export type HealthResult = z.infer<typeof healthResultSchema>;
