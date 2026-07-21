/**
 * Run summary (DESIGN-045 D-10) — the OWNER'S DAILY REVIEW RITUAL. Replicates the SHAPE of the donor
 * `metrics.py get_pr_summary` (the per-activity existing/added/total breakdown, the over-limit flags,
 * the credential/health surface, the issue list) but re-homed onto ytdrivarr's three sections —
 * `## Changes` / `## Health` / `## Issues` — with REAL numbers drawn from a run's counts + telemetry.
 * NOT stubs. Structured object (persisted to `runs.summary`) AND a markdown renderer.
 *
 * It is GENERIC: an in_core (YouTube) run with no per-activity telemetry still gets a coherent
 * Changes/Health/Issues summary; a Peloton report carries the rich per-activity + credential
 * telemetry and lights up the full breakdown.
 */

export interface RunSummaryActivity {
  activity: string;
  existing: number;
  added: number;
  total: number;
  scraped?: number;
  skipped?: number;
  scrolls?: number;
  overCap?: boolean;
  /** true when total === the per-activity cap (donor's ✅ vs ⚠️). */
  atCap?: boolean;
}

export interface RunSummaryChanges {
  subscriptionsAdded: number;
  subscriptionsRemoved: number;
  subscriptionsUnchanged: number;
  skipped: number;
  deduped: number;
  entriesEmitted: number;
  activities: RunSummaryActivity[];
}

export type CredentialAgeStatus = 'ok' | 'warn' | 'error' | 'unknown';

export interface RunSummaryHealth {
  authOk: boolean | null;
  loginOk: boolean | null;
  bearerMintedAt: string | null;
  bearerAgeSec: number | null;
  credentialRefreshSec: number | null;
  credentialAgeStatus: CredentialAgeStatus;
  scrollsPerformed: number | null;
  selectorDriftHits: number;
}

export interface RunSummary {
  changes: RunSummaryChanges;
  health: RunSummaryHealth;
  /** the alarm list (D-10): selector-drift activities, bearer-capture retries, login failures,
   * over-cap activities, scroll timeouts. Empty ⇒ rendered as "none". */
  issues: string[];
}

/** The telemetry shape a Peloton worker reports (the contract the worker builds to). All optional —
 * an in_core run carries none of it and the summary degrades gracefully. */
