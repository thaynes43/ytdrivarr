import { describe, expect, it } from 'vitest';
import { validateProvider } from '../../contracts';
import { assertValidRegistry, getProvider, loadRegistry } from '../../core/registry';
import { fakeContext } from '../../testing/context';
import {
  DEFAULT_MAX_CLASSES_PER_ACTIVITY,
  effectivePelotonCap,
  pelotonProvider,
  pelotonSettingsSchema,
  PELOTON_CREDENTIAL_REFRESH_SEC,
} from './index';
import {
  parseDurationMinutes,
  extractClassId,
  playerUrl,
  episodeNumberingFromEntries,
  nextEpisodeNumber,
} from './numbering';
import {
  activityFolderName,
  mapActivityName,
  buildTvShowDirectory,
  buildChip,
  parseChip,
  DEFAULT_ACTIVITIES,
} from './folder-mapping';

/**
 * The Peloton provider unit surface (DESIGN-045 D-04/D-06) — the contract conformance + the ported
 * numbering/folder rules. The deep parity/property suites are a second agent's; these lock the
 * ported RULES + the negation contract.
 */
describe('pelotonProvider — C1 contract', () => {
  it('passes validateProvider and loads in the registry', () => {
    expect(() => validateProvider(pelotonProvider)).not.toThrow();
    expect(() => loadRegistry()).not.toThrow();
    expect(getProvider('peloton').id).toBe('peloton');
  });

  it('declares the full capability spread with all its hooks (negation both directions)', () => {
    expect(pelotonProvider.capabilities).toEqual([
      'auth',
      'scrape',
      'tokenMint',
      'assets',
      'remediation',
    ]);
    expect(pelotonProvider.runtime).toBe('out_of_process');
    expect(typeof pelotonProvider.authenticate).toBe('function');
    expect(typeof pelotonProvider.remediate).toBe('function');
    expect(typeof pelotonProvider.describeAssets).toBe('function');
    expect(pelotonProvider.scheduling).toMatchObject({
      mode: 'cron',
      credentialRefreshSec: PELOTON_CREDENTIAL_REFRESH_SEC,
    });
  });

  it('registry still validates as a whole', () => {
    expect(() => assertValidRegistry([pelotonProvider])).not.toThrow();
  });

  it('discover() refuses to run in-core (out_of_process guard)', async () => {
    await expect(pelotonProvider.discover(fakeContext())).rejects.toThrow(/out_of_process/);
  });

  it('test() errors without credentials, warns with creds but no session', async () => {
    const noCreds = await pelotonProvider.test(fakeContext());
    expect(noCreds.status).toBe('error');
    const withCreds = await pelotonProvider.test(
      fakeContext({ secrets: { PELOTON_USERNAME: 'u', PELOTON_PASSWORD: 'p' } }),
    );
    expect(withCreds.status).toBe('warn'); // creds present, no session minted yet
  });

  it('per-activity settings default to the estate scrape profile; the cap tracks the global default', () => {
    const parsed = pelotonSettingsSchema.parse({});
    // No override → the source tracks the GLOBAL default (the owner's caps model).
    expect(parsed.maxClassesPerActivity).toBeUndefined();
    expect(effectivePelotonCap(parsed)).toBe(DEFAULT_MAX_CLASSES_PER_ACTIVITY);
    expect(effectivePelotonCap({ maxClassesPerActivity: 50 })).toBe(50);
    expect(parsed.dynamicScrolling).toBe(true);
    expect(parsed.maxScrolls).toBe(250);
  });
});

