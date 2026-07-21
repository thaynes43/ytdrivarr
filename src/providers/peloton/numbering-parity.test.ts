import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootTestDb, type TestDb } from '../../testing/db';
import { createLibrary } from '../../domain/libraries';
import { createSource } from '../../domain/sources';
import { startRun } from '../../domain/runs';
import { mergeEntriesForSource } from '../../domain/entries';
import { buildDiscoveryPayload } from '../../core/jobs';
import type { SubscriptionEntry } from '../../contracts';
import {
  episodeNumberingFromEntries,
  mergeNumbering,
  nextEpisodeNumber,
  parseDurationMinutes,
  type NestedNumbering,
} from './numbering';
import { episodesFromDisk } from './episodes-from-disk';
import {
  activityFolderName,
  activitySlugFromChip,
  mapActivityName,
  parseChip,
} from './folder-mapping';

/**
 * DEEP PARITY — numbering (owner mandate: "test the shit out of Peloton"). Locks the CORRECTED
 * per-(activity, duration) numbering contract (donor `application.py` 341-347 + `ActivityData`) and
 * the ported disk scan (`episodes_from_disk.py`). The flat global-per-duration model this replaces
 * was the bug: two activities at the same duration must keep DISJOINT episode bands.
 *
 * Layout: pure-model + disk-scan tests need no DB; the `buildDiscoveryPayload` integration boots one
 * embedded Postgres (the real seed builder, incl. the disk ⊔ subscriptions merge).
 */

// --- Mission 3.3(a) pure: episodeNumberingFromEntries nested maxima -----------------------------

describe('episodeNumberingFromEntries — per-(activity, duration) maxima', () => {
  it('nests each activity’s own per-duration max; ignores lower + null numbering', () => {
    const seed = episodeNumberingFromEntries([
      { chip: 'Cardio (30 min)', seasonNumber: 30, episodeNumber: 221 },
      { chip: 'Cardio (30 min)', seasonNumber: 30, episodeNumber: 222 }, // higher wins
      { chip: 'Cardio (30 min)', seasonNumber: 30, episodeNumber: 100 }, // lower ignored
      { chip: 'Cycling (30 min)', seasonNumber: 30, episodeNumber: 2150 },
      { chip: 'Cycling (45 min)', seasonNumber: 45, episodeNumber: 176 },
      { chip: 'Bike Bootcamp (30 min)', seasonNumber: 30, episodeNumber: 730 },
      { chip: 'Tread Bootcamp (45 min)', seasonNumber: 45, episodeNumber: 485 },
      { chip: 'Meditation (5 min)', seasonNumber: 5, episodeNumber: null }, // null → dropped
      { chip: null, seasonNumber: 30, episodeNumber: 9 }, // no chip → no activity → dropped
    ]);
    expect(seed).toEqual({
      cardio: { '30': 222 },
      cycling: { '30': 2150, '45': 176 },
      bike_bootcamp: { '30': 730 },
      bootcamp: { '45': 485 },
    });
  });

  it('the live estate bands stay disjoint — season 30 is NOT one shared counter', () => {
    // The exact live-file collision the flat model got wrong: Cardio E222 vs Cycling E2150 at S30.
    const seed = episodeNumberingFromEntries([
      { chip: 'Cardio (30 min)', seasonNumber: 30, episodeNumber: 222 },
      { chip: 'Cycling (30 min)', seasonNumber: 30, episodeNumber: 2150 },
    ]);
    expect(seed.cardio!['30']).toBe(222);
    expect(seed.cycling!['30']).toBe(2150);
    expect(seed.cardio!['30']).not.toBe(seed.cycling!['30']);
  });
});

// --- Mission 3.3(b) PER-ACTIVITY INDEPENDENCE (the flat-model regression test) ------------------

