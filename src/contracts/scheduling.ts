import { z } from 'zod';

/**
 * C4 (DESIGN-045 D-07/D-15) — a provider's declared discovery cadence, deliberately split from
 * the downloader every-15-minutes clock. YouTube is event-driven (re-emit on an admin/member edit) with an
 * optional slow safety cadence; Peloton is cron (nightly scrape) PLUS a bearer-freshness SLA
 * tuned so the credential-age alarm signals a MISSED nightly mint, not a normal day.
 *
 * Bearer-freshness SLA (issue #23): the bearer is minted ONCE nightly with ~48h real validity, so a
 * healthy token is routinely most of a day old. The alarm therefore uses TWO explicit thresholds:
 *   - `credentialWarnSec` — WARN once the bearer is at least this old (a missed nightly mint).
 *   - `credentialErrorSec` — ERROR once the bearer is at least this old (approaching real expiry).
 * `credentialRefreshSec` is the DEPRECATED single-knob form (warn at 1×, error at 2×); when only it
 * is set the old behaviour is preserved (warn = it, error = 2× it) so existing config stays sane.
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
    /** DEPRECATED (issue #23) — the single-knob bearer-freshness SLA. If set alone, WARN derives at
     * 1× and ERROR at 2×. Prefer the explicit `credentialWarnSec` / `credentialErrorSec` pair. */
    credentialRefreshSec: z.number().int().positive().optional(),
    /** WARN once the last-minted bearer is at least this old (seconds) — a missed nightly mint. */
    credentialWarnSec: z.number().int().positive().optional(),
    /** ERROR once the last-minted bearer is at least this old (seconds) — approaching real expiry. */
    credentialErrorSec: z.number().int().positive().optional(),
  }),
]);
export type SchedulingDeclaration = z.infer<typeof schedulingSchema>;

/**
 * The resolved bearer-freshness SLA (issue #23) — the two thresholds the credential-age alarm reads,
 * the metrics gauge, and the run-summary line all derive from THIS single resolver so nothing drifts.
 */
export interface CredentialSla {
  /** WARN once the bearer is at least this many seconds old. */
  warnSec: number;
  /** ERROR once the bearer is at least this many seconds old. */
  errorSec: number;
}

/**
 * Resolve a scheduling declaration's bearer-freshness SLA into the explicit warn/error pair. Prefers
 * the new `credentialWarnSec` / `credentialErrorSec`; falls back to the deprecated `credentialRefreshSec`
 * (warn = it, error = 2× it) so old config keeps its 1×/2× meaning. Returns `undefined` when the
 * provider declares no SLA at all (or is not a cron provider).
 */
export function resolveCredentialSla(scheduling: SchedulingDeclaration): CredentialSla | undefined {
  if (scheduling.mode !== 'cron') return undefined;
  const warnSec = scheduling.credentialWarnSec ?? scheduling.credentialRefreshSec;
  if (warnSec === undefined || warnSec <= 0) return undefined;
  const errorSec = scheduling.credentialErrorSec ?? warnSec * 2;
  return { warnSec, errorSec };
}
