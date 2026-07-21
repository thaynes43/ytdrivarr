import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootTestDb, type TestDb } from '../testing/db';

/**
 * Migration 0002 — the WATCH-GRAIN split: one aggregate Peloton Source becomes twelve per-activity
 * Sources, entries reattributed by chip, published numbering untouched, audit rows in the same
 * transaction. The suite reconstructs the PRE-SPLIT shape via raw SQL (the legacy state no code
 * path can produce anymore), then executes the shipped migration file against it — the exact SQL
 * the deploy will run against the live database, including its idempotency guarantee.
 */

const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL('../../migrations/0002_peloton_per_activity.sql', import.meta.url)),
  'utf8',
);

const ACTIVITIES = [
  'bike_bootcamp',
  'bootcamp',
  'row_bootcamp',
  'rowing',
  'cycling',
  'running',
  'walking',
  'cardio',
  'strength',
  'yoga',
  'stretching',
  'meditation',
];

let t: TestDb;

beforeAll(async () => {
  t = await bootTestDb();
});

afterAll(async () => {
  await t.stop();
});

interface SeededAggregate {
  libraryId: string;
  sourceId: string;
}

/** Reconstruct the pre-split live shape: 1 library, 1 aggregate source, chip-attributed entries. */
async function seedAggregate(opts: { cap?: number; name?: string } = {}): Promise<SeededAggregate> {
  const name = opts.name ?? `Peloton ${Math.random().toString(36).slice(2)}`;
  const lib = await t.pool.query(
    `insert into libraries (name, media_root, library_kind, preset_name, projection_path, working_directory)
     values ($1, '/media/peloton', 'video', 'Plex TV Show by Date', $2, '/config') returning id`,
    [name, `proj-${Math.random().toString(36).slice(2)}`],
  );
  const libraryId = (lib.rows[0] as { id: string }).id;
  const settings = {
    activities: ACTIVITIES,
    maxClassesPerActivity: opts.cap ?? 25,
    dynamicScrolling: true,
    maxScrolls: 250,
    scrollPauseSec: 3,
    pageLoadWaitSec: 10,
    loginWaitSec: 15,
  };
  const src = await t.pool.query(
    `insert into sources (library_id, provider_id, kind, media_kind, display_name, ref, settings, created_by)
     values ($1, 'peloton', 'peloton-scraper', 'video', 'Peloton', 'peloton', $2, 'import') returning id`,
    [libraryId, JSON.stringify(settings)],
  );
  const sourceId = (src.rows[0] as { id: string }).id;

  const entries: [string, string, number, number][] = [
    // [classId, chip, season(=duration), episode]
    ['cyc1', 'Cycling (30 min)', 30, 2150],
    ['cyc2', 'Cycling (45 min)', 45, 176],
    ['car1', 'Cardio (30 min)', 30, 222],
    ['tread1', 'Tread Bootcamp (45 min)', 45, 485], // special mapping → bootcamp
    ['bike1', 'Bike Bootcamp (30 min)', 30, 741],
    ['row1', 'Row Bootcamp (30 min)', 30, 320],
    ['yoga1', 'Yoga (20 min)', 20, 55],
    ['odd1', 'Hiit Cardio (30 min)', 30, 7], // unmappable → stays on the anchor
  ];
  for (const [classId, chip, season, episode] of entries) {
    await t.pool.query(
      `insert into subscription_entries
         (source_id, entry_key, display_name, download_ref, preset, chip, overrides, season_number, episode_number)
       values ($1, $2, $3, $4, 'Plex TV Show by Date', $5, $6, $7, $8)`,
      [
        sourceId,
        classId,
        `${season} min class ${classId}`,
        `https://members.onepeloton.com/classes/player/${classId}`,
        chip,
        JSON.stringify({ season_number: season, episode_number: episode }),
        season,
        episode,
      ],
    );
  }
  return { libraryId, sourceId };
}

async function pelotonSources(libraryId: string) {
  const res = await t.pool.query(
    `select id, ref, display_name, settings, enabled, created_by from sources
     where library_id = $1 and provider_id = 'peloton' order by ref`,
    [libraryId],
  );
  return res.rows as {
    id: string;
    ref: string;
    display_name: string;
    settings: Record<string, unknown>;
    enabled: boolean;
    created_by: string;
  }[];
}