describe('numbering — RAW duration + PER-ACTIVITY per-duration + classId', () => {
  it('parses RAW duration minutes (no round-to-5)', () => {
    expect(parseDurationMinutes('30 min HIIT Cardio with Rad Lopez')).toBe(30);
    expect(parseDurationMinutes('45 min Tread Bootcamp')).toBe(45);
    expect(parseDurationMinutes('  5 MIN Meditation')).toBe(5);
    expect(parseDurationMinutes('Recovery 22 something')).toBe(22); // fallback, NOT rounded to 20
    expect(parseDurationMinutes('no number here')).toBe(0);
  });

  it('extracts the classId from both URL forms, stripping query/hash', () => {
    expect(
      extractClassId(
        'https://members.onepeloton.com/classes/player/c7fee9be57994db3808cf318d00cb732',
      ),
    ).toBe('c7fee9be57994db3808cf318d00cb732');
    expect(extractClassId('https://members.onepeloton.com/classes/player/abc123?foo=1#frag')).toBe(
      'abc123',
    );
    expect(extractClassId('https://x/classes/all?classId=def456&sort=1')).toBe('def456');
    expect(extractClassId('https://members.onepeloton.com/nope')).toBeUndefined();
    expect(playerUrl('abc')).toBe('https://members.onepeloton.com/classes/player/abc');
  });

  it('seeds PER-ACTIVITY per-duration numbering = max episode for each activity at each duration', () => {
    // season 30 spans multiple activities as DISJOINT bands (Cardio E222, Bike Bootcamp E730,
    // Cycling E2150) — impossible under one shared duration counter; each activity keeps its own.
    const seed = episodeNumberingFromEntries([
      { chip: 'Cardio (30 min)', seasonNumber: 30, episodeNumber: 222 },
      { chip: 'Bike Bootcamp (30 min)', seasonNumber: 30, episodeNumber: 730 },
      { chip: 'Cycling (30 min)', seasonNumber: 30, episodeNumber: 2150 },
      { chip: 'Cycling (30 min)', seasonNumber: 30, episodeNumber: 2026 }, // lower → ignored
      { chip: 'Cycling (45 min)', seasonNumber: 45, episodeNumber: 536 },
      { chip: 'Cycling (45 min)', seasonNumber: 45, episodeNumber: 176 },
      { chip: 'Meditation (10 min)', seasonNumber: 10, episodeNumber: null }, // null → skipped
    ]);
    expect(seed).toEqual({
      cardio: { '30': 222 },
      bike_bootcamp: { '30': 730 },
      cycling: { '30': 2150, '45': 536 },
    });
  });

  it('continues EACH activity’s own sequence independently (per-activity pre-increment)', () => {
    const numbering = { cardio: { '30': 222 }, cycling: { '30': 2150 } };
    // same duration (30), two activities — each advances on ITS OWN band (the flat-model bug regressed).
    expect(nextEpisodeNumber(numbering, 'cardio', 30)).toBe(223);
    expect(nextEpisodeNumber(numbering, 'cycling', 30)).toBe(2151);
    expect(nextEpisodeNumber(numbering, 'cycling', 30)).toBe(2152);
    expect(nextEpisodeNumber(numbering, 'yoga', 20)).toBe(1); // unseen (activity,duration) starts at 1
  });
});

describe('folder-mapping — activity map, bootcamp specials, 50/50 inference', () => {
  it('maps activity slugs + display names to their folder name', () => {
    expect(activityFolderName('bike_bootcamp')).toBe('Bike Bootcamp');
    expect(activityFolderName('bootcamp')).toBe('Tread Bootcamp');
    expect(activityFolderName('row_bootcamp')).toBe('Row Bootcamp');
    expect(activityFolderName('cycling')).toBe('Cycling');
    expect(activityFolderName('Bike Bootcamp')).toBe('Bike Bootcamp');
  });

  it('resolves human forms + the 50/50 edge case to canonical slugs', () => {
    expect(mapActivityName('bike bootcamp')).toBe('bike_bootcamp');
    expect(mapActivityName('tread bootcamp')).toBe('bootcamp');
    expect(mapActivityName('row bootcamp')).toBe('row_bootcamp');
    expect(mapActivityName('30 min 50/50 bike bootcamp')).toBe('bike_bootcamp');
    expect(mapActivityName('50-50 row')).toBe('row_bootcamp');
    expect(mapActivityName('bootcamp 50 something')).toBe('bootcamp');
    expect(mapActivityName('totally unknown')).toBeUndefined();
  });

  it('builds tv_show_directory and the chip label like the donor', () => {
    expect(buildTvShowDirectory('/media/peloton', 'bike_bootcamp', 'Tunde Oyeneyin')).toBe(
      '/media/peloton/Bike Bootcamp/Tunde Oyeneyin',
    );
    expect(buildTvShowDirectory('/media/peloton/', 'cycling', 'Ally Love')).toBe(
      '/media/peloton/Cycling/Ally Love',
    );
    expect(buildChip('bike_bootcamp', 30)).toBe('Bike Bootcamp (30 min)');
  });

  it('parseChip inverts buildChip back to activity slug + duration', () => {
    expect(parseChip('Bike Bootcamp (30 min)')).toEqual({
      folderName: 'Bike Bootcamp',
      activity: 'bike_bootcamp',
      durationMinutes: 30,
    });
    expect(parseChip('Cycling (45 min)')).toMatchObject({
      activity: 'cycling',
      durationMinutes: 45,
    });
    expect(parseChip('not a chip')).toBeNull();
    expect(DEFAULT_ACTIVITIES).toHaveLength(12);
  });
});
