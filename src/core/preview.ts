import { getProvider } from './registry';
import { buildContext, resolveLibraries } from './discovery';
import { preservePublishedNumbering } from './dedup';
import { DEFAULT_EMIT_WINDOW_DAYS, type EntryWindowMeta } from './emit-window';
import { composeAndEmit } from './recompose';
import { subscriptionEntrySchema, type SubscriptionEntry } from '../contracts';
import { listSourcesForLibrary } from '../domain/sources';
import { listEntriesForSource, loadPublishedNumbering, rowToEntry } from '../domain/entries';
import type { RunScope } from '../domain/runs';
import type { DbClient } from '../db';

/**
 * Dry-run / PREVIEW (DESIGN-045 D-14; dry-run design PR2) — compute the would-be `config.yaml` +
 * `subscriptions.yaml` and the would-be entry diff for a discovery run WITHOUT any side effect: it
 * reads the current ledger read-only, SIMULATES the post-run entry set in memory, and renders via
 * the pure `composeAndEmit`. It NEVER persists entries, writes the projection volume, delivers
 * credentials, enqueues a job, or records a Run.
 *
 * This module deliberately imports NO writer (`projectLibrary`, `deliverSession`,
 * `replaceEntriesForSource`/`mergeEntriesForSource`, `enqueueDiscoveryJob`, `startRun`, `state.set`)
 * and never calls `dispatchDiscovery` (whose `out_of_process` branch INSERTS a job row) — for
 * `in_core` providers it calls the pure `provider.discover(ctx)` directly.
 *
 * `out_of_process` (Peloton) is NOT content-previewable at dispatch: the scrape only happens in the
 * worker, so a preview shows that source's CURRENT ledger (which is exactly what a real Peloton
 * dispatch-time run projects, before the worker reports) and flags it `previewable: false`.
 */

export interface PreviewDiscoveryInput {
  scope: RunScope;
  scopeRef?: string;
  /** donor-parity emit window (days); defaults to DEFAULT_EMIT_WINDOW_DAYS. */
  emitWindowDays?: number;
  db?: DbClient;
  /** evaluation clock — the first-seen stamp for a genuinely-new (unwindowed) entry. Tests inject. */
  now?: Date;
}

/** Per-source would-change summary, diffed by `entryKey` (current ledger vs the simulated post-run set). */
export interface PreviewSourceDiff {
  sourceId: string;
  providerId: string;
  displayName: string;
  ref: string;
  /** false for an out_of_process source at dispatch — its new classes need a real worker scrape. */
  previewable: boolean;
  added: number;
  removed: number;
  unchanged: number;
}

export interface PreviewLibrary {
  libraryId: string;
  library: string;
  /** the would-be rendered files (NOT written anywhere). */
  configYaml: string;
  subscriptionsYaml: string;
  emitted: number;
  deduped: number;
  windowedOut: number;
  sources: PreviewSourceDiff[];
}

export interface PreviewDiscoveryOutcome {
  libraries: PreviewLibrary[];
  /** honest caveats (e.g. an out_of_process source whose new classes a preview cannot synthesize). */
  warnings: string[];
}

export async function previewDiscovery(
  input: PreviewDiscoveryInput,
): Promise<PreviewDiscoveryOutcome> {
  const emitWindowDays = input.emitWindowDays ?? DEFAULT_EMIT_WINDOW_DAYS;
  const libs = await resolveLibraries({ scope: input.scope, scopeRef: input.scopeRef }, input.db);
  const warnings: string[] = [];
  const libraries: PreviewLibrary[] = [];

  for (const library of libs) {
    const sources = await listSourcesForLibrary(library.id, input.db);
    const libraryEntries: SubscriptionEntry[] = [];
    const windowMeta = new Map<string, EntryWindowMeta>();
    const diffs: PreviewSourceDiff[] = [];

    for (const source of sources) {
      const currentRows = await listEntriesForSource(source.id, input.db);
      const currentKeys = new Set(currentRows.map((r) => r.entryKey));
      const firstSeenByKey = new Map(currentRows.map((r) => [r.entryKey, r.createdAt]));
      const inScope = input.scope !== 'source' || source.id === input.scopeRef;
      const provider = getProvider(source.providerId);

      // The simulated post-run entry set for this source (SubscriptionEntry[]).
      let simulated: SubscriptionEntry[];
      let previewable = true;
      if (inScope && source.enabled && provider.runtime === 'in_core') {
        // exactly what runDiscovery would persist: pure discover → validate → preserve numbering.
        const ctx = buildContext(source, provider.stateNamespace, input.db);
        const discovered = await provider.discover(ctx);
        const validated = discovered.map((e) => subscriptionEntrySchema.parse(e));
        const published = await loadPublishedNumbering(source.id, input.db);
        simulated = preservePublishedNumbering(validated, published);
      } else {
        // out_of_process at dispatch, out-of-scope, or disabled → the ledger is unchanged.
        simulated = currentRows.map(rowToEntry);
        if (inScope && source.enabled && provider.runtime !== 'in_core') {
          previewable = false;
          warnings.push(
            `${source.providerId}:${source.ref} is out_of_process — preview shows the current ledger; ` +
              `new classes need a real scrape (run it for real to discover them).`,
          );
        }
      }

      // diff current vs simulated by entryKey.
      const simKeys = new Set(simulated.map((e) => e.entryKey));
      let added = 0;
      let unchanged = 0;
      for (const k of simKeys) {
        if (currentKeys.has(k)) unchanged += 1;
        else added += 1;
      }
      let removed = 0;
      for (const k of currentKeys) if (!simKeys.has(k)) removed += 1;
      diffs.push({
        sourceId: source.id,
        providerId: source.providerId,
        displayName: source.displayName,
        ref: source.ref,
        previewable,
        added,
        removed,
        unchanged,
      });

      // contribute to the library recompose — enabled sources only (mirrors recomposeLibrary).
      if (!source.enabled) continue;
      const windowed = provider.emitWindow === true;
      for (const entry of simulated) {
        libraryEntries.push(entry);
        if (!windowMeta.has(entry.entryKey)) {
          windowMeta.set(entry.entryKey, {
            // preserve first-seen for an existing entry; a genuinely-new entry starts now (moot for
            // unwindowed providers, which always emit regardless of first-seen).
            firstSeenAt: firstSeenByKey.get(entry.entryKey) ?? input.now ?? new Date(),
            windowed,
          });
        }
      }
    }

    const composed = composeAndEmit(
      {
        presetName: library.presetName,
        workingDirectory: library.workingDirectory,
        emitPolicy: library.emitPolicy,
        libraryKind: library.libraryKind,
      },
      libraryEntries,
      windowMeta,
      emitWindowDays,
    );
    libraries.push({
      libraryId: library.id,
      library: library.name,
      configYaml: composed.emitted.configYaml,
      subscriptionsYaml: composed.emitted.subscriptionsYaml,
      emitted: composed.emittedEntries.length,
      deduped: composed.dedupedCount,
      windowedOut: composed.windowedOutCount,
      sources: diffs,
    });
  }

  return { libraries, warnings };
}