describe('migration 0002 — peloton per-activity split', () => {
  it('splits the aggregate into 12 per-activity sources, preserving the anchor row id', async () => {
    const { libraryId, sourceId } = await seedAggregate();
    await t.pool.query(MIGRATION_SQL);

    const rows = await pelotonSources(libraryId);
    expect(rows.map((r) => r.ref)).toEqual([...ACTIVITIES].sort());
    // The ANCHOR (first alphabetical: bike_bootcamp) keeps the ORIGINAL row id, so an in-flight
    // job payload enqueued pre-deploy still reports into a valid source.
    const anchor = rows.find((r) => r.ref === 'bike_bootcamp');
    expect(anchor?.id).toBe(sourceId);
    // Display names follow the donor folder mapping, incl. the tread-bootcamp override.
    expect(rows.find((r) => r.ref === 'bootcamp')?.display_name).toBe('Tread Bootcamp');
    expect(rows.find((r) => r.ref === 'cycling')?.display_name).toBe('Cycling');
    // provenance/enabled copied.
    expect(rows.every((r) => r.enabled)).toBe(true);
    expect(rows.every((r) => r.created_by === 'import')).toBe(true);
  });

  it('melts the default cap into "tracks the global default" and drops the activities array', async () => {
    const { libraryId } = await seedAggregate();
    await t.pool.query(MIGRATION_SQL);
    const rows = await pelotonSources(libraryId);
    for (const row of rows) {
      expect(row.settings.activities).toBeUndefined();
      // cap 25 === the global default → the override melts away.
      expect(row.settings.maxClassesPerActivity).toBeUndefined();
      // the scrape profile is preserved verbatim.
      expect(row.settings.maxScrolls).toBe(250);
      expect(row.settings.dynamicScrolling).toBe(true);
    }
  });

  it('preserves a NON-default cap as an explicit per-source override', async () => {
    const { libraryId } = await seedAggregate({ cap: 40 });
    await t.pool.query(MIGRATION_SQL);
    const rows = await pelotonSources(libraryId);
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.settings.maxClassesPerActivity).toBe(40);
    }
  });

  it('reattributes entries by chip with published numbering untouched; unmappable chips stay on the anchor', async () => {
    const { libraryId, sourceId } = await seedAggregate();
    await t.pool.query(MIGRATION_SQL);
    const rows = await pelotonSources(libraryId);
    const byRef = new Map(rows.map((r) => [r.ref, r.id]));

    const entriesOf = async (id: string) =>
      (
        await t.pool.query(
          `select entry_key, season_number, episode_number from subscription_entries
           where source_id = $1 order by entry_key`,
          [id],
        )
      ).rows as { entry_key: string; season_number: number; episode_number: number }[];

    const cycling = await entriesOf(byRef.get('cycling')!);
    expect(cycling.map((e) => e.entry_key)).toEqual(['cyc1', 'cyc2']);
    // numbering rides along on the rows — the IDs-never-renumbered doctrine.
    expect(cycling.find((e) => e.entry_key === 'cyc1')).toMatchObject({
      season_number: 30,
      episode_number: 2150,
    });
    expect(await entriesOf(byRef.get('cardio')!)).toHaveLength(1);
    // the special mapping: 'Tread Bootcamp (…)' chips land on the `bootcamp` slug.
    const bootcamp = await entriesOf(byRef.get('bootcamp')!);
    expect(bootcamp.map((e) => e.entry_key)).toEqual(['tread1']);
    const rowBootcamp = await entriesOf(byRef.get('row_bootcamp')!);
    expect(rowBootcamp.map((e) => e.entry_key)).toEqual(['row1']);
    // the anchor keeps its own activity's entries + the unmappable chip.
    const anchor = await entriesOf(sourceId);
    expect(anchor.map((e) => e.entry_key).sort()).toEqual(['bike1', 'odd1']);
  });

  it('writes audit rows in the same transaction: one update for the anchor, one create per sibling', async () => {
    const { libraryId, sourceId } = await seedAggregate();
    await t.pool.query(MIGRATION_SQL);
    const rows = await pelotonSources(libraryId);
    const ids = rows.map((r) => r.id);
    const audit = await t.pool.query(
      `select source_id, action, api_key_id from source_audit
       where api_key_id = 'migration:0002' and source_id = any($1::uuid[])`,
      [ids],
    );
    const actions = audit.rows as { source_id: string; action: string }[];
    expect(actions.filter((a) => a.action === 'update').map((a) => a.source_id)).toEqual([
      sourceId,
    ]);
    expect(actions.filter((a) => a.action === 'create')).toHaveLength(11);
  });

  it('is idempotent: re-running against an already-split library is a no-op', async () => {
    const { libraryId } = await seedAggregate();
    await t.pool.query(MIGRATION_SQL);
    const before = await pelotonSources(libraryId);
    const auditBefore = await t.pool.query(
      `select count(*)::int as n from source_audit where api_key_id = 'migration:0002'`,
    );
    await t.pool.query(MIGRATION_SQL); // second run — the already-split rows must not match
    const after = await pelotonSources(libraryId);
    const auditAfter = await t.pool.query(
      `select count(*)::int as n from source_audit where api_key_id = 'migration:0002'`,
    );
    expect(after).toEqual(before);
    expect((auditAfter.rows[0] as { n: number }).n).toBe((auditBefore.rows[0] as { n: number }).n);
  });

  it('leaves YouTube sources and a fresh database untouched', async () => {
    const lib = await t.pool.query(
      `insert into libraries (name, media_root, library_kind, preset_name, projection_path, working_directory)
       values ('YT-untouched', '/media/youtube', 'video', 'Plex TV Show by Date', 'yt-untouched', '/config') returning id`,
    );
    const libraryId = (lib.rows[0] as { id: string }).id;
    await t.pool.query(
      `insert into sources (library_id, provider_id, kind, media_kind, display_name, ref, settings, created_by)
       values ($1, 'youtube', 'youtube-url-list', 'video', 'Some Channel', 'https://www.youtube.com/@some', '{"chip":"Docs"}', 'import')`,
      [libraryId],
    );
    await t.pool.query(MIGRATION_SQL);
    const res = await t.pool.query(`select ref, settings from sources where library_id = $1`, [
      libraryId,
    ]);
    expect(res.rows).toHaveLength(1);
    expect((res.rows[0] as { ref: string }).ref).toBe('https://www.youtube.com/@some');
  });
});
