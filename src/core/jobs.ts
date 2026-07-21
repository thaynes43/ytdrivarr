import { and, asc, eq, inArray, lt, or } from 'drizzle-orm';
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
import { pelotonSettingsSchema, PELOTON_CREDENTIAL_REFRESH_SEC } from '../providers/peloton';
import { buildFolderConfig, type FolderConfig } from '../providers/peloton/folder-mapping';
import { episodeNumberingFromEntries } from '../providers/peloton/numbering';

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
  /** GLOBAL-per-duration seed: {duration → current max episode} across ALL activities (D-06). */
  episodeNumbering: Record<string, number>;
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

/**
 * Build a discovery job's full payload at enqueue time (the CORE owns this). `existingClassIds` and
 * the GLOBAL-per-duration `episodeNumbering` seed are computed from the source's PERSISTED entries
 * (entryKey = classId; episodeNumbering[duration] = max episode where season = duration, across all
 * activities). `mode:'refresh'` produces the same payload but signals mint-bearer-only (no scrape).
 */
export async function buildDiscoveryPayload(
  args: { runId: string; source: Source; library: Library; mode?: 'scrape' | 'refresh' },
  exec?: DbClient,
): Promise<DiscoveryPayload> {
  const { runId, source, library } = args;
  const rows = await listEntriesForSource(source.id, exec);
  const existingClassIds = rows.map((r) => r.entryKey);
  const episodeNumbering = episodeNumberingFromEntries(rows);
  const settings = pelotonSettingsSchema.parse(source.settings);

  return {
    runId,
    sourceId: source.id,
    libraryId: library.id,
    providerId: source.providerId,
    mode: args.mode ?? 'scrape',
    source: {
      ref: source.ref,
      displayName: source.displayName,
      mediaKind: source.mediaKind,
      settings: source.settings,
    },
    peloton: {
      activities: settings.activities,
      maxClassesPerActivity: settings.maxClassesPerActivity,
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
  };
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
      db: d,
    });
  }
  return { status: 'error', attempts: job.attempts };
}

export async function getJob(id: string, exec?: DbClient): Promise<Job | undefined> {
  const d = resolveDb(exec) as Database;
  return (await d.select().from(jobs).where(eq(jobs.id, id)).limit(1))[0];
}
