import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { bootTestDb, type TestDb } from '../testing/db';
import { createLibrary } from '../domain/libraries';
import { createSource } from '../domain/sources';
import { listEntriesForSource } from '../domain/entries';
import { previewDiscovery } from './preview';
import type { Library, Source } from '../db/schema';

/**
 * previewDiscovery is COMPUTE-ONLY: it simulates a run's would-be entry set + rendered files in
 * memory and MUST NOT touch the DB or the projection volume. These tests run against embedded
 * Postgres through the real registry + composeAndEmit.
 */
describe('previewDiscovery — compute-only dry-run (embedded PG)', () => {
  let t: TestDb;
  let lib: Library;
  let ytSource: Source;
  let pelSource: Source;

  beforeAll(async () => {
    t = await bootTestDb();
    process.env.DATABASE_URL = t.connectionString;
    lib = await createLibrary({
      name: 'Preview Lib',
      mediaRoot: '/media/yt',
      libraryKind: 'video',
      projectionPath: 'preview-lib',
      db: t.db,
    });
    ytSource = await createSource({
      libraryId: lib.id,
      providerId: 'youtube',
      kind: 'youtube-url-list',
      mediaKind: 'video',
      displayName: 'Test Channel',
      ref: '@testchannel',
      enabled: true,
      db: t.db,
    });
    pelSource = await createSource({
      libraryId: lib.id,
      providerId: 'peloton',
      kind: 'peloton-activity',
      mediaKind: 'video',
      displayName: 'Cycling',
      ref: 'cycling',
      enabled: true,
      db: t.db,
    });
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    delete process.env.DATABASE_URL;
  });

  it('simulates an in_core (YouTube) discovery as ADDED, renders the file, and writes NOTHING', async () => {
    // no persisted entries yet → the pure discover() (1 URL → 1 entry) shows as a single add.
    expect(await listEntriesForSource(ytSource.id, t.db)).toHaveLength(0);

    const out = await previewDiscovery({ scope: 'library', scopeRef: lib.id, db: t.db });
    const previewed = out.libraries[0]!;
    const yt = previewed.sources.find((s) => s.sourceId === ytSource.id)!;
    expect(yt.previewable).toBe(true);
    expect([yt.added, yt.removed, yt.unchanged]).toEqual([1, 0, 0]);

    // the rendered subscriptions.yaml carries the simulated entry (valid YAML, non-empty).
    expect(previewed.emitted).toBeGreaterThanOrEqual(1);
    expect(parse(previewed.subscriptionsYaml)).toBeTruthy();

    // NO WRITE: the ledger is untouched after a preview.
    expect(await listEntriesForSource(ytSource.id, t.db)).toHaveLength(0);
  });

  it('flags an out_of_process (Peloton) source as not previewable, with an honest warning', async () => {
    const out = await previewDiscovery({ scope: 'library', scopeRef: lib.id, db: t.db });
    const pel = out.libraries[0]!.sources.find((s) => s.sourceId === pelSource.id)!;
    expect(pel.previewable).toBe(false);
    expect([pel.added, pel.removed, pel.unchanged]).toEqual([0, 0, 0]);
    expect(out.warnings.some((w) => w.includes('peloton'))).toBe(true);
  });

  it('overrides.disableSourceIds previews unmonitoring — the source drops out of the emit', async () => {
    const base = await previewDiscovery({ scope: 'library', scopeRef: lib.id, db: t.db });
    expect(base.libraries[0]!.emitted).toBe(1); // the YouTube source contributes its 1 entry

    const out = await previewDiscovery({
      scope: 'library',
      scopeRef: lib.id,
      db: t.db,
      overrides: { disableSourceIds: [ytSource.id] },
    });
    expect(out.libraries[0]!.emitted).toBe(0); // excluded exactly as unmonitoring would
    const yt = out.libraries[0]!.sources.find((s) => s.sourceId === ytSource.id)!;
    expect(yt.added).toBe(0); // disabled → no discovery simulated
  });

  it('overrides.library.presetName re-keys the rendered subscriptions.yaml', async () => {
    const out = await previewDiscovery({
      scope: 'library',
      scopeRef: lib.id,
      db: t.db,
      overrides: { library: { presetName: 'My Custom Preset' } },
    });
    const doc = parse(out.libraries[0]!.subscriptionsYaml) as Record<string, unknown>;
    expect(Object.keys(doc)).toContain('My Custom Preset');
  });
});