describe('per-activity independence — the flat-model regression', () => {
  it('a report adding classes for two activities at the same duration continues EACH sequence', () => {
    // seed = the persisted maxima; a worker report mints the next numbers per activity.
    const numbering: NestedNumbering = episodeNumberingFromEntries([
      { chip: 'Cardio (30 min)', seasonNumber: 30, episodeNumber: 222 },
      { chip: 'Cycling (30 min)', seasonNumber: 30, episodeNumber: 2150 },
    ]);
    // Two NEW classes at the SAME duration (30) but different activities.
    const cardioNext = nextEpisodeNumber(numbering, 'cardio', 30); // continues cardio's band
    const cyclingNext = nextEpisodeNumber(numbering, 'cycling', 30); // continues cycling's band
    expect(cardioNext).toBe(223);
    expect(cyclingNext).toBe(2151);
    // A flat global-per-duration counter would have made BOTH 2151 (or both 223) — the bug.
    expect(cardioNext).not.toBe(cyclingNext);
    // and each advances again independently
    expect(nextEpisodeNumber(numbering, 'cardio', 30)).toBe(224);
    expect(nextEpisodeNumber(numbering, 'cycling', 30)).toBe(2152);
    // an unseen (activity, duration) starts at 1
    expect(nextEpisodeNumber(numbering, 'yoga', 20)).toBe(1);
  });
});

// --- Mission 3.3(d) merge (disk ⊔ subs) takes the max per key -----------------------------------

describe('mergeNumbering — max per (activity, duration) key', () => {
  it('takes the larger episode when both sides carry a key; keeps disjoint keys from either side', () => {
    const subs: NestedNumbering = {
      cycling: { '30': 800, '45': 100 }, // 45 is subs-only (disjoint)
      yoga: { '10': 50 }, // subs higher than disk
    };
    const disk: NestedNumbering = {
      cycling: { '30': 900 }, // disk higher
      yoga: { '10': 3 }, // disk lower
      cardio: { '20': 5 }, // disk-only (disjoint)
    };
    expect(mergeNumbering(subs, disk)).toEqual({
      cycling: { '30': 900, '45': 100 },
      yoga: { '10': 50 },
      cardio: { '20': 5 },
    });
  });

  it('does not mutate either input', () => {
    const a: NestedNumbering = { cycling: { '30': 1 } };
    const b: NestedNumbering = { cycling: { '30': 2 } };
    mergeNumbering(a, b);
    expect(a).toEqual({ cycling: { '30': 1 } });
    expect(b).toEqual({ cycling: { '30': 2 } });
  });
});

// --- Mission 3.3(e) duration parsing — RAW, NEVER rounded --------------------------------------

describe('parseDurationMinutes — RAW minutes, never round-to-5', () => {
  it('parses the leading `N min`, falls back to the first int, else 0', () => {
    expect(parseDurationMinutes('45 min Power Zone Ride')).toBe(45);
    expect(parseDurationMinutes('5 min Cool Down Walk')).toBe(5);
    expect(parseDurationMinutes('75 min Power Zone Endurance Ride')).toBe(75);
    // no `min` → first int anywhere
    expect(parseDurationMinutes('Encore Ride 22 with Cody')).toBe(22);
    // no int at all → 0
    expect(parseDurationMinutes('Just a Meditation')).toBe(0);
  });

  it('NEVER rounds to a multiple of 5 (the donor round-to-5 must not resurface)', () => {
    expect(parseDurationMinutes('35 min Yoga Flow')).toBe(35); // stays 35, not 35→35 by luck: check 22/33
    expect(parseDurationMinutes('22 min Core')).toBe(22); // stays 22, NOT 20
    expect(parseDurationMinutes('33 min Ride')).toBe(33); // stays 33, NOT 35
    expect(parseDurationMinutes('Recovery 22 something')).toBe(22); // fallback path, still 22
  });
});

// --- Mission 3.3(f) bootcamp chip/folder mapping + 50/50 inference ------------------------------

