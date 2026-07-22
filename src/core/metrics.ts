import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { resolveDb } from '../db/client';
import type { Database, DbClient } from '../db';
import { listProviders } from './registry';
import { resolveProjectionDir } from './projection';
import { credentialAgeStatus, type RunSummary } from '../domain/run-summary';
import { resolveCredentialSla, type CredentialSla } from '../contracts/scheduling';
import { listLibraries } from '../domain/libraries';
import { listSources } from '../domain/sources';
import { countEntriesBySource } from '../domain/entries';
import { effectivePelotonCap, pelotonSettingsSchema } from '../providers/peloton';

/**
 * Prometheus exposition (issue #19 / DESIGN-045 D-10) — the run/discovery + health surface the
 * retired config-manager carried in its auto-merged PR bodies (thaynes43/haynes-ops#2168), re-homed
 * onto a scrape endpoint the estate's kube-prometheus-stack reads and a Grafana dashboard renders.
 *
 * ACCURACY OVER CLEVERNESS (the issue's rule): every value is COMPUTED FROM THE DB (and the projected
 * files) at scrape time — there are no in-process counters that drift or reset on a pod restart. The
 * "cumulative" `_total` counters are literally `SUM(...)` over the append-only `runs` table, so they
 * are monotonic across scrapes AND survive restarts (the DB is the state). Prometheus `increase()`
 * over them yields "what changed in the window" for the owner's daily review.
 *
 * Labels (issue #19):
 *   - `provider` — every run/health series. Peloton runs are provider-attributed by the worker
 *     report/fail leg; scope-level in_core discovery/emit runs (YouTube is event-driven, finalized
 *     inline and left unattributed by design) bucket under the synthetic provider `core`.
 *   - `activity` — per-activity Peloton series (the watch-grain: one Source per activity, `ref` is
 *     the slug). `media_kind` — YouTube/library series (video | music).
 *   - `library` — projection/ledger series.
 *
 * A metric family = a name + help + type + samples; `renderExposition` serializes the standard
 * text format (`# HELP` / `# TYPE` / `name{labels} value`). Missing/unavailable inputs degrade to an
 * absent series, never a fabricated zero (except where a real zero is meaningful, e.g. queue depth).
 */

export type MetricType = 'gauge' | 'counter';

export interface MetricSample {
  labels?: Record<string, string>;
  value: number;
}

export interface Metric {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
}

export interface CollectMetricsOptions {
  /** D-14 projection root — resolves each Library's projectionPath so file sizes / last-emit stat. */
  projectionRoot?: string;
  db?: DbClient;
  /** evaluation clock (tests inject a fixed now). */
  now?: number;
}

// --- exposition rendering ----------------------------------------------------------------------

/** Escape a label VALUE per the Prometheus text format (backslash, double-quote, newline). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(labels?: Record<string, string>): string {
  if (!labels) return '';
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? '')}"`);
  return `{${parts.join(',')}}`;
}

/** Format a number for exposition — finite values verbatim, non-finite as Prometheus literals. */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

/** Serialize metric families to the Prometheus text exposition format (version 0.0.4). */
export function renderExposition(metrics: Metric[]): string {
  const lines: string[] = [];
  for (const metric of metrics) {
    if (metric.samples.length === 0) continue;
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    for (const sample of metric.samples) {
      lines.push(`${metric.name}${renderLabels(sample.labels)} ${formatValue(sample.value)}`);
    }
  }
  return lines.join('\n') + '\n';
}

// --- helpers -----------------------------------------------------------------------------------

