import { logger } from '../logger';
import { getProvider } from './registry';
import { dispatchDiscovery } from './dispatcher';
import { buildPelotonDiscoveryPayloads, enqueueDiscoveryJob } from './jobs';
import { createStateStore } from './state-store';
import { preservePublishedNumbering } from './dedup';
import { DEFAULT_EMIT_WINDOW_DAYS } from './emit-window';
import { projectLibrary, resolveProjectionDir } from './projection';
import { recomposeLibrary, type RecomposeSource } from './recompose';
import { buildRunSummary, runSummaryToJson } from '../domain/run-summary';
import { subscriptionEntrySchema, type ProviderContext, type SourceView } from '../contracts';
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
import type { Library, Source } from '../db/schema';
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
  /** scope='provider' — the provider whose sources this run is confined to (the per-provider
   * scheduled cron tick). Carried on the Run as `providerId` (honest provenance), NOT `scopeRef`
   * (which is a uuid column; a provider id is a slug). A YouTube tick discovers only YouTube
   * sources and enqueues NO Peloton scrape job; scope='all' still covers every provider. */
  providerId?: string;
  trigger?: RunTrigger;
  projectionRoot?: string;
  /** D-14 — the donor-parity emit window (days) for entry-grain providers; 0 = unbounded. Defaults
   * to `DEFAULT_EMIT_WINDOW_DAYS` when unset so the window is ON even if a caller forgets to thread it. */
  emitWindowDays?: number;
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

export async function resolveLibraries(
  input: { scope: RunScope; scopeRef?: string },
  exec?: DbClient,
): Promise<Library[]> {
  // scope='all' and scope='provider' both walk every Library — a provider's sources can span
  // Libraries, and the per-Library source filter (inDiscoveryScope) narrows to the provider.
  if (input.scope === 'all' || input.scope === 'provider') return listLibraries(exec);
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
  // A provider-scoped tick sees ONLY its own provider's sources — this is what keeps a YouTube
  // safety re-emit from ever aggregating Peloton sources into a scrape job (the daily-double-login
  // bug), while scope='all' (manual/API) still returns true for every source.
  if (input.scope === 'provider') return source.providerId === input.providerId;
  return true;
}

export async function runDiscovery(input: RunDiscoveryInput): Promise<DiscoveryOutcome> {
  // Provider-scoped runs must name a real provider; the id is stamped onto the Run so its
  // provenance is honest (metrics/console attribute it to that provider, never mislabel it).
  if (input.scope === 'provider') {
    if (!input.providerId) throw new ValidationError('scope=provider requires providerId');
    getProvider(input.providerId); // throws on an unknown provider id
  }
  const run = await startRun({
    scope: input.scope,
    ...(input.scopeRef !== undefined ? { scopeRef: input.scopeRef } : {}),
    trigger: input.trigger ?? 'api',
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
    ...(input.db !== undefined ? { db: input.db } : {}),
  });
  const emitWindowDays = input.emitWindowDays ?? DEFAULT_EMIT_WINDOW_DAYS;
  const counts = {
    libraries: 0,
    sources: 0,
    discovered: 0,
    deduped: 0,
    windowedOut: 0,
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

      // 1) Discover the in-scope, enabled sources and persist their entries. `out_of_process`
      //    sources are COLLECTED per provider and enqueued AGGREGATED below — the watch-grain
      //    model stores one Peloton Source per activity, but the worker still logs in once and
      //    walks every monitored activity in one job (D-03).
      const outOfProcessByProvider = new Map<string, Source[]>();
      for (const source of sources) {
        if (!source.enabled || !inDiscoveryScope(input, source)) continue;
        counts.sources += 1;
        const provider = getProvider(source.providerId);

        if (provider.runtime === 'out_of_process') {
          const group = outOfProcessByProvider.get(source.providerId);
          if (group) group.push(source);
          else outOfProcessByProvider.set(source.providerId, [source]);
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

      // out_of_process (Peloton): enqueue aggregated job(s) carrying the Run id + the full
      // discovery payload; the worker scrapes and reports back (D-03). Never scrape inline.
      // The dedup/numbering seed spans ALL of the provider's sources in this library, in scope
      // or not, so a scoped or partially-unmonitored run can never renumber a sibling.
      for (const [providerId, scrapeSources] of outOfProcessByProvider) {
        const allSources = sources.filter((s) => s.providerId === providerId);
        const payloads = await buildPelotonDiscoveryPayloads(
          { runId: run.id, sources: scrapeSources, allSources, library },
          input.db,
        );
        for (const payload of payloads) {
          await enqueueDiscoveryJob(payload, input.db);
          counts.queued += 1;
          queuedOutOfProcess = true;
        }
      }

      // 2) Recompose the WHOLE library from all persisted entries (a per-source run must not wipe
      //    its siblings) and atomically project. The DB reads live here; recomposeLibrary is the pure
      //    dedup + emit-window + render core (shared with the report leg). Only enabled sources
      //    contribute to the projection, so a disabled source's rows are never read.
      const recomposeSources: RecomposeSource[] = [];
      for (const source of sources) {
        const rows = source.enabled ? await listEntriesForSource(source.id, input.db) : [];
        recomposeSources.push({ providerId: source.providerId, enabled: source.enabled, rows });
      }
      const recomposed = recomposeLibrary(
        {
          presetName: library.presetName,
          workingDirectory: library.workingDirectory,
          emitPolicy: library.emitPolicy,
          libraryKind: library.libraryKind,
        },
        recomposeSources,
        emitWindowDays,
      );
      counts.deduped += recomposed.dedupedCount;
      counts.windowedOut += recomposed.windowedOutCount;
      const dir = resolveProjectionDir(library.projectionPath, input.projectionRoot);
      await projectLibrary(dir, recomposed.emitted);
      counts.emitted += recomposed.emittedEntries.length;
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