describe('bootcamp mapping + 50/50 inference (activity_based_path_strategy)', () => {
  it('maps the bootcamp specials both directions', () => {
    expect(mapActivityName('tread bootcamp')).toBe('bootcamp');
    expect(mapActivityName('bike bootcamp')).toBe('bike_bootcamp');
    expect(mapActivityName('row bootcamp')).toBe('row_bootcamp');
    expect(activityFolderName('bootcamp')).toBe('Tread Bootcamp');
    expect(activityFolderName('bike_bootcamp')).toBe('Bike Bootcamp');
    expect(activityFolderName('row_bootcamp')).toBe('Row Bootcamp');
  });

  it('parses bootcamp chips to their slug (Tread Bootcamp ↔ bootcamp)', () => {
    expect(parseChip('Tread Bootcamp (30 min)')?.activity).toBe('bootcamp');
    expect(activitySlugFromChip('Bike Bootcamp (45 min)')).toBe('bike_bootcamp');
    expect(activitySlugFromChip('Row Bootcamp (30 min)')).toBe('row_bootcamp');
    expect(activitySlugFromChip('Cycling (30 min)')).toBe('cycling');
    expect(activitySlugFromChip(null)).toBeUndefined();
    expect(activitySlugFromChip('not a chip')).toBeUndefined();
  });

  it('infers the discipline from a 50/50 folder name', () => {
    expect(mapActivityName('Bootcamp 50/50')).toBe('bootcamp'); // tread
    expect(mapActivityName('Bike Bootcamp 50-50')).toBe('bike_bootcamp'); // bike
    expect(mapActivityName('Row Bootcamp 50/50')).toBe('row_bootcamp'); // row
  });
});

// --- Mission 2 disk scan — port of episodes_from_disk.py ---------------------------------------

describe('episodesFromDisk — leaf-folder scan, malformed skipped not crashed', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ytdrivarr-disk-'));
    const mk = async (rel: string, withFile = false): Promise<void> => {
      const dir = join(root, rel);
      await mkdir(dir, { recursive: true });
      // a real episode folder holds media FILES (not subdirs) so it stays a leaf; prove files are ok.
      if (withFile) await writeFile(join(dir, 'episode.info.json'), '{"id":"x"}', 'utf8');
    };
    // Cycling: two episodes at S30 (max wins) + one at S45.
    await mk('Cycling/Ally Love/S30E752 - 2026-01-01 - Foo', true);
    await mk('Cycling/Ally Love/S30E900 - 2026-01-02 - Bar');
    await mk('Cycling/Cody Rigsby/S45E100 - 2026-01-03 - Baz');
    // Tread Bootcamp folder → slug `bootcamp` (the special mapping).
    await mk('Tread Bootcamp/Robin Arzon/S30E10 - 2026-01-04 - Boot');
    // Unmappable activity → skipped.
    await mk('Not An Activity/Someone/S30E5 - 2026-01-05 - Nope');
    // Malformed leaf (no SxxExx) under a real activity → skipped, must NOT crash.
    await mk('Cardio/Emma Lovewell/malformed-no-season-marker');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns per-(activity, duration) maxima; Tread Bootcamp maps to bootcamp', () => {
    expect(episodesFromDisk(root)).toEqual({
      cycling: { '30': 900, '45': 100 },
      bootcamp: { '30': 10 },
    });
  });

  it('a missing scan root yields {} (never throws)', () => {
    expect(episodesFromDisk(join(root, 'does-not-exist'))).toEqual({});
  });
});

// --- Mission 3.3(a)+(d) integration: buildDiscoveryPayload builds the nested seed (embedded PG) --

