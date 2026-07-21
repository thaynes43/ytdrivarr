import { logger } from '../logger';
import { getProvider } from './registry';
import { dispatchDiscovery } from './dispatcher';
import { buildDiscoveryPayload, enqueueDiscoveryJob } from './jobs';
import { createStateStore } from './state-store';
import { dedupEntries, dedupTitleCollisions, preservePublishedNumbering } from './dedup';
import { emitLibrary } from './emitter';
import { projectLibrary, resolveProjectionDir } from './projection';
import { buildRunSummary, runSummaryToJson } from '../domain/run-summary';
import {
  subscriptionEntrySchema,
  type ProviderContext,
  type SourceView,
  type SubscriptionEntry,
} from '../contracts';
import {
  finishRun,
  startRun,
  type RunScope,
  type RunStatus,
  type RunTrigger,
} from '../domain/runs';
import { getLibrary, listLibraries } from '../domain/libraries';
import { getSource, listSourcesForLibrary } from '../domain/sources';
import {
  listEntriesForSource,
  loadPublishedNumbering,
  replaceEntriesForSource,
} from '../domain/entries';
import type { Library, Source, SubscriptionEntryRow } from '../db/schema';
import type { DbClient } from '../db';
import { NotFoundError, ValidationError } from '../errors';

/**
 * The discovery orchestrator (DESIGN-045 D-06/D-13/D-14) — the M1 end-to-end proof. For each
 * Library in scope: dispatch discovery per enabled Source (in_core inline; out_of_process enqueues
 * a job), persist each Source's deduped + IMMUTABLY-numbered entries, then RECOMPOSE the whole
 * Library from ALL its persisted entries and ATOMICALLY project `config.yaml` + `subscriptions.yaml`
 * to its projectionPath. Records a Run (the machine-level history + telemetry, D-08).
 */

export interface RunDiscoveryInput {
  scope: RunScope;
  scopeRef?: string;
  trigger?: RunTrigger;
  projectionRoot?: string;
  db?: DbClient;
}

export interface DiscoveryOutcome {
  runId: string;
  status: RunStatus;
  counts: Record<string, number>;
  projected: { libraryId: string; dir: string }[];
}

function toSourceView(source: Source): SourceView {
  return {
    id: source.id,
    libraryId: source.libraryId,
    providerId: source.providerId,
    kind: source.kind,
    mediaKind: source.mediaKind,
    displayName: source.displayName,
    ref: source.ref,
    settings: source.settings,
    enabled: source.enabled,
  };
}

