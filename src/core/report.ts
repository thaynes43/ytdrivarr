import { eq } from 'drizzle-orm';
import { jobs, type SubscriptionEntryRow } from '../db/schema';
import { resolveDb } from '../db/client';
import type { Database, DbClient } from '../db';
import {
  subscriptionEntrySchema,
  type SessionArtifacts,
  type SubscriptionEntry,
} from '../contracts';
import { resolveCredentialSla } from '../contracts/scheduling';
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
import { applyEmitWindow, DEFAULT_EMIT_WINDOW_DAYS, type EntryWindowMeta } from './emit-window';
import { emitLibrary } from './emitter';
import { projectLibrary, resolveProjectionDir } from './projection';
import { getLibrary } from '../domain/libraries';
import { listSourcesForLibrary } from '../domain/sources';
import {
  countEntriesBySource,
  listEntriesForSource,
  loadPublishedNumbering,
  mergeEntriesForSource,
} from '../domain/entries';
import { finishRun } from '../domain/runs';
import { buildRunSummary, renderRunSummaryMarkdown, runSummaryToJson } from '../domain/run-summary';
import {
  effectivePelotonCap,
  pelotonSettingsSchema,
  PELOTON_SESSION_KEY,
} from '../providers/peloton';
import { activitySlugFromChip } from '../providers/peloton/folder-mapping';
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
  /** D-14 — the donor-parity emit window (days) for entry-grain providers; 0 = unbounded. Defaults
   * to `DEFAULT_EMIT_WINDOW_DAYS` when unset so the window is ON even if a caller forgets to thread it. */
  emitWindowDays?: number;
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
  const sources = await listSourcesForLibrary(libraryId, d);

  // 1) validate the reported entries.
  const validated = input.result.entries.map((e) => subscriptionEntrySchema.parse(e));

  // 2) ROUTE each entry to its per-activity Source by chip (the watch-grain model, migration
  //    0002), then MERGE (not replace) per Source, preserving immutable published numbering.
  //    Routing precedence: the library's per-activity sources by ref (covers even a pre-split
  //    payload reported after the migration), overlaid with the payload's own
  //    `sourceIdsByActivity` map; an entry whose chip resolves to no known activity falls back
  //    to the payload's anchor `sourceId` — exactly the pre-split behavior.
  //    The donor-parity title guard runs per target: a re-aired class under an already-bound
  //    (chip, displayName) is skipped, exactly as the donor scraper skipped re-aired titles (a
  //    second same-title row could never surface in the projection anyway — the emitted YAML
  //    map keys by title).
  const routing = new Map<string, string>();
  for (const source of sources) {
    if (source.providerId === job.providerId) routing.set(source.ref, source.id);
  }
  for (const [slug, id] of Object.entries(payload.sourceIdsByActivity ?? {})) {
    routing.set(slug, id);
  }
  const partitions = new Map<string, SubscriptionEntry[]>();
  for (const entry of validated) {
    const slug = activitySlugFromChip(entry.chip);
    const target = (slug !== undefined ? routing.get(slug) : undefined) ?? sourceId;
    const bucket = partitions.get(target);
    if (bucket) bucket.push(entry);
    else partitions.set(target, [entry]);
  }

  // Pre-merge per-source tallies — the per-activity Changes rows compare against these.
  const preCounts = await countEntriesBySource(d);

  const merged = { added: 0, updated: 0, total: 0 };
  let titleCollisionsDropped = 0;
  for (const [targetSourceId, bucket] of partitions) {
    const existingRows = await listEntriesForSource(targetSourceId, d);
    const titleGuard = dropTitleCollisions(
      bucket,
      existingRows.map((row) => rowToEntry(row)),
    );
    titleCollisionsDropped += titleGuard.dropped;
    const published = await loadPublishedNumbering(targetSourceId, d);
    const numbered = preservePublishedNumbering(titleGuard.kept, published);
    const result = await mergeEntriesForSource(targetSourceId, numbered, d);
    merged.added += result.added;
    merged.updated += result.updated;
    merged.total += result.total;
  }

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

  // 4) recompose the whole library from ALL persisted entries, apply the donor-parity emit window
  //    (entry-grain providers only — stale classes drop from the FILE, their ledger rows + immutable
  //    numbering stay), and atomically project. An UNMONITORED (enabled=false) source's entries
  //    stay in the database but are EXCLUDED here — that is exactly what unmonitoring an activity
  //    removes from the projection, and what re-monitoring restores. `merged.total` is recomputed
  //    across the provider's sources so the Run's `entries` count spans every activity (the
  //    LEDGER, not the windowed file), and the window map carries each row's first-seen
  //    (createdAt) + whether its provider opts in.
  const emitWindowDays = input.emitWindowDays ?? DEFAULT_EMIT_WINDOW_DAYS;
  const libraryEntries: SubscriptionEntry[] = [];
  const windowMeta = new Map<string, EntryWindowMeta>();
  const postCounts = new Map<string, number>();
  merged.total = 0;
  for (const source of sources) {
    const rows = await listEntriesForSource(source.id, d);
    postCounts.set(source.id, rows.length);
    if (source.providerId === job.providerId || source.id === sourceId) {
      merged.total += rows.length;
    }
    if (!source.enabled) continue;
    const providerWindowed = getProvider(source.providerId).emitWindow === true;
    for (const row of rows) {
      libraryEntries.push(rowToEntry(row));
      if (!windowMeta.has(row.entryKey)) {
        windowMeta.set(row.entryKey, { firstSeenAt: row.createdAt, windowed: providerWindowed });
      }
    }
  }
  const deduped = dedupTitleCollisions(dedupEntries(libraryEntries));
  const windowed = applyEmitWindow(deduped, windowMeta, emitWindowDays);
  const emitted = emitLibrary(
    {
      presetName: library.presetName,
      workingDirectory: library.workingDirectory,
      emitPolicy: library.emitPolicy,
      libraryKind: library.libraryKind,
    },
    windowed.emitted,
  );
  const dir = resolveProjectionDir(library.projectionPath, input.projectionRoot);
  await projectLibrary(dir, emitted);

  // 5) finalize the Run with counts + telemetry + the owner summary, and mark the job done.
  //    The watch-grain split makes the per-activity Changes breakdown a CORE fact: each activity
  //    Source's pre/post entry counts give existing/added/total, the worker's raw `perActivity`
  //    telemetry contributes scraped/skipped/scrolls, and at-cap compares THIS SCRAPE's adds
  //    against the activity's effective cap (persisted totals accumulate past the cap by design).
  //    Composed only when the worker did not send `activities` itself (it never has to).
  const telemetry: Record<string, unknown> = { ...(input.result.telemetry ?? {}) };
  if (telemetry.activities === undefined) {
    const rawPerActivity = new Map<string, Record<string, unknown>>();
    const perActivity = telemetry.perActivity;
    if (Array.isArray(perActivity)) {
      for (const row of perActivity) {
        if (
          row &&
          typeof row === 'object' &&
          typeof (row as { activity?: unknown }).activity === 'string'
        ) {
          rawPerActivity.set(
            (row as { activity: string }).activity,
            row as Record<string, unknown>,
          );
        }
      }
    }
    const providerSources = sources
      .filter((s) => s.providerId === job.providerId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (providerSources.length > 0) {
      telemetry.activities = providerSources.map((source) => {
        const pre = preCounts.get(source.id) ?? 0;
        const post = postCounts.get(source.id) ?? pre;
        const raw = rawPerActivity.get(source.ref);
        const parsed = pelotonSettingsSchema.safeParse(source.settings);
        const cap = effectivePelotonCap(parsed.success ? parsed.data : {});
        const added = Math.max(0, post - pre);
        const numOr = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
        return {
          activity: source.displayName,
          existing: pre,
          added,
          total: post,
          ...(numOr(raw?.linksFound) !== undefined ? { scraped: numOr(raw?.linksFound) } : {}),
          ...(numOr(raw?.skippedExisting) !== undefined
            ? { skipped: numOr(raw?.skippedExisting) }
            : {}),
          ...(numOr(raw?.scrollsPerformed) !== undefined
            ? { scrolls: numOr(raw?.scrollsPerformed) }
            : {}),
          cap,
          atCap: added === cap,
          overCap: added > cap,
        };
      });
    }
  }
  const counts: Record<string, number> = {
    discovered: validated.length,
    added: merged.added,
    updated: merged.updated,
    deduped: libraryEntries.length - deduped.length,
    titleCollisions: titleCollisionsDropped,
    windowedOut: windowed.dropped,
    emitted: windowed.emitted.length,
    entries: merged.total,
  };
  const provider = getProvider(job.providerId);
  const credentialSla = resolveCredentialSla(provider.scheduling);
  const summary = buildRunSummary({
    counts,
    telemetry,
    ...(input.result.session?.mintedAt !== undefined
      ? { sessionMintedAt: input.result.session.mintedAt }
      : {}),
    ...(credentialSla !== undefined ? { credentialSla } : {}),
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
      providerId: job.providerId,
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