const STATUS_CODE: Record<string, number> = { ok: 0, warn: 1, error: 2, running: 3 };
const CRED_STATUS_CODE: Record<string, number> = { ok: 0, warn: 1, error: 2, unknown: 3 };

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** The service version (env override, else the package.json shipped next to the bundle — as app.ts). */
async function serviceVersion(): Promise<string> {
  if (process.env.YTDRIVARR_VERSION) return process.env.YTDRIVARR_VERSION;
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

interface RunAggRow {
  provider: string;
  runs_ok: number;
  runs_warn: number;
  runs_error: number;
  runs_running: number;
  added_total: number;
  removed_total: number;
  windowed_out_total: number;
  deduped_total: number;
  login_attempts: number;
  login_failures: number;
  bearer_attempts: number;
  bearer_capture_retries: number;
}

interface LastRunRow {
  provider: string;
  status: string;
  counts: Record<string, number>;
  telemetry: Record<string, unknown>;
  summary: RunSummary | null;
  started: number;
  finished: number | null;
}

interface JobRow {
  provider: string;
  status: string;
  n: number;
  attempts: number;
}

// --- collection --------------------------------------------------------------------------------

/**
 * Compute every metric family from the DB (and the projected files) at scrape time. Wrapped so a
 * DB outage still yields `ytdrivarr_up` + `ytdrivarr_db_reachable 0` rather than a 500 — an operator
 * scraping a half-down service should still learn it is half-down.
 */
export async function collectMetrics(opts: CollectMetricsOptions = {}): Promise<Metric[]> {
  const startedAt = Date.now();
  const now = opts.now ?? Date.now();
  const nowSec = now / 1000;
  const metrics: Metric[] = [];

  metrics.push({
    name: 'ytdrivarr_build_info',
    help: 'Build/runtime facts (constant 1); read version + node from the labels.',
    type: 'gauge',
    samples: [
      { labels: { version: await serviceVersion(), node_version: process.version }, value: 1 },
    ],
  });
  metrics.push({
    name: 'ytdrivarr_up',
    help: 'Always 1 when the metrics endpoint is scraped (liveness of the exposition itself).',
    type: 'gauge',
    samples: [{ value: 1 }],
  });

  // provider registry — one info series per compiled-in provider (D-04).
  const providers = listProviders();
  metrics.push({
    name: 'ytdrivarr_provider_info',
    help: 'Registered provider (constant 1); runtime + kind are labels (DESIGN-045 D-04).',
    type: 'gauge',
    samples: providers.map((p) => ({
      labels: { provider: p.id, runtime: p.runtime, kind: p.kind },
      value: 1,
    })),
  });

  // The provider's bearer-freshness SLA (issue #23 / D-07), as gauges so Grafana can threshold the
  // bearer age against the warn + error edges (tuned to the nightly-mint cadence, not a 1×/2× knob).
  const slaByProvider = new Map<string, CredentialSla>();
  const providerByNamespace = new Map<string, string>();
  for (const p of providers) {
    providerByNamespace.set(p.stateNamespace, p.id);
    const sla = resolveCredentialSla(p.scheduling);
    if (sla) slaByProvider.set(p.id, sla);
  }

  let dbReachable = 1;
  try {
    const d = resolveDb(opts.db) as Database;

    const [libraries, sources, entryCounts] = await Promise.all([
      listLibraries(opts.db),
      listSources(opts.db),
      countEntriesBySource(opts.db),
    ]);
    const libById = new Map(libraries.map((l) => [l.id, l]));

    // --- sources + monitored + per-activity/-library ledger sizes (live) ------------------------
    interface SrcAgg {
      provider: string;
      library: string;
      media_kind: string;
      total: number;
      monitored: number;
    }
    const srcAgg = new Map<string, SrcAgg>();
    const activityLedger: MetricSample[] = [];
    const activityCap: MetricSample[] = [];
    const libEntries = new Map<string, number>();

    for (const s of sources) {
      const lib = libById.get(s.libraryId);
      const library = lib?.name ?? s.libraryId;
      const key = `${s.providerId} ${library} ${s.mediaKind}`;
      const agg = srcAgg.get(key) ?? {
        provider: s.providerId,
        library,
        media_kind: s.mediaKind,
        total: 0,
        monitored: 0,
      };
      agg.total += 1;
      if (s.enabled) agg.monitored += 1;
      srcAgg.set(key, agg);

      const entries = entryCounts.get(s.id) ?? 0;
      libEntries.set(s.libraryId, (libEntries.get(s.libraryId) ?? 0) + entries);

      // Peloton is watch-grain: one Source per activity, `ref` is the activity slug. Emit the
      // per-activity ledger size + effective cap — a live current-state twin of the #2168 breakdown.
      if (s.providerId === 'peloton') {
        const labels = { provider: s.providerId, library, activity: s.ref };
        const parsed = pelotonSettingsSchema.safeParse(s.settings);
        activityLedger.push({ labels, value: entries });
        activityCap.push({ labels, value: effectivePelotonCap(parsed.success ? parsed.data : {}) });
      }
    }

    metrics.push({
      name: 'ytdrivarr_sources',
      help: 'Configured Sources (channels + per-activity Peloton Sources), by provider/library/media kind.',
      type: 'gauge',
      samples: [...srcAgg.values()].map((a) => ({
        labels: { provider: a.provider, library: a.library, media_kind: a.media_kind },
        value: a.total,
      })),
    });
    metrics.push({
      name: 'ytdrivarr_sources_monitored',
      help: 'Monitored (enabled) Sources — the ones the next scrape/emit includes.',
      type: 'gauge',
      samples: [...srcAgg.values()].map((a) => ({
        labels: { provider: a.provider, library: a.library, media_kind: a.media_kind },
        value: a.monitored,
      })),
    });
    metrics.push({
      name: 'ytdrivarr_activity_entries',
      help: 'Per-activity ledger size — persisted entries for each Peloton activity (watch-grain).',
      type: 'gauge',
      samples: activityLedger,
    });
    metrics.push({
      name: 'ytdrivarr_activity_cap',
      help: 'Effective per-scrape cap for each per-activity Peloton Source (override, else the global default).',
      type: 'gauge',
      samples: activityCap,
    });
    metrics.push({
      name: 'ytdrivarr_library_entries',
      help: 'Ledger size per Library — total persisted subscription entries across its Sources.',
      type: 'gauge',
      samples: libraries.map((l) => ({
        labels: { library: l.name, media_kind: l.libraryKind },
        value: libEntries.get(l.id) ?? 0,
      })),
    });

    // --- run aggregates (cumulative counters + run-status counts), per provider -----------------
    const runAgg = await d.execute(sql`
      select
        coalesce(provider_id, 'core') as provider,
        count(*) filter (where status = 'ok')::int as runs_ok,
        count(*) filter (where status = 'warn')::int as runs_warn,
        count(*) filter (where status = 'error')::int as runs_error,
        count(*) filter (where status = 'running')::int as runs_running,
        coalesce(sum((counts->>'added')::numeric), 0)::float8 as added_total,
        coalesce(sum((counts->>'removed')::numeric), 0)::float8 as removed_total,
        coalesce(sum((counts->>'windowedOut')::numeric), 0)::float8 as windowed_out_total,
        coalesce(sum((counts->>'deduped')::numeric), 0)::float8 as deduped_total,
        coalesce(sum((telemetry->>'loginAttempts')::numeric), 0)::float8 as login_attempts,
        coalesce(sum((telemetry->>'loginFailures')::numeric), 0)::float8 as login_failures,
        coalesce(sum((telemetry->>'bearerAttempts')::numeric), 0)::float8 as bearer_attempts,
        coalesce(sum((telemetry->>'bearerCaptureRetries')::numeric), 0)::float8 as bearer_capture_retries
      from runs
      group by coalesce(provider_id, 'core')
    `);
    const runRows = runAgg.rows as unknown as RunAggRow[];

    const runsTotal: MetricSample[] = [];
    const runsRunning: MetricSample[] = [];
    const addedTotal: MetricSample[] = [];
    const removedTotal: MetricSample[] = [];
    const windowedOutTotal: MetricSample[] = [];
    const dedupedTotal: MetricSample[] = [];
    const loginAttempts: MetricSample[] = [];
    const loginFailures: MetricSample[] = [];
    const bearerRetries: MetricSample[] = [];
    for (const r of runRows) {
      const provider = r.provider;
      runsTotal.push({ labels: { provider, status: 'ok' }, value: num(r.runs_ok) });
      runsTotal.push({ labels: { provider, status: 'warn' }, value: num(r.runs_warn) });
      runsTotal.push({ labels: { provider, status: 'error' }, value: num(r.runs_error) });
      runsRunning.push({ labels: { provider }, value: num(r.runs_running) });
      addedTotal.push({ labels: { provider }, value: num(r.added_total) });
      removedTotal.push({ labels: { provider }, value: num(r.removed_total) });
      windowedOutTotal.push({ labels: { provider }, value: num(r.windowed_out_total) });
      dedupedTotal.push({ labels: { provider }, value: num(r.deduped_total) });
      loginAttempts.push({ labels: { provider }, value: num(r.login_attempts) });
      loginFailures.push({ labels: { provider }, value: num(r.login_failures) });
      bearerRetries.push({
        labels: { provider },
        value: num(r.bearer_attempts) + num(r.bearer_capture_retries),
      });
    }
    metrics.push({
      name: 'ytdrivarr_runs_total',
      help: 'Finalized discovery/emit runs by terminal status (ok|warn|error), cumulative — SUM over the runs table.',
      type: 'counter',
      samples: runsTotal,
    });
    metrics.push({
      name: 'ytdrivarr_runs_running',
      help: 'Runs currently in the running state (an out_of_process job in flight leaves its Run running).',
      type: 'gauge',
      samples: runsRunning,
    });
    metrics.push({
      name: 'ytdrivarr_entries_added_total',
      help: 'Cumulative subscription entries ADDED across all runs — increase() over a window = added in it.',
      type: 'counter',
      samples: addedTotal,
    });
    metrics.push({
      name: 'ytdrivarr_entries_removed_total',
      help: 'Cumulative subscription entries removed across all runs.',
      type: 'counter',
      samples: removedTotal,
    });
    metrics.push({
      name: 'ytdrivarr_entries_windowed_out_total',
      help: 'Cumulative entries dropped from the emitted file by the donor-parity emit window (ledger row stays).',
      type: 'counter',
      samples: windowedOutTotal,
    });
    metrics.push({
      name: 'ytdrivarr_entries_deduped_total',
      help: 'Cumulative entries removed by cross-source dedup + title-collision guards across all runs.',
      type: 'counter',
      samples: dedupedTotal,
    });
    metrics.push({
      name: 'ytdrivarr_login_attempts_total',
      help: 'Cumulative worker login attempts across all runs (Peloton auth health).',
      type: 'counter',
      samples: loginAttempts,
    });
    metrics.push({
      name: 'ytdrivarr_login_failures_total',
      help: 'Cumulative worker login failures across all runs.',
      type: 'counter',
      samples: loginFailures,
    });
    metrics.push({
      name: 'ytdrivarr_bearer_capture_retries_total',
      help: 'Cumulative bearer-capture attempts/retries across all runs (the never-silent-stale-token guard).',
      type: 'counter',
      samples: bearerRetries,
    });

    // --- last run per provider — the #2168 snapshot (counts, status, duration, per-activity) -----
    const lastRunRes = await d.execute(sql`
      select distinct on (coalesce(provider_id, 'core'))
        coalesce(provider_id, 'core') as provider,
        status,
        counts,
        telemetry,
        summary,
        extract(epoch from started_at)::float8 as started,
        extract(epoch from finished_at)::float8 as finished
      from runs
      order by coalesce(provider_id, 'core'), started_at desc
    `);
    const lastRuns = lastRunRes.rows as unknown as LastRunRow[];

    const lastStatus: MetricSample[] = [];
    const lastDuration: MetricSample[] = [];
    const lastTs: MetricSample[] = [];
    const lastDiscovered: MetricSample[] = [];
    const lastAdded: MetricSample[] = [];
    const lastRemoved: MetricSample[] = [];
    const lastUnchanged: MetricSample[] = [];
    const lastDeduped: MetricSample[] = [];
    const lastEmitted: MetricSample[] = [];
    const lastWindowedOut: MetricSample[] = [];
    const lastLinksFound: MetricSample[] = [];
    const lastLinksMalformed: MetricSample[] = [];
    const lastScrolls: MetricSample[] = [];
    const lastScrollCapped: MetricSample[] = [];
    const lastDrift: MetricSample[] = [];
    const actExisting: MetricSample[] = [];
    const actAdded: MetricSample[] = [];
    const actTotal: MetricSample[] = [];
    const actCap: MetricSample[] = [];
    const actAtCap: MetricSample[] = [];
    const actOverCap: MetricSample[] = [];
    const actScraped: MetricSample[] = [];
    const actSkipped: MetricSample[] = [];
    const actScrolls: MetricSample[] = [];

    for (const r of lastRuns) {
      const provider = r.provider;
      const counts = r.counts ?? {};
      const telemetry = r.telemetry ?? {};
      const summary = r.summary;
      const changes = summary?.changes;
      lastStatus.push({ labels: { provider }, value: STATUS_CODE[r.status] ?? 3 });
      const finished = r.finished ?? null;
      lastTs.push({ labels: { provider }, value: finished ?? r.started });
      if (finished !== null) {
        lastDuration.push({ labels: { provider }, value: Math.max(0, finished - r.started) });
      }
      lastDiscovered.push({ labels: { provider }, value: num(counts.discovered) });
      lastAdded.push({
        labels: { provider },
        value: num(changes?.subscriptionsAdded ?? counts.added),
      });
      lastRemoved.push({
        labels: { provider },
        value: num(changes?.subscriptionsRemoved ?? counts.removed),
      });
      lastUnchanged.push({
        labels: { provider },
        value: num(changes?.subscriptionsUnchanged ?? counts.unchanged ?? counts.updated),
      });
      lastDeduped.push({ labels: { provider }, value: num(changes?.deduped ?? counts.deduped) });
      lastEmitted.push({
        labels: { provider },
        value: num(changes?.entriesEmitted ?? counts.emitted),
      });
      lastWindowedOut.push({ labels: { provider }, value: num(counts.windowedOut) });
      lastLinksFound.push({ labels: { provider }, value: num(telemetry.linksFound) });
      lastLinksMalformed.push({ labels: { provider }, value: num(telemetry.malformed) });
      lastScrolls.push({
        labels: { provider },
        value: num(summary?.health?.scrollsPerformed ?? telemetry.scrollsPerformed),
      });
      lastDrift.push({
        labels: { provider },
        value: num(summary?.health?.selectorDriftHits ?? telemetry.selectorDriftHits),
      });
      const perActivity = Array.isArray(telemetry.perActivity)
        ? (telemetry.perActivity as Array<Record<string, unknown>>)
        : [];
      lastScrollCapped.push({
        labels: { provider },
        value: perActivity.filter((a) => a.scrollCapped === true).length,
      });

      // The #2168 per-activity breakdown — the worker/report leg composed it into summary.changes.
      for (const a of changes?.activities ?? []) {
        const labels = { provider, activity: a.activity };
        actExisting.push({ labels, value: num(a.existing) });
        actAdded.push({ labels, value: num(a.added) });
        actTotal.push({ labels, value: num(a.total) });
        if (a.cap !== undefined) actCap.push({ labels, value: num(a.cap) });
        if (a.atCap !== undefined) actAtCap.push({ labels, value: a.atCap ? 1 : 0 });
        if (a.overCap !== undefined) actOverCap.push({ labels, value: a.overCap ? 1 : 0 });
        if (a.scraped !== undefined) actScraped.push({ labels, value: num(a.scraped) });
        if (a.skipped !== undefined) actSkipped.push({ labels, value: num(a.skipped) });
        if (a.scrolls !== undefined) actScrolls.push({ labels, value: num(a.scrolls) });
      }
    }

    metrics.push({
      name: 'ytdrivarr_last_run_status',
      help: 'Last run status per provider as a code: 0=ok 1=warn 2=error 3=running (for threshold coloring).',
      type: 'gauge',
      samples: lastStatus,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_timestamp_seconds',
      help: 'Unix time the last run finished (or started, if still running) — age = time() - this.',
      type: 'gauge',
      samples: lastTs,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_duration_seconds',
      help: 'Wall-clock duration of the last finalized run per provider.',
      type: 'gauge',
      samples: lastDuration,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_discovered',
      help: 'Entries discovered in the last run per provider.',
      type: 'gauge',
      samples: lastDiscovered,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_added',
      help: 'Entries added in the last run per provider.',
      type: 'gauge',
      samples: lastAdded,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_removed',
      help: 'Entries removed in the last run per provider.',
      type: 'gauge',
      samples: lastRemoved,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_unchanged',
      help: 'Entries unchanged/updated in the last run per provider.',
      type: 'gauge',
      samples: lastUnchanged,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_deduped',
      help: 'Entries deduped in the last run per provider.',
      type: 'gauge',
      samples: lastDeduped,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_emitted',
      help: 'Entries emitted to the projected subscriptions.yaml in the last run per provider.',
      type: 'gauge',
      samples: lastEmitted,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_windowed_out',
      help: 'Entries windowed out of the emitted file in the last run per provider.',
      type: 'gauge',
      samples: lastWindowedOut,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_links_found',
      help: 'Scrape links found in the last run (Peloton).',
      type: 'gauge',
      samples: lastLinksFound,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_links_malformed',
      help: 'Malformed scrape links in the last run (Peloton selector-drift signal).',
      type: 'gauge',
      samples: lastLinksMalformed,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_scrolls',
      help: 'Scrolls performed in the last run (Peloton).',
      type: 'gauge',
      samples: lastScrolls,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_scroll_capped',
      help: 'Activities that hit the scroll cap in the last run (Peloton).',
      type: 'gauge',
      samples: lastScrollCapped,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_selector_drift_hits',
      help: 'Selector-drift hits recorded in the last run (Peloton — a scraper-health alarm).',
      type: 'gauge',
      samples: lastDrift,
    });

    metrics.push({
      name: 'ytdrivarr_last_run_activity_existing',
      help: 'Per-activity existing entries before the last run (the #2168 table).',
      type: 'gauge',
      samples: actExisting,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_activity_added',
      help: 'Per-activity entries added by the last run (the #2168 table).',
      type: 'gauge',
      samples: actAdded,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_activity_total',
      help: 'Per-activity total entries after the last run (the #2168 table).',
      type: 'gauge',
      samples: actTotal,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_activity_cap',
      help: 'Per-activity effective cap at the last run (the #2168 vs-limit column).',
      type: 'gauge',
      samples: actCap,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_activity_at_cap',
      help: 'Per-activity at-cap flag from the last run (1=this scrape hit the cap exactly).',
      type: 'gauge',
      samples: actAtCap,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_activity_over_cap',
      help: 'Per-activity over-cap flag from the last run (1=OVER LIMIT).',
      type: 'gauge',
      samples: actOverCap,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_activity_scraped',
      help: 'Per-activity links scraped in the last run.',
      type: 'gauge',
      samples: actScraped,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_activity_skipped',
      help: 'Per-activity already-known links skipped in the last run.',
      type: 'gauge',
      samples: actSkipped,
    });
    metrics.push({
      name: 'ytdrivarr_last_run_activity_scrolls',
      help: 'Per-activity scrolls performed in the last run.',
      type: 'gauge',
      samples: actScrolls,
    });

    // --- last successful run per provider (for the last-successful-run-age panel) ----------------
    const lastOkRes = await d.execute(sql`
      select distinct on (coalesce(provider_id, 'core'))
        coalesce(provider_id, 'core') as provider,
        extract(epoch from coalesce(finished_at, started_at))::float8 as ts
      from runs
      where status in ('ok', 'warn')
      order by coalesce(provider_id, 'core'), started_at desc
    `);
    metrics.push({
      name: 'ytdrivarr_last_success_timestamp_seconds',
      help: 'Unix time of the last SUCCESSFUL (ok|warn) run per provider — success age = time() - this.',
      type: 'gauge',
      samples: (lastOkRes.rows as unknown as Array<{ provider: string; ts: number }>).map((r) => ({
        labels: { provider: r.provider },
        value: num(r.ts),
      })),
    });

    // --- credential / bearer freshness (live, from provider_state) ------------------------------
    const sessionRes = await d.execute(sql`
      select namespace, value->>'mintedAt' as minted_at
      from provider_state
      where key = 'session' and value ? 'mintedAt'
    `);
    const bearerAge: MetricSample[] = [];
    const bearerSla: MetricSample[] = [];
    const bearerSlaError: MetricSample[] = [];
    const credStatus: MetricSample[] = [];
    for (const [provider, sla] of slaByProvider) {
      bearerSla.push({ labels: { provider }, value: sla.warnSec });
      bearerSlaError.push({ labels: { provider }, value: sla.errorSec });
    }
    for (const row of sessionRes.rows as unknown as Array<{
      namespace: string;
      minted_at: string;
    }>) {
      const provider = providerByNamespace.get(row.namespace);
      if (!provider) continue;
      const minted = Date.parse(row.minted_at);
      if (Number.isNaN(minted)) continue;
      const ageSec = Math.max(0, Math.floor((now - minted) / 1000));
      bearerAge.push({ labels: { provider }, value: ageSec });
      credStatus.push({
        labels: { provider },
        value:
          CRED_STATUS_CODE[credentialAgeStatus(ageSec, slaByProvider.get(provider) ?? null)] ?? 3,
      });
    }
    metrics.push({
      name: 'ytdrivarr_bearer_age_seconds',
      help: 'Age of the last minted bearer/session per provider (now - mintedAt).',
      type: 'gauge',
      samples: bearerAge,
    });
    metrics.push({
      name: 'ytdrivarr_bearer_sla_seconds',
      help: 'The bearer-freshness WARN threshold (issue #23) as a gauge, for Grafana thresholds against the age.',
      type: 'gauge',
      samples: bearerSla,
    });
    metrics.push({
      name: 'ytdrivarr_bearer_sla_error_seconds',
      help: 'The bearer-freshness ERROR threshold (issue #23) as a gauge — the age at which the token nears real expiry.',
      type: 'gauge',
      samples: bearerSlaError,
    });
    metrics.push({
      name: 'ytdrivarr_credential_age_status',
      help: 'Credential-age status code: 0=ok 1=warn(>=warn SLA) 2=error(>=error SLA) 3=unknown.',
      type: 'gauge',
      samples: credStatus,
    });

    // --- jobs / queue + worker liveness (live, from jobs) ---------------------------------------
    const jobRes = await d.execute(sql`
      select provider_id as provider, status, count(*)::int as n, coalesce(sum(attempts), 0)::int as attempts
      from jobs
      group by provider_id, status
    `);
    const jobRows = jobRes.rows as unknown as JobRow[];
    const attemptsByProvider = new Map<string, number>();
    const jobSamples: MetricSample[] = jobRows.map((r) => {
      attemptsByProvider.set(
        r.provider,
        (attemptsByProvider.get(r.provider) ?? 0) + num(r.attempts),
      );
      return { labels: { provider: r.provider, status: r.status }, value: num(r.n) };
    });
    metrics.push({
      name: 'ytdrivarr_jobs',
      help: 'Out-of-process transport jobs by status (queued=queue depth, claimed/running=in flight, error=failed).',
      type: 'gauge',
      samples: jobSamples,
    });
    metrics.push({
      name: 'ytdrivarr_job_attempts',
      help: 'Sum of claim attempts across a provider’s jobs — retry pressure on the transport.',
      type: 'gauge',
      samples: [...attemptsByProvider].map(([provider, value]) => ({
        labels: { provider },
        value,
      })),
    });

    const heartbeatRes = await d.execute(sql`
      select provider_id as provider, extract(epoch from max(heartbeat_at))::float8 as last_seen
      from jobs
      where heartbeat_at is not null
      group by provider_id
    `);
    const workerLastSeen: MetricSample[] = [];
    const workerAge: MetricSample[] = [];
    for (const row of heartbeatRes.rows as unknown as Array<{
      provider: string;
      last_seen: number;
    }>) {
      workerLastSeen.push({ labels: { provider: row.provider }, value: num(row.last_seen) });
      workerAge.push({
        labels: { provider: row.provider },
        value: Math.max(0, Math.floor(nowSec - num(row.last_seen))),
      });
    }
    metrics.push({
      name: 'ytdrivarr_worker_last_seen_timestamp_seconds',
      help: 'Unix time a worker was last seen (last claim/heartbeat) per provider.',
      type: 'gauge',
      samples: workerLastSeen,
    });
    metrics.push({
      name: 'ytdrivarr_worker_heartbeat_age_seconds',
      help: 'Seconds since a worker was last seen per provider (worker liveness).',
      type: 'gauge',
      samples: workerAge,
    });

    // --- projection files (live FS) — per-Library file size + last emit -------------------------
    const projSize: MetricSample[] = [];
    const projLastEmit: MetricSample[] = [];
    for (const lib of libraries) {
      const dir = resolveProjectionDir(lib.projectionPath, opts.projectionRoot);
      for (const [file, name] of [
        ['config', 'config.yaml'],
        ['subscriptions', 'subscriptions.yaml'],
      ] as const) {
        try {
          const st = await stat(join(dir, name));
          projSize.push({ labels: { library: lib.name, file }, value: st.size });
          if (file === 'subscriptions') {
            projLastEmit.push({
              labels: { library: lib.name },
              value: Math.floor(st.mtimeMs / 1000),
            });
          }
        } catch {
          // not yet projected (or root not mounted in this context) — omit rather than fake a 0.
        }
      }
    }
    metrics.push({
      name: 'ytdrivarr_projection_file_size_bytes',
      help: 'Size of each projected file per Library (file="config"|"subscriptions").',
      type: 'gauge',
      samples: projSize,
    });
    metrics.push({
      name: 'ytdrivarr_projection_last_emit_timestamp_seconds',
      help: 'Modification time of each Library’s projected subscriptions.yaml — the last-emit clock.',
      type: 'gauge',
      samples: projLastEmit,
    });
  } catch {
    dbReachable = 0;
  }

  metrics.push({
    name: 'ytdrivarr_db_reachable',
    help: '1 when the metrics collector reached the database this scrape, else 0.',
    type: 'gauge',
    samples: [{ value: dbReachable }],
  });
  metrics.push({
    name: 'ytdrivarr_metrics_collect_duration_seconds',
    help: 'Time the metrics collector spent gathering this scrape.',
    type: 'gauge',
    samples: [{ value: (Date.now() - startedAt) / 1000 }],
  });

  return metrics;
}

/** Convenience: collect + render in one call (the `/metrics` handler). */
export async function metricsExposition(opts: CollectMetricsOptions = {}): Promise<string> {
  return renderExposition(await collectMetrics(opts));
}
