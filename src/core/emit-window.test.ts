import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  applyEmitWindow,
  resolveEmitWindowDays,
  DEFAULT_EMIT_WINDOW_DAYS,
  type EntryWindowMeta,
} from './emit-window';
import {
  dedupEntries,
  dedupTitleCollisions,
  preservePublishedNumbering,
  type PublishedNumbering,
} from './dedup';
import { emitLibrary, type EmitLibrary } from './emitter';
import type { SubscriptionEntry } from '../contracts';

/**
 * The donor-parity EMIT WINDOW (DESIGN-045 D-14 / the M3 Q-03 donor audit). Ground truth is the
 * donor's `subscription_history_manager.py`: an entry whose first-seen (`date_added`) is older than
 * `timeout_days` (15) drops OUT of the emitted subscriptions.yaml — the download-archive keeps
 * downloads done, the file just stops carrying stale entries, staying bounded (~238 live). Here we
 * prove: window boundary (in/out by days), the numbering guard survives a windowed-out re-air, the
 * `0` escape hatch, YouTube (unwindowed) emission is untouched, and a live-scale (~1,037-entry)
 * ledger projects to donor-scale once windowed.
 */

const NOW = new Date('2026-07-21T12:00:00.000Z');
const DAY = 86_400_000;

function pel(
  key: string,
  opts: { chip?: string; title?: string; episode?: number } = {},
): SubscriptionEntry {
  return {
    entryKey: key,
    displayName: opts.title ?? key,
    downloadRef: `https://members.onepeloton.com/classes/player/${key}`,
    preset: 'Plex TV Show by Date',
    ...(opts.chip ? { chip: opts.chip } : {}),
    ...(opts.episode !== undefined
      ? { overrides: { season_number: 30, episode_number: opts.episode } }
      : {}),
  };
}

/** Build a first-seen map from ages-in-days (relative to NOW). `windowed` defaults to true (Peloton). */
function metaOf(specs: { entry: SubscriptionEntry; ageDays: number; windowed?: boolean }[]): {
  list: SubscriptionEntry[];
  map: Map<string, EntryWindowMeta>;
} {
  const map = new Map<string, EntryWindowMeta>();
  const list: SubscriptionEntry[] = [];
  for (const { entry, ageDays, windowed = true } of specs) {
    list.push(entry);
    map.set(entry.entryKey, { firstSeenAt: new Date(NOW.getTime() - ageDays * DAY), windowed });
  }
  return { list, map };
}

const PELOTON_LIB: EmitLibrary = {
  presetName: 'Plex TV Show by Date',
  workingDirectory: '/workdir/',
  emitPolicy: { overrides: { tv_show_directory: '/media/peloton' } },
  libraryKind: 'video',
};

/** Render entries through the real emitter and count the entries in the projected YAML. */
function projectedEntryCount(entries: SubscriptionEntry[]): number {
  const { subscriptionsYaml } = emitLibrary(PELOTON_LIB, entries);
  const doc = parse(subscriptionsYaml) as Record<string, unknown>;
  const block = doc['Plex TV Show by Date'] as Record<string, Record<string, unknown>>;
  return Object.values(block).reduce((n, group) => n + Object.keys(group).length, 0);
}

// --- resolveEmitWindowDays (the env parser; 0 = unbounded, default 15) --------------------------

describe('resolveEmitWindowDays', () => {
  it('defaults to 15 when unset, empty, or unparseable (the window is ON by default)', () => {
    expect(resolveEmitWindowDays(undefined)).toBe(DEFAULT_EMIT_WINDOW_DAYS);
    expect(resolveEmitWindowDays('')).toBe(15);
    expect(resolveEmitWindowDays('   ')).toBe(15);
    expect(resolveEmitWindowDays('not-a-number')).toBe(15);
  });

  it('treats 0 as unbounded (the append-only escape hatch) and clamps negatives to 0', () => {
    expect(resolveEmitWindowDays('0')).toBe(0);
    expect(resolveEmitWindowDays('-3')).toBe(0);
  });

  it('honours an explicit positive window (floored to whole days)', () => {
    expect(resolveEmitWindowDays('15')).toBe(15);
    expect(resolveEmitWindowDays('30')).toBe(30);
    expect(resolveEmitWindowDays('7.9')).toBe(7);
  });
});

// --- window boundary (in / out by days) ---------------------------------------------------------