export interface PelotonTelemetry {
  activities?: Array<{
    activity: string;
    existing?: number;
    added?: number;
    total?: number;
    scraped?: number;
    skipped?: number;
    scrolls?: number;
    overCap?: boolean;
    cap?: number;
  }>;
  selectorDriftHits?: number;
  selectorDriftActivities?: string[];
  scrollsPerformed?: number;
  scrollTimeouts?: string[];
  authOk?: boolean;
  loginOk?: boolean;
  bearerCaptureRetries?: number;
  loginFailures?: number;
  overCapActivities?: string[];
  bearerMintedAt?: string;
  maxClassesPerActivity?: number;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Credential-age policy (D-10): warn at ≥1× the SLA, error at ≥2× (matches collectHealth). */
export function credentialAgeStatus(
  ageSec: number | null,
  refreshSec: number | null,
): CredentialAgeStatus {
  if (ageSec === null || refreshSec === null || refreshSec <= 0) return 'unknown';
  if (ageSec >= refreshSec * 2) return 'error';
  if (ageSec >= refreshSec) return 'warn';
  return 'ok';
}

export interface BuildRunSummaryOptions {
  counts: Record<string, number>;
  telemetry?: Record<string, unknown>;
  /** the minted-session timestamp (report path) — falls back to telemetry.bearerMintedAt. */
  sessionMintedAt?: string;
  /** the provider's bearer-freshness SLA (D-07), for the credential-age status. */
  credentialRefreshSec?: number;
  /** evaluation clock (tests inject a fixed now). */
  now?: number;
}

/**
 * Build the structured summary from a run's counts + telemetry. `counts` carries the CORE-owned
 * tallies (added/removed/unchanged/deduped/emitted); `telemetry` carries the worker's per-activity
 * + credential detail. Both are read defensively so any run — in_core or out_of_process — produces a
 * coherent object.
 */
export function buildRunSummary(opts: BuildRunSummaryOptions): RunSummary {
  const counts = opts.counts;
  const telemetry = (opts.telemetry ?? {}) as PelotonTelemetry;
  const now = opts.now ?? Date.now();
  const cap = num(telemetry.maxClassesPerActivity, 0);

  const activities: RunSummaryActivity[] = (telemetry.activities ?? []).map((a) => {
    const existing = num(a.existing);
    const added = num(a.added);
    const total = a.total !== undefined ? num(a.total) : existing + added;
    const activity: RunSummaryActivity = { activity: a.activity, existing, added, total };
    if (a.scraped !== undefined) activity.scraped = num(a.scraped);
    if (a.skipped !== undefined) activity.skipped = num(a.skipped);
    if (a.scrolls !== undefined) activity.scrolls = num(a.scrolls);
    if (a.overCap !== undefined) activity.overCap = a.overCap;
    // Donor parity (metrics.py get_pr_summary): ✅ IFF total EXACTLY equals the cap, else ⚠️ —
    // an over-cap activity renders ⚠️ + **OVER LIMIT**, never ✅.
    const effectiveCap = a.cap !== undefined ? num(a.cap) : cap;
    if (effectiveCap > 0) activity.atCap = total === effectiveCap;
    return activity;
  });

  const changes: RunSummaryChanges = {
    subscriptionsAdded: num(counts.added ?? counts.new),
    subscriptionsRemoved: num(counts.removed),
    subscriptionsUnchanged: num(counts.unchanged ?? counts.updated),
    skipped: num(counts.skipped),
    deduped: num(counts.deduped),
    entriesEmitted: num(counts.emitted),
    activities,
  };

  const mintedAt = opts.sessionMintedAt ?? telemetry.bearerMintedAt ?? null;
  const bearerAgeSec =
    mintedAt !== null ? Math.max(0, Math.floor((now - Date.parse(mintedAt)) / 1000)) : null;
  const refreshSec = opts.credentialRefreshSec ?? null;

  const health: RunSummaryHealth = {
    authOk: telemetry.authOk ?? null,
    loginOk: telemetry.loginOk ?? null,
    bearerMintedAt: mintedAt,
    bearerAgeSec,
    credentialRefreshSec: refreshSec,
    credentialAgeStatus: credentialAgeStatus(bearerAgeSec, refreshSec),
    scrollsPerformed:
      telemetry.scrollsPerformed !== undefined ? num(telemetry.scrollsPerformed) : null,
    selectorDriftHits: num(telemetry.selectorDriftHits),
  };

  const issues: string[] = [];
  for (const a of telemetry.selectorDriftActivities ?? []) {
    issues.push(`selector drift on ${a}`);
  }
  if (num(telemetry.bearerCaptureRetries) > 0) {
    issues.push(`bearer capture retried ${num(telemetry.bearerCaptureRetries)}×`);
  }
  if (num(telemetry.loginFailures) > 0) {
    issues.push(`login failed ${num(telemetry.loginFailures)}×`);
  }
  for (const a of telemetry.overCapActivities ?? []) {
    issues.push(`over cap: ${a}`);
  }
  for (const a of telemetry.scrollTimeouts ?? []) {
    issues.push(`scroll timeout on ${a}`);
  }

  return { changes, health, issues };
}

function bool(value: boolean | null): string {
  if (value === null) return 'n/a';
  return value ? 'ok' : 'FAILED';
}

const OK_MARK = '✅';
const WARN_MARK = '⚠️';

/**
 * Render the structured summary as the markdown the console + the owner read. Sections mirror the
 * donor's ordering (Changes → per-activity breakdown → Health → Issues) with the donor's ✅/⚠️ marks
 * and **OVER LIMIT** flag, re-homed onto the ## Changes / ## Health / ## Issues headers.
 */
export function renderRunSummaryMarkdown(summary: RunSummary): string {
  const lines: string[] = [];
  const c = summary.changes;

  lines.push('## Changes', '');
  lines.push(
    `- **${c.subscriptionsAdded} added**, ${c.subscriptionsRemoved} removed, ${c.subscriptionsUnchanged} unchanged`,
  );
  lines.push(
    `- **${c.entriesEmitted} entries emitted** (${c.deduped} deduped, ${c.skipped} skipped)`,
  );
  lines.push('');

  if (c.activities.length > 0) {
    lines.push('### Activity breakdown', '');
    for (const a of [...c.activities].sort((x, y) => x.activity.localeCompare(y.activity))) {
      const mark = a.atCap === undefined ? '' : ` ${a.atCap ? OK_MARK : WARN_MARK}`;
      const overCap = a.overCap ? ' **OVER LIMIT**' : '';
      const detail =
        a.scraped !== undefined
          ? ` (${a.scraped} scraped, ${a.skipped ?? 0} skipped, ${a.scrolls ?? 0} scrolls)`
          : '';
      lines.push(
        `- **${a.activity}:** ${a.existing} existing, ${a.added} added, ${a.total} total${mark}${overCap}${detail}`,
      );
    }
    lines.push('');
  }

  const h = summary.health;
  lines.push('## Health', '');
  lines.push(`- **Auth/login:** ${bool(h.authOk)} / ${bool(h.loginOk)}`);
  if (h.bearerMintedAt) {
    lines.push(`- **Bearer minted:** ${h.bearerMintedAt} (${h.bearerAgeSec ?? '?'}s ago)`);
  } else {
    lines.push('- **Bearer minted:** never');
  }
  if (h.credentialRefreshSec !== null) {
    const mark =
      h.credentialAgeStatus === 'ok'
        ? OK_MARK
        : h.credentialAgeStatus === 'unknown'
          ? ''
          : WARN_MARK;
    lines.push(
      `- **Credential age vs SLA:** ${h.bearerAgeSec ?? '?'}s / ${h.credentialRefreshSec}s ${mark} (${h.credentialAgeStatus})`,
    );
  }
  if (h.scrollsPerformed !== null) lines.push(`- **Scrolls performed:** ${h.scrollsPerformed}`);
  lines.push(`- **Selector-drift hits:** ${h.selectorDriftHits}`);
  lines.push('');

  lines.push('## Issues', '');
  if (summary.issues.length === 0) {
    lines.push('- none');
  } else {
    for (const issue of summary.issues) lines.push(`- ${issue}`);
  }
  lines.push('');

  return lines.join('\n');
}

/** Serialize the structured summary for the `runs.summary` jsonb column. */
export function runSummaryToJson(summary: RunSummary): Record<string, unknown> {
  return summary as unknown as Record<string, unknown>;
}
