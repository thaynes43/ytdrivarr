import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { bootTestDb, type TestDb } from '../../testing/db';
import {
  parsePelotonSubscriptions,
  applyPelotonImport,
  type ParsedPeloton,
} from '../../core/import-peloton';
import { getLibrary } from '../../domain/libraries';
import { listSources } from '../../domain/sources';
import { listEntriesForSource } from '../../domain/entries';
import { emitLibrary } from '../../core/emitter';
import { deliverSession } from '../../core/credentials';
import { buildDiscoveryPayload, enqueueDiscoveryJob, claimJob } from '../../core/jobs';
import { reportJob } from '../../core/report';
import { startRun, getRun } from '../../domain/runs';
import type { Library, Source, SubscriptionEntryRow } from '../../db/schema';
import type { SubscriptionEntry } from '../../contracts';
import type { RunSummary } from '../../domain/run-summary';

/**
 * DEEP PARITY — emission + report (owner mandate: "test the shit out of Peloton"). The bar is
 * STRUCTURAL deep-equal on the PARSED yaml, not byte-equal: the emitter sorts entries deterministically
 * so its byte order differs from the hand-authored live file, but ytdl-sub consumes MAPS — key order is
 * semantically irrelevant, so parsed deep-equal is the correct and complete parity check.
 *
 * Fixtures: the live estate file (229 entries, 48 chip groups) verbatim.
 */

const FIXTURE_PATH = fileURLToPath(
  new URL('../../testing/fixtures/estate-peloton-subscriptions.yaml', import.meta.url),
);
const fixture = readFileSync(FIXTURE_PATH, 'utf8');

/** A parsed subscriptions entry value: `{ download, overrides: { tv_show_directory, season/episode } }`. */
interface EntryValue {
  download?: string;
  overrides?: Record<string, unknown>;
}
type PresetBlock = Record<string, Record<string, EntryValue>>;

function rowToEntry(row: SubscriptionEntryRow): SubscriptionEntry {
  const e: SubscriptionEntry = {
    entryKey: row.entryKey,
    displayName: row.displayName,
    downloadRef: row.downloadRef,
    preset: row.preset,
  };
  if (row.chip !== null) e.chip = row.chip;
  if (row.overrides !== null) e.overrides = row.overrides;
  if (row.ytdlOptions !== null) e.ytdlOptions = row.ytdlOptions;
  if (row.assets !== null) e.assets = row.assets;
  return e;
}

function countEntries(block: PresetBlock): number {
  return Object.values(block).reduce((n, group) => n + Object.keys(group).length, 0);
}

// --- Mission 3.2 + 3.4: emission round-trip parity on the 229-entry live file -------------------