describe('applyEmitWindow — window boundary (donor parity: stale = first-seen < now - windowDays)', () => {
  it('keeps in-window entries, drops those older than the window', () => {
    const { list, map } = metaOf([
      { entry: pel('fresh'), ageDays: 14 },
      { entry: pel('stale'), ageDays: 16 },
    ]);
    const { emitted, dropped } = applyEmitWindow(list, map, 15, NOW);
    expect(emitted.map((e) => e.entryKey)).toEqual(['fresh']);
    expect(dropped).toBe(1);
  });

  it('keeps an entry sitting EXACTLY on the cutoff (>= is inclusive, matching the donor strict <)', () => {
    // firstSeenAt === now - 15d === cutoff → kept; one millisecond older → dropped.
    const onCutoff = pel('on-cutoff');
    const justOver = pel('just-over');
    const map = new Map<string, EntryWindowMeta>([
      ['on-cutoff', { firstSeenAt: new Date(NOW.getTime() - 15 * DAY), windowed: true }],
      ['just-over', { firstSeenAt: new Date(NOW.getTime() - 15 * DAY - 1), windowed: true }],
    ]);
    const { emitted, dropped } = applyEmitWindow([onCutoff, justOver], map, 15, NOW);
    expect(emitted.map((e) => e.entryKey)).toEqual(['on-cutoff']);
    expect(dropped).toBe(1);
  });

  it('preserves post-dedup order among survivors', () => {
    const { list, map } = metaOf([
      { entry: pel('a'), ageDays: 1 },
      { entry: pel('old'), ageDays: 40 },
      { entry: pel('b'), ageDays: 2 },
    ]);
    const { emitted } = applyEmitWindow(list, map, 15, NOW);
    expect(emitted.map((e) => e.entryKey)).toEqual(['a', 'b']);
  });
});

// --- the 0 escape hatch (unbounded / append-only) -----------------------------------------------

describe('applyEmitWindow — the 0 escape hatch (unbounded / append-only)', () => {
  it('emits every entry regardless of age when windowDays is 0', () => {
    const { list, map } = metaOf([
      { entry: pel('ancient'), ageDays: 400 },
      { entry: pel('old'), ageDays: 100 },
      { entry: pel('fresh'), ageDays: 1 },
    ]);
    const { emitted, dropped } = applyEmitWindow(list, map, 0, NOW);
    expect(emitted).toHaveLength(3);
    expect(dropped).toBe(0);
  });
});

// --- YouTube (unwindowed provider) emission is untouched, per-provider scoping -------------------

