import { eq } from 'drizzle-orm';
import { jobs, type SubscriptionEntryRow } from '../db/schema';
import { resolveDb } from '../db/client';
import type { Database, DbClient } from '../db';
import {
  subscriptionEntrySchema,
  type SessionArtifacts,
  type SubscriptionEntry,
} from '../contracts';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { getProvider } from './registry';
import { createStateStore } from './state-store';
import { deliverSession } from './credentials';
import {
  dedupEntries,
  dedupTitleCollisions,
  dropTitleCollisions,
  preservePublishedNumbering,
} from './dedup';
import { emitLibrary } from './emitter';
import { projectLibrary, resolveProjectionDir } from './projection';
import { getLibrary } from '../domain/libraries';
import { listSourcesForLibrary } from '../domain/sources';
import {
  listEntriesForSource,
  loadPublishedNumbering,
  mergeEntriesForSource,
} from '../domain/entries';
import { finishRun } from '../domain/runs';
import { buildRunSummary, renderRunSummaryMarkdown, runSummaryToJson } from '../domain/run-summary';
import { PELOTON_SESSION_KEY } from '../providers/peloton';
import type { DiscoveryPayload } from './jobs';

/**
 * The out-of-process REPORT leg (DESIGN-045 D-03/D-05/D-06/D-10) — a worker reports its scraped
 * `SubscriptionEntry[]` + a minted session + telemetry, and the CORE (the single DB writer):
 *   1. validates the entries;
 *   2. MERGES them into the source (a scrape returns only NEW classes — never wipe the siblings),
 *      preserving IMMUTABLE published numbering (the re-key guard);
 *   3. delivers the session artifacts (bearer.txt / cookies.txt) to the downloader's reach + records
 *      the mint time in provider state (the credential-age alarm reads it);
 *   4. recomposes the whole Library and ATOMICALLY projects config.yaml + subscriptions.yaml;
 *   5. FINALIZES the linked Run (ok/warn) with counts, telemetry, and the rendered owner summary,
 *      and marks the job done.
 */

export interface ReportResultBody {
  entries: SubscriptionEntry[];
  session?: SessionArtifacts;
  telemetry?: Record<string, unknown>;
  summary?: Record<string, unknown>;
}

export interface ReportJobInput {
  id: string;
  worker: string;
  result: ReportResultBody;
  projectionRoot?: string;
  credentialRoot?: string;
  db?: DbClient;
}

export interface ReportJobOutcome {
  jobId: string;
  runId: string | null;
  status: 'ok' | 'warn';
  counts: Record<string, number>;
  merged: { added: number; updated: number };
  projected?: { libraryId: string; dir: string };
  credential?: { bearer: boolean; cookies: boolean };
}

function rowToEntry(row: SubscriptionEntryRow): SubscriptionEntry {
  const entry: SubscriptionEntry = {
    entryKey: row.entryKey,
    displayName: row.displayName,
    downloadRef: row.downloadRef,
    preset: row.preset,
  };
  if (row.chip !== null) entry.chip = row.chip;
  if (row.overrides !== null) entry.overrides = row.overrides;
  if (row.ytdlOptions !== null) entry.ytdlOptions = row.ytdlOptions;
  if (row.assets !== null) entry.assets = row.assets;
  return entry;
}