describe('emission round-trip parity — the estate live file (embedded PG)', () => {
  let t: TestDb;
  let parsed: ParsedPeloton;
  let lib: Library;
  let rendered: Record<string, unknown>;
  let live: Record<string, unknown>;

  beforeAll(async () => {
    t = await bootTestDb();
    process.env.DATABASE_URL = t.connectionString;

    // import the live fixture through the branch's import-peloton path into embedded PG.
    parsed = parsePelotonSubscriptions(fixture);
    await applyPelotonImport(parsed, { apiKeyId: 'test', db: t.db });

    const sources = await listSources(t.db);
    const src = sources.find((s) => s.providerId === 'peloton')!;
    lib = (await getLibrary(src.libraryId, t.db))!;
    const rows = await listEntriesForSource(src.id, t.db);

    // run the emit path from the PERSISTED library + entries.
    const emitted = emitLibrary(
      {
        presetName: lib.presetName,
        workingDirectory: lib.workingDirectory,
        emitPolicy: lib.emitPolicy,
        libraryKind: lib.libraryKind,
      },
      rows.map(rowToEntry),
    );
    rendered = parse(emitted.subscriptionsYaml) as Record<string, unknown>;
    live = parse(fixture) as Record<string, unknown>;
  });

  afterAll(async () => {
    await t.stop();
    delete process.env.DATABASE_URL;
  });

  it('emits the `Plex TV Show by Date` top-level preset key', () => {
    expect(Object.keys(rendered)).toContain('Plex TV Show by Date');
    expect(rendered['Plex TV Show by Date']).toBeDefined();
  });

  it('carries the `__preset__` block VERBATIM incl. the literal ${PELOTON_BEARER} + cookiefile', () => {
    // deep-equal on the whole policy block (order-independent).
    expect(rendered.__preset__).toEqual(live.__preset__);
    // and drill into the load-bearing literals explicitly.
    const preset = rendered.__preset__ as Record<string, Record<string, Record<string, unknown>>>;
    const ytdl = preset.ytdl_options as Record<string, unknown>;
    const headers = ytdl.http_headers as Record<string, unknown>;
    // the placeholder is preserved LITERALLY — the downloader substitutes it from bearer.txt at
    // download time; the emitter must NOT expand it.
    expect(headers.Authorization).toBe('${PELOTON_BEARER}');
    expect(ytdl.cookiefile).toBe('/media/peloton/cookies.txt');
  });

  it('emits the EXACT set of 48 chip groups', () => {
    const renderedGroups = Object.keys(rendered['Plex TV Show by Date'] as PresetBlock).sort();
    const liveGroups = Object.keys(live['Plex TV Show by Date'] as PresetBlock).sort();
    expect(renderedGroups).toEqual(liveGroups);
    expect(renderedGroups).toHaveLength(48);
  });

  it('round-trips all 229 entries — same displayName, download URL, and overrides for each', () => {
    const renderedBlock = rendered['Plex TV Show by Date'] as PresetBlock;
    const liveBlock = live['Plex TV Show by Date'] as PresetBlock;
    expect(countEntries(liveBlock)).toBe(229);
    expect(countEntries(renderedBlock)).toBe(229);

    for (const [chip, group] of Object.entries(liveBlock)) {
      const renderedGroup = renderedBlock[chip];
      expect(renderedGroup, `chip group ${chip} present`).toBeDefined();
      for (const [displayName, value] of Object.entries(group)) {
        const r = renderedGroup![displayName];
        expect(r, `entry "${displayName}" under ${chip}`).toBeDefined();
        expect(r!.download).toBe(value.download);
        expect(r!.overrides?.tv_show_directory).toBe(value.overrides?.tv_show_directory);
        expect(r!.overrides?.season_number).toBe(value.overrides?.season_number);
        expect(r!.overrides?.episode_number).toBe(value.overrides?.episode_number);
      }
    }

    // the strongest single assertion: the whole preset block deep-equals (covers everything above).
    expect(renderedBlock).toEqual(liveBlock);
  });

  it('the emitPolicy jsonb round-trips from the library unmodified (Mission 3.4)', () => {
    // stored jsonb === parsed __preset__, and emitting renders it back byte-shape identical.
    expect(lib.emitPolicy).toEqual(parsed.preset);
    expect(rendered.__preset__).toEqual(parsed.preset);
  });
});

// --- Mission 3.4: credentials.ts writes bearer.txt / cookies.txt verbatim -----------------------

describe('credentials — bearer.txt starts with `Bearer `, cookies.txt verbatim (no DB)', () => {
  it('writes the Authorization header value verbatim (incl. the `Bearer ` prefix) + the cookie jar', async () => {
    const credRoot = await mkdtemp(join(tmpdir(), 'ytdrivarr-cred-'));
    // an absolute mediaRoot would escape the sandbox; a RELATIVE credentialPath resolves under credRoot.
    const library = { credentialPath: 'peloton-creds', mediaRoot: '/media/peloton' };
    const bearerValue = 'Bearer eyJhbGciOiJ.header.value.verbatim';
    const cookieJar = '# Netscape HTTP Cookie File\n.onepeloton.com\tTRUE\t/\tTRUE\t0\tsid\tabc123';

    const delivery = await deliverSession(
      library,
      { bearer: bearerValue, cookies: cookieJar, mintedAt: '2026-07-20T11:00:00.000Z' },
      credRoot,
    );

    const bearer = await readFile(join(credRoot, 'peloton-creds', 'bearer.txt'), 'utf8');
    expect(bearer.startsWith('Bearer ')).toBe(true); // the header VALUE, not the bare token
    expect(bearer).toBe(bearerValue); // verbatim, byte-for-byte
    const cookies = await readFile(join(credRoot, 'peloton-creds', 'cookies.txt'), 'utf8');
    expect(cookies).toBe(cookieJar); // verbatim Netscape jar
    expect(delivery.bearerPath).toBeDefined();
    expect(delivery.cookiesPath).toBeDefined();

    await rm(credRoot, { recursive: true, force: true });
  });
});

// --- Mission 3.5 + 3.3(c): merge-not-wipe report semantics + immutable numbering ----------------