export function buildContext(
  source: Source,
  stateNamespace: string,
  exec?: DbClient,
): ProviderContext {
  return {
    source: toSourceView(source),
    secrets: {},
    state: createStateStore(stateNamespace, exec),
    logger: logger.child({ source: source.id }),
  };
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

async function resolveLibraries(input: RunDiscoveryInput, exec?: DbClient): Promise<Library[]> {
  if (input.scope === 'all') return listLibraries(exec);
  if (input.scope === 'library') {
    if (!input.scopeRef) throw new ValidationError('scope=library requires scopeRef');
    const lib = await getLibrary(input.scopeRef, exec);
    if (!lib) throw new NotFoundError('library', input.scopeRef);
    return [lib];
  }
  // scope === 'source'
  if (!input.scopeRef) throw new ValidationError('scope=source requires scopeRef');
  const source = await getSource(input.scopeRef, exec);
  if (!source) throw new NotFoundError('source', input.scopeRef);
  const lib = await getLibrary(source.libraryId, exec);
  if (!lib) throw new NotFoundError('library', source.libraryId);
  return [lib];
}

function inDiscoveryScope(input: RunDiscoveryInput, source: Source): boolean {
  if (input.scope === 'source') return source.id === input.scopeRef;
  return true;
}

export async function runDiscovery(input: RunDiscoveryInput): Promise<DiscoveryOutcome> {
  const run = await startRun({
    scope: input.scope,
    ...(input.scopeRef !== undefined ? { scopeRef: input.scopeRef } : {}),
    trigger: input.trigger ?? 'api',
    ...(input.db !== undefined ? { db: input.db } : {}),
  });
  const counts = {
    libraries: 0,
    sources: 0,
    discovered: 0,
    deduped: 0,
    emitted: 0,
    queued: 0,
  };
  const projected: { libraryId: string; dir: string }[] = [];
  // DESIGN-045 D-03: if ANY out_of_process job is queued, the Run stays `running` — the worker's
  // report/fail finalizes it (in the report/fail path). in_core-only runs finalize here.
  let queuedOutOfProcess = false;

  try {
    const libs = await resolveLibraries(input, input.db);
    for (const library of libs) {
      counts.libraries += 1;
      const sources = await listSourcesForLibrary(library.id, input.db);

      // 1) Discover the in-scope, enabled sources and persist their entries.
      for (const source of sources) {
        if (!source.enabled || !inDiscoveryScope(input, source)) continue;
        counts.sources += 1;
        const provider = getProvider(source.providerId);

        // out_of_process (Peloton): enqueue a job carrying the Run id + the full discovery payload;
        // the worker scrapes and reports back (D-03). Do NOT run the scrape inline.
        if (provider.runtime === 'out_of_process') {
          const payload = await buildDiscoveryPayload({ runId: run.id, source, library }, input.db);
          await enqueueDiscoveryJob(payload, input.db);
          counts.queued += 1;
          queuedOutOfProcess = true;
          continue;
        }

        const ctx = buildContext(source, provider.stateNamespace, input.db);
        const dispatch = await dispatchDiscovery(provider, ctx, input.db);
        if (dispatch.mode !== 'in_core') {
          counts.queued += 1;
          queuedOutOfProcess = true;
          continue;
        }
        const validated = dispatch.entries.map((entry) => subscriptionEntrySchema.parse(entry));
        counts.discovered += validated.length;
        const published = await loadPublishedNumbering(source.id, input.db);
        const numbered = preservePublishedNumbering(validated, published);
        await replaceEntriesForSource(source.id, numbered, input.db);
      }

      // 2) Recompose the WHOLE library from all persisted entries (a per-source run must not wipe
      //    its siblings), dedup cross-source, emit, and atomically project.
      const libraryEntries: SubscriptionEntry[] = [];
      for (const source of sources) {
        if (!source.enabled) continue;
        const rows = await listEntriesForSource(source.id, input.db);
        for (const row of rows) libraryEntries.push(rowToEntry(row));
      }
      const deduped = dedupTitleCollisions(dedupEntries(libraryEntries));
      counts.deduped += libraryEntries.length - deduped.length;

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
      counts.emitted += deduped.length;
      projected.push({ libraryId: library.id, dir });
    }

    // An out_of_process job was queued: leave the Run RUNNING (the worker report/fail finalizes it,
    // D-03). The in_core parts have already persisted + projected; the worker re-projects on report.
    if (queuedOutOfProcess) {
      return { runId: run.id, status: 'running', counts, projected };
    }

    // in_core-only run: finalize now, with the owner's Changes/Health/Issues summary (D-10) built
    // from the counts (no per-activity telemetry for a URL provider — it degrades gracefully).
    const summary = buildRunSummary({ counts });
    await finishRun({
      id: run.id,
      status: 'ok',
      counts,
      summary: runSummaryToJson(summary),
      ...(input.db !== undefined ? { db: input.db } : {}),
    });
    return { runId: run.id, status: 'ok', counts, projected };
  } catch (err) {
    logger.error({ err }, 'discovery run failed');
    await finishRun({
      id: run.id,
      status: 'error',
      counts,
      logExcerpt: err instanceof Error ? err.message : String(err),
      ...(input.db !== undefined ? { db: input.db } : {}),
    });
    throw err;
  }
}
