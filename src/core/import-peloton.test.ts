import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { bootTestDb, type TestDb } from '../testing/db';
import { emitLibrary } from './emitter';
import {
  parsePelotonSubscriptions,
  applyPelotonImport,
  PELOTON_MEDIA_ROOT,
} from './import-peloton';
import { getLibrary } from '../domain/libraries';
import { listSources } from '../domain/sources';
import { listEntriesForSource } from '../domain/entries';
import type { SubscriptionEntry } from '../contracts';

const fixture = readFileSync(
  fileURLToPath(new URL('../testing/fixtures/estate-peloton-subscriptions.yaml', import.meta.url)),
  'utf8',
);

describe('parsePelotonSubscriptions — the estate live file', () => {
  const parsed = parsePelotonSubscriptions(fixture);

  it('reads the single preset + the __preset__ policy verbatim', () => {
    expect(parsed.presetName).toBe('Plex TV Show by Date');
    const overrides = (parsed.preset.overrides ?? {}) as Record<string, unknown>;
    expect(overrides.tv_show_directory).toBe('/media/peloton');
    const ytdl = (parsed.preset.ytdl_options ?? {}) as Record<string, unknown>;
    expect(ytdl.cookiefile).toBe('/media/peloton/cookies.txt');
  });

  it('captures every class as an entry (classId from the player URL, season/episode preserved)', () => {
    expect(parsed.entries.length).toBeGreaterThan(220);
    const withTunde = parsed.entries.find((e) => e.displayName.includes('Tunde Oyeneyin'));
    expect(withTunde?.classId).toMatch(/^[a-f0-9]{6,}$/);
    expect(withTunde?.seasonNumber).toBeGreaterThan(0);
    // GLOBAL-per-duration proof: season 30 spans a wide episode range across activities.
    const s30 = parsed.entries.filter((e) => e.seasonNumber === 30).map((e) => e.episodeNumber);
    expect(Math.max(...s30) - Math.min(...s30)).toBeGreaterThan(500);
  });
});

describe('applyPelotonImport — idempotent seed + round-trip', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootTestDb();
    process.env.DATABASE_URL = t.connectionString;
  });
  afterAll(async () => {
    await t.stop();
    delete process.env.DATABASE_URL;
  });

  it('creates the Library + one PER-ACTIVITY Source per discipline + all entries on first import', async () => {
    const parsed = parsePelotonSubscriptions(fixture);
    const summary = await applyPelotonImport(parsed, { apiKeyId: 'test', db: t.db });

    expect(summary.libraryAction).toBe('created');
    expect(summary.sources.map((s) => s.ref).sort()).toEqual([...parsed.activities].sort());
    expect(summary.sources.every((s) => s.action === 'created')).toBe(true);
    expect(summary.entriesAdded).toBe(parsed.entries.length);
    expect(summary.entriesUpdated).toBe(0);

    const lib = await getLibrary(summary.libraryId, t.db);
    expect(lib?.mediaRoot).toBe(PELOTON_MEDIA_ROOT);
    expect(lib?.emitPolicy).toEqual(parsed.preset);

    const sources = await listSources(t.db);
    const pelotonSources = sources.filter((s) => s.providerId === 'peloton');
    expect(pelotonSources).toHaveLength(parsed.activities.length);
    // Watch-grain shape: ref = the slug, display = the folder name, settings empty (cap tracks
    // the global default until an operator pins an override).
    const bootcamp = pelotonSources.find((s) => s.ref === 'bootcamp');
    expect(bootcamp?.displayName).toBe('Tread Bootcamp');
    expect(bootcamp?.settings).toEqual({});
    // Every entry landed on ITS activity's source (attribution by chip).
    let total = 0;
    for (const s of summary.sources) {
      const rows = await listEntriesForSource(s.id, t.db);
      expect(rows).toHaveLength(s.entries);
      expect(rows).toHaveLength(parsed.entries.filter((e) => e.activity === s.ref).length);
      total += rows.length;
    }
    expect(total).toBe(parsed.entries.length);
  });

  it('is idempotent — a re-import creates no new rows and never clobbers operator state', async () => {
    const parsed = parsePelotonSubscriptions(fixture);
    const summary = await applyPelotonImport(parsed, { apiKeyId: 'test', db: t.db });
    expect(summary.libraryAction).toBe('updated');
    expect(summary.sources.every((s) => s.action === 'unchanged')).toBe(true);
    expect(summary.entriesAdded).toBe(0);
    expect(summary.entriesUpdated).toBe(parsed.entries.length);

    const sources = await listSources(t.db);
    expect(sources.filter((s) => s.providerId === 'peloton')).toHaveLength(
      parsed.activities.length,
    );
  });

  it('round-trips: emitting the seeded library reproduces the live file structure', async () => {
    const sources = await listSources(t.db);
    const pelotonSources = sources.filter((s) => s.providerId === 'peloton');
    const lib = await getLibrary(pelotonSources[0]!.libraryId, t.db);
    const rows = [];
    for (const s of pelotonSources) {
      rows.push(...(await listEntriesForSource(s.id, t.db)));
    }

    const entries: SubscriptionEntry[] = rows.map((r) => {
      const e: SubscriptionEntry = {
        entryKey: r.entryKey,
        displayName: r.displayName,
        downloadRef: r.downloadRef,
        preset: r.preset,
      };
      if (r.chip !== null) e.chip = r.chip;
      if (r.overrides !== null) e.overrides = r.overrides;
      return e;
    });

    const emitted = emitLibrary(
      {
        presetName: lib!.presetName,
        workingDirectory: lib!.workingDirectory,
        emitPolicy: lib!.emitPolicy,
        libraryKind: lib!.libraryKind,
      },
      entries,
    );

    const rendered = parse(emitted.subscriptionsYaml) as Record<string, unknown>;
    const live = parse(fixture) as Record<string, unknown>;

    // deep-equal on the parsed structure (key order independent) — exact round-trip.
    expect(rendered.__preset__).toEqual(live.__preset__);
    expect(rendered['Plex TV Show by Date']).toEqual(live['Plex TV Show by Date']);
  });
});