export async function reportJob(input: ReportJobInput): Promise<ReportJobOutcome> {
  const d = resolveDb(input.db) as Database;
  const job = (await d.select().from(jobs).where(eq(jobs.id, input.id)).limit(1))[0];
  if (!job) throw new NotFoundError('job', input.id);
  if (job.claimedBy !== input.worker) {
    throw new ConflictError(
      `job ${input.id} is owned by "${job.claimedBy ?? '<none>'}", not "${input.worker}" (reclaimed)`,
    );
  }
  const payload = job.payload as unknown as DiscoveryPayload;
  const sourceId = payload.sourceId;
  const libraryId = payload.libraryId;
  if (!sourceId || !libraryId) {
    throw new ValidationError('job payload is missing sourceId/libraryId');
  }
  const library = await getLibrary(libraryId, d);
  if (!library) throw new NotFoundError('library', libraryId);

  // 1) validate the reported entries.
  const validated = input.result.entries.map((e) => subscriptionEntrySchema.parse(e));

  // 2) MERGE (not replace), preserving immutable published numbering. The donor-parity title
  //    guard runs first: a re-aired class under an already-bound (chip, displayName) is skipped,
  //    exactly as the donor scraper skipped re-aired titles (a second same-title row could never
  //    surface in the projection anyway — the emitted YAML map keys by title).
  const existingRows = await listEntriesForSource(sourceId, d);
  const titleGuard = dropTitleCollisions(
    validated,
    existingRows.map((row) => rowToEntry(row)),
  );
  const published = await loadPublishedNumbering(sourceId, d);
  const numbered = preservePublishedNumbering(titleGuard.kept, published);
  const merged = await mergeEntriesForSource(sourceId, numbered, d);

  // 3) deliver the session artifacts + record the mint time (the credential-age alarm, D-10).
  let credential: { bearer: boolean; cookies: boolean } | undefined;
  if (input.result.session) {
    const session = input.result.session;
    const delivery = await deliverSession(library, session, input.credentialRoot);
    credential = {
      bearer: delivery.bearerPath !== undefined,
      cookies: delivery.cookiesPath !== undefined,
    };
    if (session.mintedAt !== undefined) {
      const provider = getProvider(job.providerId);
      const state = createStateStore(provider.stateNamespace, d);
      await state.set(PELOTON_SESSION_KEY, {
        mintedAt: session.mintedAt,
        ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
      });
    }
  }

  // 4) recompose the whole library from ALL persisted entries + atomically project.
  const sources = await listSourcesForLibrary(libraryId, d);
  const libraryEntries: SubscriptionEntry[] = [];
  for (const source of sources) {
    if (!source.enabled) continue;
    const rows = await listEntriesForSource(source.id, d);
    for (const row of rows) libraryEntries.push(rowToEntry(row));
  }
  const deduped = dedupTitleCollisions(dedupEntries(libraryEntries));
  const emitted = emitLibrary(
    {
      presetName: library.presetName,
      workingDirectory: library.workingDirectory,
      emitPolicy: library.emitPolicy,
      libraryKind: library.libraryKind,
    },
    deduped,
  );
  const dir = resolveProjectionDir(library.projectionPath, input.projectionRoot);
  await projectLibrary(dir, emitted);

  // 5) finalize the Run with counts + telemetry + the owner summary, and mark the job done.
  const telemetry = input.result.telemetry ?? {};
  const counts: Record<string, number> = {
    discovered: validated.length,
    added: merged.added,
    updated: merged.updated,
    deduped: libraryEntries.length - deduped.length,
    titleCollisions: titleGuard.dropped,
    emitted: deduped.length,
    entries: merged.total,
  };
  const provider = getProvider(job.providerId);
  const credentialRefreshSec =
    provider.scheduling.mode === 'cron' ? provider.scheduling.credentialRefreshSec : undefined;
  const summary = buildRunSummary({
    counts,
    telemetry,
    ...(input.result.session?.mintedAt !== undefined
      ? { sessionMintedAt: input.result.session.mintedAt }
      : {}),
    ...(credentialRefreshSec !== undefined ? { credentialRefreshSec } : {}),
  });
  const status: 'ok' | 'warn' = summary.issues.length > 0 ? 'warn' : 'ok';

  if (job.runId) {
    await finishRun({
      id: job.runId,
      status,
      counts,
      telemetry,
      summary: runSummaryToJson(summary),
      logExcerpt: renderRunSummaryMarkdown(summary),
      db: d,
    });
  }

  await d
    .update(jobs)
    .set({
      status: 'done',
      result: input.result as unknown as Record<string, unknown>,
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, input.id));

  const outcome: ReportJobOutcome = {
    jobId: job.id,
    runId: job.runId,
    status,
    counts,
    merged: { added: merged.added, updated: merged.updated },
    projected: { libraryId, dir },
  };
  if (credential) outcome.credential = credential;
  return outcome;
}
