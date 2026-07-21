import type { SubscriptionEntry } from '../contracts';

/**
 * The donor-parity EMIT WINDOW (DESIGN-045 D-14; the M3 Q-03 donor audit) — a sliding stale-timeout
 * that bounds the emitted `subscriptions.yaml` WITHOUT touching the ledger.
 *
 * Ground truth is the donor's `subscription_history_manager.py`
 * (`thaynes43/ytdl-sub-config-manager`): it tracked every subscription's `date_added` (its
 * FIRST-SEEN time, stamped once) and a `timeout_days` (default 15). On each run an entry whose
 * `date_added < now - timeout_days` was STALE and dropped OUT of the emitted file — the
 * download-archive keeps already-done downloads done, the file just stops carrying stale entries.
 * That kept the file bounded (~238 entries live) and every downloader pass fast.
 *
 * ytdrivarr's equivalent of `date_added` is the row's `createdAt` (first-seen; `mergeEntriesForSource`
 * preserves it across re-reports — a re-aired class updates `updatedAt` only). Windowing is
 * EMISSION-ONLY: rows REMAIN in the DB (the ledger is permanent) and numbering stays immutable, so a
 * windowed-out class can never re-key when it is re-discovered — `loadPublishedNumbering` still
 * returns its number and `preservePublishedNumbering` re-stamps it.
 *
 * Scope is PER-PROVIDER: only entry-grain providers opt in (`SourceProvider.emitWindow`, e.g.
 * Peloton). Preset-driven URL providers (YouTube) are UNWINDOWED — ytdl-sub's own "Only Recent"
 * bounds them at download time, so their whole source list always emits.
 */

/** The env var that configures the window (days). Default 15; `0` = unbounded (append-only escape hatch). */
export const EMIT_WINDOW_DAYS_ENV = 'PELOTON_EMIT_WINDOW_DAYS';
/** The donor's `timeout_days` default — the owner-defaulted window. */
export const DEFAULT_EMIT_WINDOW_DAYS = 15;

const MS_PER_DAY = 86_400_000;

/**
 * Resolve the configured window (days) from a raw env string.
 * - unset / empty / non-numeric  → the default (15): the window is ON by default (the owner ruling).
 * - `0`                          → unbounded (append-only): the emit window is OFF, every entry emits.
 * - a positive integer           → that many days.
 * - a negative value             → clamped to 0 (unbounded); a negative window is nonsensical, and
 *   "never drop anything" is the safe reading of a mis-set value.
 */
export function resolveEmitWindowDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_EMIT_WINDOW_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_EMIT_WINDOW_DAYS;
  return Math.max(0, Math.floor(n));
}

/** Per-entry windowing facts, resolved from the entry's row + its source's provider. */
export interface EntryWindowMeta {
  /** the row's `createdAt` — the donor's `date_added` (first-seen, stamped once). */
  firstSeenAt: Date;
  /** whether the originating source's provider opts into the emit window (entry-grain, e.g. Peloton). */
  windowed: boolean;
}

export interface EmitWindowResult {
  /** the entries that survive the window, in the same order they arrived (post-dedup order preserved). */
  emitted: SubscriptionEntry[];
  /** how many windowed entries were dropped as stale (for the run's counts/telemetry). */
  dropped: number;
}

/**
 * Apply the emit window to an ALREADY-DEDUPED entry list. Dedup runs FIRST on purpose: title
 * collisions collapse to the FIRST-PUBLISHED (oldest) entry, so windowing only ever drops that
 * canonical survivor — it can never promote a newer re-air into an older class's slot (the re-key
 * the numbering guard forbids).
 *
 * An entry is emitted when ANY of these hold:
 *   - its provider is UNWINDOWED (YouTube/url-list always emit their full list); or
 *   - the window is unbounded (`windowDays <= 0`, the escape hatch); or
 *   - its first-seen is within the window (`firstSeenAt >= now - windowDays`, donor parity — an
 *     entry exactly AT the cutoff is kept, since the donor's staleness test is a strict `<`).
 *
 * `meta` is keyed by `entryKey`; a missing entry is treated as unwindowed (emitted) — we never drop
 * an entry we cannot date.
 */
export function applyEmitWindow(
  entries: SubscriptionEntry[],
  meta: ReadonlyMap<string, EntryWindowMeta>,
  windowDays: number,
  now: Date = new Date(),
): EmitWindowResult {
  if (windowDays <= 0) return { emitted: [...entries], dropped: 0 };
  const cutoffMs = now.getTime() - windowDays * MS_PER_DAY;
  const emitted: SubscriptionEntry[] = [];
  let dropped = 0;
  for (const entry of entries) {
    const m = meta.get(entry.entryKey);
    if (!m || !m.windowed || m.firstSeenAt.getTime() >= cutoffMs) {
      emitted.push(entry);
    } else {
      dropped += 1;
    }
  }
  return { emitted, dropped };
}