describe('applyEmitWindow — YouTube emission untouched (per-provider scoping)', () => {
  it('never drops entries whose provider does not opt into the window, however old', () => {
    const { list, map } = metaOf([
      { entry: pel('yt-old'), ageDays: 365, windowed: false },
      { entry: pel('yt-ancient'), ageDays: 999, windowed: false },
    ]);
    const { emitted, dropped } = applyEmitWindow(list, map, 15, NOW);
    expect(emitted).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it('windows ONLY the opted-in entries in a mixed set (Peloton dropped, YouTube kept)', () => {
    const { list, map } = metaOf([
      { entry: pel('peloton-stale'), ageDays: 100, windowed: true },
      { entry: pel('youtube-stale'), ageDays: 100, windowed: false },
    ]);
    const { emitted, dropped } = applyEmitWindow(list, map, 15, NOW);
    expect(emitted.map((e) => e.entryKey)).toEqual(['youtube-stale']);
    expect(dropped).toBe(1);
  });

  it('emits an entry with no first-seen meta (never drops what it cannot date)', () => {
    const orphan = pel('orphan');
    const { emitted, dropped } = applyEmitWindow([orphan], new Map(), 15, NOW);
    expect(emitted).toEqual([orphan]);
    expect(dropped).toBe(0);
  });
});

// --- numbering preserved for windowed-out entries (a re-aired class must NOT re-key) ------------

describe('windowing an entry OUT never re-keys a re-aired class (numbering immutable)', () => {
  it('drops the stale first-published title entirely — the fresh re-air is not promoted into its slot', () => {
    // The ledger holds the first-published class (episode 730, first-seen 40d ago → stale) AND a
    // re-air under the identical (chip, title) with a NEW class id + higher episode (first-seen 2d).
    const first = pel('classfirst', {
      chip: 'Cycling (30 min)',
      title: 'Classic Rock Ride',
      episode: 730,
    });
    const reAir = pel('classreair', {
      chip: 'Cycling (30 min)',
      title: 'Classic Rock Ride',
      episode: 731,
    });

    // dedup binds the title to the FIRST-PUBLISHED (lowest episode) entry; the re-air is dropped here.
    const deduped = dedupTitleCollisions(dedupEntries([first, reAir]));
    expect(deduped).toEqual([first]);

    const map = new Map<string, EntryWindowMeta>([
      ['classfirst', { firstSeenAt: new Date(NOW.getTime() - 40 * DAY), windowed: true }],
      ['classreair', { firstSeenAt: new Date(NOW.getTime() - 2 * DAY), windowed: true }],
    ]);
    const { emitted } = applyEmitWindow(deduped, map, 15, NOW);

    // The stale survivor is windowed out; the re-air (episode 731) is NOT emitted in its place.
    expect(emitted).toEqual([]);
    const doc = parse(emitLibrary(PELOTON_LIB, emitted).subscriptionsYaml) as Record<
      string,
      unknown
    >;
    const block = doc['Plex TV Show by Date'] as
      Record<string, Record<string, unknown>> | undefined;
    expect(block?.['= Cycling (30 min)']?.['Classic Rock Ride']).toBeUndefined();
  });

  it('a windowed-out class keeps its immutable numbering on re-discovery (ledger untouched)', () => {
    // Windowing is emission-only: the DB row + its published numbering survive, so when the class is
    // re-discovered (same entryKey) preservePublishedNumbering re-stamps the ORIGINAL number — never
    // the re-report's new one — exactly as if it had never left the file.
    const published = new Map<string, PublishedNumbering>([
      ['classfirst', { season: 30, episode: 730 }],
    ]);
    const reDiscovered = pel('classfirst', {
      chip: 'Cycling (30 min)',
      title: 'Classic Rock Ride',
      episode: 99999, // a bogus re-report number that must be ignored
    });
    const restamped = preservePublishedNumbering([reDiscovered], published);
    expect(restamped[0]?.overrides?.episode_number).toBe(730);
    expect(restamped[0]?.overrides?.season_number).toBe(30);
  });
});

// --- projected-file size assertion against the live-scale (~1,037-entry) ledger -----------------

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../testing/fixtures/estate-peloton-subscriptions.yaml', import.meta.url)),
  'utf8',
);

/** Parse the estate live file into SubscriptionEntry[] (the real ~229 donor-scale recent set). */
function entriesFromFixture(yamlStr: string): SubscriptionEntry[] {
  const doc = parse(yamlStr) as Record<string, unknown>;
  const block = doc['Plex TV Show by Date'] as Record<
    string,
    Record<string, { download: string; overrides?: Record<string, unknown> }>
  >;
  const out: SubscriptionEntry[] = [];
  for (const [chipKey, group] of Object.entries(block)) {
    const chip = chipKey.replace(/^=\s*/, '');
    for (const [title, value] of Object.entries(group)) {
      const classId = value.download.split('/classes/player/')[1] ?? value.download;
      out.push({
        entryKey: classId,
        displayName: title,
        downloadRef: value.download,
        preset: 'Plex TV Show by Date',
        chip,
        ...(value.overrides ? { overrides: value.overrides } : {}),
      });
    }
  }
  return out;
}

describe('live-scale ledger — a ~1,037-entry file projects to donor-scale once windowed', () => {
  const recent = entriesFromFixture(FIXTURE); // the real 229-entry estate file (donor-scale)
  const staleCount = 808;
  const stale = Array.from({ length: staleCount }, (_, i) =>
    pel(`stale${i.toString().padStart(4, '0')}`, {
      chip: `Stale Activity ${i % 12} (${(i % 6) * 5 + 5} min)`,
      title: `Stale Class ${i}`,
      episode: i,
    }),
  );
  const ledger = [...recent, ...stale];

  const map = new Map<string, EntryWindowMeta>();
  for (const e of recent)
    map.set(e.entryKey, { firstSeenAt: new Date(NOW.getTime() - 5 * DAY), windowed: true });
  for (const e of stale)
    map.set(e.entryKey, { firstSeenAt: new Date(NOW.getTime() - 30 * DAY), windowed: true });

  it('the fixture yields the real 229 donor-scale entries', () => {
    expect(recent).toHaveLength(229);
  });

  it("the unbounded (0) ledger projects the FULL ~1,037 entries (append-only, today's unbounded growth)", () => {
    const deduped = dedupTitleCollisions(dedupEntries(ledger));
    expect(deduped).toHaveLength(1037);
    const { emitted, dropped } = applyEmitWindow(deduped, map, 0, NOW);
    expect(dropped).toBe(0);
    expect(projectedEntryCount(emitted)).toBe(1037);
  });

  it('windowed (15d) it shrinks to the 229 donor-scale recent set (808 stale dropped)', () => {
    const deduped = dedupTitleCollisions(dedupEntries(ledger));
    const { emitted, dropped } = applyEmitWindow(deduped, map, 15, NOW);
    expect(dropped).toBe(staleCount);
    expect(projectedEntryCount(emitted)).toBe(229);
    // and the projected file is bounded near the donor's ~238 live-file ceiling.
    expect(projectedEntryCount(emitted)).toBeLessThan(250);
  });
});