describe('buildDiscoveryPayload — nested seed + disk merge (embedded PG)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootTestDb();
    process.env.DATABASE_URL = t.connectionString;
  });
  afterAll(async () => {
    await t.stop();
    delete process.env.DATABASE_URL;
  });

  function pentry(
    activity: string,
    folder: string,
    season: number,
    episode: number,
  ): SubscriptionEntry {
    const chip = `${folder} (${season} min)`;
    return {
      entryKey: `${activity}-${season}-${episode}`,
      displayName: `${season} min ${folder} ${episode}`,
      downloadRef: `https://members.onepeloton.com/classes/player/${activity}${season}${episode}`,
      preset: 'Plex TV Show by Date',
      chip,
      overrides: {
        tv_show_directory: `/media/peloton/${folder}/Someone`,
        season_number: season,
        episode_number: episode,
      },
    };
  }

  async function seed(settings: Record<string, unknown>): Promise<{
    srcId: string;
    runId: string;
    lib: Awaited<ReturnType<typeof createLibrary>>;
    src: Awaited<ReturnType<typeof createSource>>;
  }> {
    const lib = await createLibrary({
      name: `Peloton ${Math.random().toString(36).slice(2)}`,
      mediaRoot: '/media/peloton',
      libraryKind: 'video',
      presetName: 'Plex TV Show by Date',
      projectionPath: `peloton-${Math.random().toString(36).slice(2)}`,
      db: t.db,
    });
    const src = await createSource({
      libraryId: lib.id,
      providerId: 'peloton',
      kind: 'peloton-scraper',
      mediaKind: 'video',
      displayName: 'Peloton',
      ref: `peloton-${Math.random().toString(36).slice(2)}`,
      settings,
      db: t.db,
    });
    const run = await startRun({ scope: 'source', scopeRef: src.id, trigger: 'cron', db: t.db });
    return { srcId: src.id, runId: run.id, lib, src };
  }

  it('nests the seed by activity — mixed activities at the same duration stay separate', async () => {
    const { srcId, runId, lib, src } = await seed({
      activities: ['cycling', 'cardio', 'bike_bootcamp'],
      maxClassesPerActivity: 25,
    });
    await mergeEntriesForSource(
      srcId,
      [
        pentry('cardio', 'Cardio', 30, 221),
        pentry('cardio', 'Cardio', 30, 222), // higher → wins
        pentry('cycling', 'Cycling', 30, 2026),
        pentry('cycling', 'Cycling', 30, 2150), // higher → wins
        pentry('cycling', 'Cycling', 45, 176),
        pentry('bike', 'Bike Bootcamp', 30, 730),
      ],
      t.db,
    );
    const payload = await buildDiscoveryPayload({ runId, source: src, library: lib }, t.db);
    expect(payload.peloton.episodeNumbering).toEqual({
      cardio: { '30': 222 },
      cycling: { '30': 2150, '45': 176 },
      bike_bootcamp: { '30': 730 },
    });
  });

  it('folds a disk scan into the seed via diskScanPath (max per key)', async () => {
    const disk = await mkdtemp(join(tmpdir(), 'ytdrivarr-diskmerge-'));
    const mk = async (rel: string): Promise<void> => {
      await mkdir(join(disk, rel), { recursive: true });
    };
    await mk('Cycling/Ally Love/S30E900 - x - Foo'); // disk 900 > subs 800
    await mk('Yoga/Someone/S10E3 - x - Bar'); // disk 3 < subs 50
    await mk('Cardio/Emma/S20E5 - x - Baz'); // disk-only (disjoint)

    const { srcId, runId, lib, src } = await seed({
      activities: ['cycling', 'yoga', 'cardio'],
      maxClassesPerActivity: 25,
      diskScanPath: disk,
    });
    await mergeEntriesForSource(
      srcId,
      [
        pentry('cycling', 'Cycling', 30, 800), // disk wins (900)
        pentry('cycling', 'Cycling', 45, 100), // subs-only disjoint
        pentry('yoga', 'Yoga', 10, 50), // subs wins (50)
      ],
      t.db,
    );
    const payload = await buildDiscoveryPayload({ runId, source: src, library: lib }, t.db);
    expect(payload.peloton.episodeNumbering).toEqual({
      cycling: { '30': 900, '45': 100 },
      yoga: { '10': 50 },
      cardio: { '20': 5 },
    });

    await rm(disk, { recursive: true, force: true });
  });
});
