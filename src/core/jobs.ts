import { and, asc, desc, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';
import { jobs, type Job, type Library, type Source } from '../db/schema';
import { resolveDb } from '../db/client';
import type { Database, DbClient } from '../db';
import type { MediaKind } from '../contracts';
import { ConflictError, NotFoundError } from '../errors';
import {
  listEntriesForSource,
  loadPublishedNumbering, // re-exported for report path callers
} from '../domain/entries';
import { finishRun, getRun, recordRunTelemetry } from '../domain/runs';
import { buildRunSummary, runSummaryToJson } from '../domain/run-summary';
import {
  effectivePelotonCap,
  pelotonSettingsSchema,
  PELOTON_CREDENTIAL_REFRESH_SEC,
  type PelotonSettings,
} from '../providers/peloton';
import { buildFolderConfig, type FolderConfig } from '../providers/peloton/folder-mapping';
import {
  episodeNumberingFromEntries,
  mergeNumbering,
  type NestedNumbering,
} from '../providers/peloton/numbering';
import { episodesFromDisk } from '../providers/peloton/episodes-from-disk';

/**
 * The out-of-process transport (DESIGN-045 D-03) — the `jobs` table + a claim/heartbeat/report/fail
 * protocol a thin Python worker drives over HTTP. The core is the SINGLE DB WRITER; the worker never
 * touches the DB and the core never imports Selenium. This module owns the CLAIM/HEARTBEAT/FAIL legs
 * + the retry policy + the discovery-payload builder; the persistence-heavy REPORT leg lives in
 * `src/core/report.ts`.
 */

export const DEFAULT_HEARTBEAT_EXPIRY_SEC = 120;
export const DEFAULT_MAX_ATTEMPTS = 3;

export { loadPublishedNumbering };

// --- the discovery payload the worker builds to (the normative interface contract) --------------

export interface DiscoverySourcePayload {
  ref: string;
  displayName: string;
  mediaKind: MediaKind;
  settings: Record<string, unknown>;
}

export interface PelotonDiscoveryPayload {
  activities: string[];
  maxClassesPerActivity: number;
  dynamicScrolling: boolean;
  maxScrolls: number;
  scrollPauseSec: number;
  pageLoadWaitSec: number;
  loginWaitSec: number;
  /** the classIds already persisted for this source — the worker skips them (dedup, D-06). */
  existingClassIds: string[];
  /**
   * Per-(activity, duration) numbering seed `{ [activitySlug]: { [durationString]: maxEpisode } }`
   * (D-06) — each activity's own per-duration max, mirroring the donor's per-activity
   * `ActivityData.max_episode` (`application.py` 341-347). Folds in the optional disk scan when the
   * source sets `diskScanPath` (max per key). The worker continues EACH activity's sequence.
   */
  episodeNumbering: NestedNumbering;
  mediaRoot: string;
  folder: FolderConfig;
}

export interface DiscoveryPayload {
  runId: string;
  sourceId: string;
  libraryId: string;
  providerId: string;
  /** `scrape` = full catalog scrape; `refresh` = mint-bearer-only (the bearer-freshness SLA, D-07). */
  mode: 'scrape' | 'refresh';
  source: DiscoverySourcePayload;
  peloton: PelotonDiscoveryPayload;
  /**
   * Watch-grain routing (per-activity sources, migration 0002): activity slug → the per-activity
   * Source id the report leg merges that activity's entries into. `sourceId` stays the group's
   * ANCHOR source (a valid fallback target), so a pre-split payload still reports cleanly; the
   * worker never reads this map — it is core-to-core routing state carried on the job.
   */
  sourceIdsByActivity?: Record<string, string>;
}

/** The job as returned to a claiming worker (the transport response shape). */
export interface ClaimedJob {
  id: string;
  kind: Job['kind'];
  providerId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

function toClaimedJob(job: Job): ClaimedJob {
  return {
    id: job.id,
    kind: job.kind,
    providerId: job.providerId,
    payload: job.payload,
    attempts: job.attempts,
  };
}

/** The scrape-profile signature a per-activity Source contributes to job grouping. */
function scrapeProfileKey(settings: PelotonSettings): string {
  return JSON.stringify([
    effectivePelotonCap(settings),
    settings.dynamicScrolling,
    settings.maxScrolls,
    settings.scrollPauseSec,
    settings.pageLoadWaitSec,
    settings.loginWaitSec,
    settings.diskScanPath ?? null,
  ]);
}

/**
 * Build the discovery job payload(s) for a Library's per-activity Peloton Sources at enqueue time
 * (the CORE owns this). The watch-grain model (migration 0002) stores one Source PER ACTIVITY —
 * this builder re-AGGREGATES the in-scope, enabled ones back into the worker's single-job shape,
 * so one nightly login still walks every monitored activity:
 *
 *   - grouped by scrape-profile signature (effective cap + scroll/wait profile + diskScanPath):
 *     uniformly-configured activities — the normal state — produce EXACTLY ONE job; an activity
 *     with a per-source cap override honestly gets its own job at its own cap (the worker payload
 *     carries a single `maxClassesPerActivity`, and the worker image is a fixed contract);
 *   - `activities` = the group's Source refs (the activity slugs), sorted;
 *   - `existingClassIds` = the UNION across ALL of the library's Peloton sources (monitored or
 *     not) — a class already persisted under a sibling activity is never re-added (donor parity:
 *     one global existing-ids set per scrape);
 *   - `episodeNumbering` = merged across ALL Peloton sources' entries + the optional disk scan —
 *     an unmonitored activity keeps its band, so re-monitoring continues its sequence exactly
 *     (published numbering is immutable, Q-02 §6 #8);
 *   - `sourceId` = the group's first source (anchor) + `sourceIdsByActivity` for the report leg's
 *     chip-routed merge. A DISABLED activity source is simply absent from `activities`, which is
 *     what EXCLUDES it from the next scrape; its persisted entries stay put and the projection
 *     recompose skips them separately (discovery/report step 4).
 *
 * `mode:'refresh'` produces the same payload but signals mint-bearer-only.
 */
export async function buildPelotonDiscoveryPayloads(
  args: {
    runId: string;
    /** the scrape candidates (the run's in-scope sources; disabled ones are filtered here). */
    sources: Source[];
    /** EVERY Peloton source of the library (defaults to `sources`) — the dedup/numbering seed
     * always spans the full set, so a scoped or partially-unmonitored run can never renumber. */
    allSources?: Source[];
    library: Library;
    mode?: 'scrape' | 'refresh';
  },
  exec?: DbClient,
): Promise<DiscoveryPayload[]> {
  const { runId, library } = args;
  const enabled = args.sources.filter((s) => s.enabled);
  if (enabled.length === 0) return [];

  // The shared dedup + numbering seed spans EVERY Peloton source of the library (even unmonitored
  // ones — their persisted history still anchors dedup and numbering continuity).
  const allClassIds: string[] = [];
  let subsNumbering: NestedNumbering = {};
  const diskScanPaths = new Set<string>();
  for (const source of args.allSources ?? args.sources) {
    const rows = await listEntriesForSource(source.id, exec);
    for (const row of rows) allClassIds.push(row.entryKey);
    subsNumbering = mergeNumbering(subsNumbering, episodeNumberingFromEntries(rows));
    const settings = pelotonSettingsSchema.parse(source.settings);
    if (settings.diskScanPath) diskScanPaths.add(settings.diskScanPath);
  }
  let episodeNumbering = subsNumbering;
  for (const path of diskScanPaths) {
    episodeNumbering = mergeNumbering(episodeNumbering, episodesFromDisk(path));
  }
  const existingClassIds = [...new Set(allClassIds)];

  // Group the enabled activities by scrape-profile signature; one job per distinct profile.
  const groups = new Map<string, Source[]>();
  for (const source of [...enabled].sort((a, b) => a.ref.localeCompare(b.ref))) {
    const key = scrapeProfileKey(pelotonSettingsSchema.parse(source.settings));
    const group = groups.get(key);
    if (group) group.push(source);
    else groups.set(key, [source]);
  }

  const payloads: DiscoveryPayload[] = [];
  for (const group of groups.values()) {
    const anchor = group[0];
    if (!anchor) continue;
    const settings = pelotonSettingsSchema.parse(anchor.settings);
    const sourceIdsByActivity: Record<string, string> = {};
    for (const source of group) sourceIdsByActivity[source.ref] = source.id;
    payloads.push({
      runId,
      sourceId: anchor.id,
      libraryId: library.id,
      providerId: anchor.providerId,
      mode: args.mode ?? 'scrape',
      source: {
        ref: anchor.ref,
        displayName: anchor.displayName,
        mediaKind: anchor.mediaKind,
        settings: anchor.settings,
      },
      peloton: {
        activities: group.map((s) => s.ref),
        maxClassesPerActivity: effectivePelotonCap(settings),
        dynamicScrolling: settings.dynamicScrolling,
        maxScrolls: settings.maxScrolls,
        scrollPauseSec: settings.scrollPauseSec,
        pageLoadWaitSec: settings.pageLoadWaitSec,
        loginWaitSec: settings.loginWaitSec,
        existingClassIds,
        episodeNumbering,
        mediaRoot: library.mediaRoot,
        folder: buildFolderConfig(library.mediaRoot),
      },
      sourceIdsByActivity,
    });
  }
  return payloads;
}

/** Enqueue a discovery job with its full payload + the linked Run (the report/fail path finalizes). */
export async function enqueueDiscoveryJob(
  payload: DiscoveryPayload,
  exec?: DbClient,
): Promise<Job> {
  const d = resolveDb(exec) as Database;
  const inserted = await d
    .insert(jobs)
    .values({
      kind: 'discovery',
      providerId: payload.providerId,
      runId: payload.runId,
      payload: payload as unknown as Record<string, unknown>,
    })
    .returning();
  const job = inserted[0];
  if (!job) throw new Error('failed to enqueue discovery job');
  return job;
}

// --- claim ------------------------------------------------------------------------------------

export interface ClaimJobInput {
  worker: string;
  kinds?: Job['kind'][];
  providerId?: string;
  heartbeatExpirySec?: number;
  db?: DbClient;
}

/**
 * Atomically claim the oldest `queued` job OR a RECLAIMABLE one (status `claimed`/`running` whose
 * heartbeat is older than the expiry SLA — its worker died mid-job). Uses `FOR UPDATE SKIP LOCKED`
 * inside a transaction so two workers polling at once NEVER grab the same row. Sets status
 * `claimed`, records the owner, bumps `attempts`, and stamps the heartbeat. Returns null when the
 * queue has nothing for this worker.
 */
export async function claimJob(input: ClaimJobInput): Promise<ClaimedJob | null> {
  const expirySec = input.heartbeatExpirySec ?? DEFAULT_HEARTBEAT_EXPIRY_SEC;
  const d = resolveDb(input.db) as Database;
  const now = new Date();
  const cutoff = new Date(now.getTime() - expirySec * 1000);

  return d.transaction(async (tx) => {
    const reclaimable = and(
      inArray(jobs.status, ['claimed', 'running'] as const),
      lt(jobs.heartbeatAt, cutoff),
    );
    const claimable = or(eq(jobs.status, 'queued'), reclaimable);
    const filters = [claimable];
    if (input.kinds && input.kinds.length > 0) filters.push(inArray(jobs.kind, input.kinds));
    if (input.providerId) filters.push(eq(jobs.providerId, input.providerId));

    const candidates = await tx
      .select()
      .from(jobs)
      .where(and(...filters))
      .orderBy(asc(jobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    const job = candidates[0];
    if (!job) return null;

    const updated = await tx
      .update(jobs)
      .set({
        status: 'claimed',
        claimedBy: input.worker,
        claimedAt: now,
        heartbeatAt: now,
        attempts: job.attempts + 1,
        updatedAt: now,
      })
      .where(eq(jobs.id, job.id))
      .returning();
    const row = updated[0];
    if (!row) return null;
    return toClaimedJob(row);
  });
}

// --- heartbeat --------------------------------------------------------------------------------

export interface HeartbeatInput {
  id: string;
  worker: string;
  db?: DbClient;
}

/**
 * Refresh a claimed job's heartbeat and (idempotently) flip `claimed → running`. A 409
 * (ConflictError) if the caller is no longer the owner — i.e. the job was reclaimed after its
 * heartbeat lapsed. The losing worker must stop.
 */
export async function heartbeatJob(input: HeartbeatInput): Promise<{ ok: true }> {
  const d = resolveDb(input.db) as Database;
  const job = (await d.select().from(jobs).where(eq(jobs.id, input.id)).limit(1))[0];
  if (!job) throw new NotFoundError('job', input.id);
  if (job.claimedBy !== input.worker) {
    throw new ConflictError(
      `job ${input.id} is owned by "${job.claimedBy ?? '<none>'}", not "${input.worker}" (reclaimed)`,
    );
  }
  if (job.status !== 'claimed' && job.status !== 'running') {
    throw new ConflictError(`job ${input.id} is ${job.status}, not claimable for heartbeat`);
  }
  await d
    .update(jobs)
    .set({ status: 'running', heartbeatAt: new Date(), updatedAt: new Date() })
    .where(eq(jobs.id, input.id));
  return { ok: true };
}

// --- fail -------------------------------------------------------------------------------------

export const alarmKindSchema = [
  'login',
  'bearer_capture',
  'selector_drift',
  'scroll_timeout',
] as const;
export type AlarmKind = (typeof alarmKindSchema)[number];

export interface JobAlarm {
  kind: AlarmKind;
  message?: string;
}

export interface FailJobInput {
  id: string;
  worker: string;
  error: string;
  retryable: boolean;
  alarm?: JobAlarm;
  maxAttempts?: number;
  db?: DbClient;
}

export interface FailJobResult {
  status: 'requeued' | 'error';
  attempts: number;
}

/**
 * Report a job FAILURE (D-03). If `retryable` and attempts are under the ceiling, the job returns to
 * `queued` (reclaimable) and its alarm is recorded into the linked Run's telemetry while the Run
 * stays running/warn — another worker will pick it up. Otherwise the job is `error` and the linked
 * Run is FINALIZED as `error`, surfacing the alarm. A `bearer_capture` failure ALWAYS becomes an
 * alarm + retry (never a silent stale token — the donor regression this designs out).
 */
export async function failJob(input: FailJobInput): Promise<FailJobResult> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const d = resolveDb(input.db) as Database;
  const job = (await d.select().from(jobs).where(eq(jobs.id, input.id)).limit(1))[0];
  if (!job) throw new NotFoundError('job', input.id);
  if (job.claimedBy !== input.worker) {
    throw new ConflictError(
      `job ${input.id} is owned by "${job.claimedBy ?? '<none>'}", not "${input.worker}" (reclaimed)`,
    );
  }
  const now = new Date();
  const alarmTelemetry: Record<string, unknown> = {};
  if (input.alarm) {
    alarmTelemetry.alarms = [
      {
        kind: input.alarm.kind,
        message: input.alarm.message ?? input.error,
        at: now.toISOString(),
      },
    ];
    // Fold the alarm into the summary's issue-source telemetry keys so the run-summary lights up.
    if (input.alarm.kind === 'bearer_capture') alarmTelemetry.bearerCaptureRetries = job.attempts;
    if (input.alarm.kind === 'login') alarmTelemetry.loginFailures = job.attempts;
    if (input.alarm.kind === 'selector_drift') {
      alarmTelemetry.selectorDriftHits = 1;
      if (input.alarm.message) alarmTelemetry.selectorDriftActivities = [input.alarm.message];
    }
    if (input.alarm.kind === 'scroll_timeout') {
      alarmTelemetry.scrollTimeouts = [input.alarm.message ?? 'scroll timeout'];
    }
  }

  const canRetry = input.retryable && job.attempts < maxAttempts;
  if (canRetry) {
    // Requeue for another worker attempt; keep the Run running but flag warn, recording the alarm.
    await d
      .update(jobs)
      .set({
        status: 'queued',
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        error: input.error,
        updatedAt: now,
      })
      .where(eq(jobs.id, input.id));
    if (job.runId) {
      await recordRunTelemetry({ id: job.runId, telemetry: alarmTelemetry, status: 'warn', db: d });
    }
    return { status: 'requeued', attempts: job.attempts };
  }

  // Terminal failure: mark the job error and finalize the linked Run as error, surfacing the alarm.
  await d
    .update(jobs)
    .set({ status: 'error', error: input.error, updatedAt: now })
    .where(eq(jobs.id, input.id));
  if (job.runId) {
    const run = await getRun(job.runId, d);
    const mergedTelemetry = { ...(run?.telemetry ?? {}), ...alarmTelemetry };
    const counts = run?.counts ?? {};
    const summary = buildRunSummary({
      counts,
      telemetry: mergedTelemetry,
      credentialRefreshSec: PELOTON_CREDENTIAL_REFRESH_SEC,
    });
    await finishRun({
      id: job.runId,
      status: 'error',
      counts,
      telemetry: mergedTelemetry,
      summary: runSummaryToJson(summary),
      logExcerpt: input.error,
      providerId: job.providerId,
      db: d,
    });
  }
  return { status: 'error', attempts: job.attempts };
}

export async function getJob(id: string, exec?: DbClient): Promise<Job | undefined> {
  const d = resolveDb(exec) as Database;
  return (await d.select().from(jobs).where(eq(jobs.id, id)).limit(1))[0];
}

// --- worker liveness (health, D-03/D-10) ------------------------------------------------------

export interface WorkerLiveness {
  /** the most recent claim/heartbeat time across this provider's jobs (the worker's last-seen). */
  lastSeenAt: Date;
  /** the status of that most-recent worker-touched job. */
  lastJobStatus: Job['status'];
  /**
   * true when that job is STILL in-flight (`claimed`/`running`) but its heartbeat is older than the
   * reclaim expiry SLA — i.e. the worker died mid-job. A genuine, honest health signal (the reclaim
   * loop will pick the job up, but health should say so meanwhile).
   */
  stuck: boolean;
}

/**
 * Cheapest observable worker-liveness signal for an `out_of_process` provider (DESIGN-045 D-03/D-10):
 * the most recent claim/heartbeat across this provider's jobs. The OBSERVED-state health model reads
 * it for providers whose core-side `test()` can't reach the worker's credentials. Only jobs a worker
 * has actually CLAIMED carry a heartbeat, so a never-claimed queued job is not a liveness signal.
 *
 * Returns undefined when no worker has ever claimed a job for this provider (a freshly-added provider,
 * or one whose first run hasn't dispatched) — that is NOT unhealthy, so the caller must not alarm.
 */
export async function getWorkerLivenessForProvider(
  providerId: string,
  opts?: { heartbeatExpirySec?: number; now?: Date; db?: DbClient },
): Promise<WorkerLiveness | undefined> {
  const d = resolveDb(opts?.db) as Database;
  const now = opts?.now ?? new Date();
  const expirySec = opts?.heartbeatExpirySec ?? DEFAULT_HEARTBEAT_EXPIRY_SEC;
  const row = (
    await d
      .select()
      .from(jobs)
      .where(and(eq(jobs.providerId, providerId), isNotNull(jobs.heartbeatAt)))
      .orderBy(desc(jobs.heartbeatAt))
      .limit(1)
  )[0];
  if (!row?.heartbeatAt) return undefined;
  const inFlight = row.status === 'claimed' || row.status === 'running';
  const stale = now.getTime() - row.heartbeatAt.getTime() > expirySec * 1000;
  return { lastSeenAt: row.heartbeatAt, lastJobStatus: row.status, stuck: inFlight && stale };
}