describe('report path — merge (not wipe) the seeded 229 + immutable numbering (embedded PG)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootTestDb();
    process.env.DATABASE_URL = t.connectionString;
  });
  afterAll(async () => {
    await t.stop();
    delete process.env.DATABASE_URL;
  });

  it('a report of only NEW classes merges with the 229; seeded untouched; summary existing reflects the file', async () => {
    const projectionRoot = await mkdtemp(join(tmpdir(), 'ytdrivarr-emit-'));

    // seed the full live file (229).
    const parsed = parsePelotonSubscriptions(fixture);
    await applyPelotonImport(parsed, { apiKeyId: 'test', db: t.db });
    const sources = await listSources(t.db);
    const src = sources.find((s) => s.providerId === 'peloton') as Source;
    const lib = (await getLibrary(src.libraryId, t.db)) as Library;

    const seededRows = await listEntriesForSource(src.id, t.db);
    expect(seededRows).toHaveLength(229);
    // capture a seeded entry to prove it is untouched + its numbering is immutable.
    const seededCycling = seededRows.find(
      (r) => r.chip === 'Cycling (30 min)',
    ) as SubscriptionEntryRow;
    const seededOriginalEpisode = seededCycling.episodeNumber;
    const cyclingExisting = parsed.entries.filter((e) => e.activity === 'cycling').length;

    // enqueue + claim a discovery job.
    const run = await startRun({
      scope: 'source',
      scopeRef: src.id,
      trigger: 'cron',
      providerId: 'peloton',
      db: t.db,
    });
    const payload = await buildDiscoveryPayload({ runId: run.id, source: src, library: lib }, t.db);
    const job = await enqueueDiscoveryJob(payload, t.db);
    await claimJob({ worker: 'w1', providerId: 'peloton', db: t.db });

    // the worker reports 2 NEW cycling classes + a RE-REPORT of the seeded class carrying a DIFFERENT
    // episode_number (must be ignored — immutable numbering). No session (avoids the absolute
    // mediaRoot credential path; credential delivery is covered separately).
    const newEntry = (classId: string, episode: number): SubscriptionEntry => ({
      entryKey: classId,
      displayName: `30 min Ride ${classId} with Cody Rigsby`,
      downloadRef: `https://members.onepeloton.com/classes/player/${classId}`,
      preset: 'Plex TV Show by Date',
      chip: 'Cycling (30 min)',
      overrides: {
        tv_show_directory: '/media/peloton/Cycling/Cody Rigsby',
        season_number: 30,
        episode_number: episode,
      },
    });
    const reReport: SubscriptionEntry = {
      entryKey: seededCycling.entryKey,
      displayName: seededCycling.displayName,
      downloadRef: seededCycling.downloadRef,
      preset: seededCycling.preset,
      chip: seededCycling.chip!,
      overrides: { ...(seededCycling.overrides ?? {}), episode_number: 999999 }, // MUST be ignored
    };

    const outcome = await reportJob({
      id: job.id,
      worker: 'w1',
      result: {
        entries: [newEntry('newclass0001', 3000), newEntry('newclass0002', 3001), reReport],
        telemetry: {
          activities: [
            {
              activity: 'cycling',
              existing: cyclingExisting, // reflects the SEEDED file
              added: 2,
              total: cyclingExisting + 2,
              scraped: 2,
              skipped: 0,
              scrolls: 5,
            },
          ],
          authOk: true,
          loginOk: true,
          selectorDriftHits: 0,
        },
      },
      projectionRoot,
      db: t.db,
    });

    // MERGE not wipe: 229 seeded + 2 new = 231; the re-report updated in place (not added).
    expect(outcome.merged).toEqual({ added: 2, updated: 1 });
    const afterRows = await listEntriesForSource(src.id, t.db);
    expect(afterRows).toHaveLength(231);

    // seeded entry untouched + numbering immutable (the 999999 re-report was ignored).
    const afterCycling = afterRows.find((r) => r.entryKey === seededCycling.entryKey)!;
    expect(afterCycling.episodeNumber).toBe(seededOriginalEpisode);
    expect(afterCycling.episodeNumber).not.toBe(999999);

    // the projected subscriptions.yaml carries all 231 entries and renders the ORIGINAL number.
    const projected = parse(
      await readFile(join(projectionRoot, lib.projectionPath, 'subscriptions.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    const block = projected['Plex TV Show by Date'] as PresetBlock;
    expect(countEntries(block)).toBe(231);
    // emitted chip-group keys carry the `= ` prefix (`= Cycling (30 min)`).
    const renderedReReport = block['= Cycling (30 min)']?.[seededCycling.displayName];
    expect(renderedReReport?.overrides?.episode_number).toBe(seededOriginalEpisode);

    // the finalized Run's summary carries the per-activity `existing` count from the seeded file.
    const finished = await getRun(run.id, t.db);
    const summary = finished!.summary as unknown as RunSummary;
    const cyclingRow = summary.changes.activities.find((a) => a.activity === 'cycling');
    expect(cyclingRow?.existing).toBe(cyclingExisting);
    expect(cyclingRow?.added).toBe(2);
    expect(outcome.counts.entries).toBe(231);

    await rm(projectionRoot, { recursive: true, force: true });
  });
});
