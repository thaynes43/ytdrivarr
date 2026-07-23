import { dedupEntries, dedupTitleCollisions } from './dedup';
import { applyEmitWindow, type EntryWindowMeta } from './emit-window';
import { emitLibrary, type EmitLibrary, type EmittedConfig } from './emitter';
import { getProvider } from './registry';
import { rowToEntry } from '../domain/entries';
import type { SubscriptionEntry } from '../contracts';
import type { SubscriptionEntryRow } from '../db/schema';

/**
 * Library recompose (DESIGN-045 D-13/D-14) — the PURE core shared by the discovery orchestrator
 * (`runDiscovery`) and the out-of-process report leg (`reportJob`). Given a Library's sources and
 * their entry ROWS, it recomposes the whole-library entry set (disabled sources excluded exactly as
 * unmonitoring removes them from the projection), applies cross-source dedup + the donor-parity emit
 * window, and renders `config.yaml` + `subscriptions.yaml`.
 *
 * It does NO IO: it neither reads the DB nor writes the volume. The caller supplies the rows (real,
 * or — for the dry-run/preview path — simulated) and projects the returned `emitted`. That parameter
 * boundary is deliberate: recompose must never re-read the ledger, or a preview would silently emit
 * the pre-run state.
 */

/** One Library source paired with its persisted (or simulated) entry rows. */
export interface RecomposeSource {
  providerId: string;
  enabled: boolean;
  rows: SubscriptionEntryRow[];
}

export interface RecomposedLibrary {
  /** the rendered config.yaml + subscriptions.yaml — NOT yet written; the caller projects it. */
  emitted: EmittedConfig;
  /** the windowed entry set that made it into the emitted subscriptions.yaml. */
  emittedEntries: SubscriptionEntry[];
  /** entries removed by cross-source dedup + title-collision guards. */
  dedupedCount: number;
  /** entries dropped from the emitted file by the emit window (their ledger rows stay). */
  windowedOutCount: number;
}

export function recomposeLibrary(
  library: EmitLibrary,
  sources: RecomposeSource[],
  emitWindowDays: number,
): RecomposedLibrary {
  const libraryEntries: SubscriptionEntry[] = [];
  const windowMeta = new Map<string, EntryWindowMeta>();
  for (const source of sources) {
    if (!source.enabled) continue;
    const windowed = getProvider(source.providerId).emitWindow === true;
    for (const row of source.rows) {
      libraryEntries.push(rowToEntry(row));
      if (!windowMeta.has(row.entryKey)) {
        windowMeta.set(row.entryKey, { firstSeenAt: row.createdAt, windowed });
      }
    }
  }
  return composeAndEmit(library, libraryEntries, windowMeta, emitWindowDays);
}

/**
 * The PURE dedup → emit-window → render tail, over an ALREADY-ASSEMBLED library entry set + its
 * per-entry window metadata. `recomposeLibrary` builds those from persisted rows; the dry-run
 * preview builds them from a SIMULATED entry set (never touching the DB) and calls this directly —
 * so the two share the exact dedup/window/emit semantics without preview having to fake DB rows.
 */
export function composeAndEmit(
  library: EmitLibrary,
  libraryEntries: SubscriptionEntry[],
  windowMeta: ReadonlyMap<string, EntryWindowMeta>,
  emitWindowDays: number,
): RecomposedLibrary {
  const deduped = dedupTitleCollisions(dedupEntries(libraryEntries));
  const windowed = applyEmitWindow(deduped, windowMeta, emitWindowDays);
  const emitted = emitLibrary(library, windowed.emitted);
  return {
    emitted,
    emittedEntries: windowed.emitted,
    dedupedCount: libraryEntries.length - deduped.length,
    windowedOutCount: windowed.dropped,
  };
}
