import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { eq } from 'drizzle-orm';
import { bootTestDb, type TestDb } from '../testing/db';
import { jobs, type Library, type Source } from '../db/schema';
import { createLibrary } from '../domain/libraries';
import { createSource } from '../domain/sources';
import { startRun, getRun } from '../domain/runs';
import { listEntriesForSource, mergeEntriesForSource } from '../domain/entries';
import { createStateStore } from './state-store';
import {
  buildPelotonDiscoveryPayloads,
  claimJob,
  enqueueDiscoveryJob,
  failJob,
  getJob,
  heartbeatJob,
} from './jobs';
import { reportJob } from './report';
import { ConflictError } from '../errors';
import type { SubscriptionEntry } from '../contracts';

/**
 * The out-of-process transport lifecycle (DESIGN-045 D-03) against embedded Postgres: claim (with
 * FOR UPDATE SKIP LOCKED), heartbeat, report (merge/deliver/emit/finalize), fail (retry + terminal),
 * and the discovery payload builder. File names avoid the reserved parity and emission suffixes
 * (a second agent owns the deep parity + property suites).
 */
let t: TestDb;

async function seedLibrary(overrides: Partial<Library> = {}): Promise<Library> {
  return createLibrary({
    name: `Peloton ${Math.random().toString(36).slice(2)}`,
    mediaRoot: overrides.mediaRoot ?? '/media/peloton',
    libraryKind: 'video',
    presetName: 'Plex TV Show by Date',
    projectionPath: overrides.projectionPath ?? `peloton-${Math.random().toString(36).slice(2)}`,
    ...(overrides.credentialPath ? { credentialPath: overrides.credentialPath } : {}),
    emitPolicy: overrides.emitPolicy ?? {
      overrides: { tv_show_directory: '/media/peloton' },
      ytdl_options: { cookiefile: '/media/peloton/cookies.txt' },
    },
    db: t.db,
  });
}

/** A per-activity Peloton Source (the watch-grain model): ref = the activity slug. */
async function seedSource(
  libraryId: string,
  slug = 'cycling',
  settings: Record<string, unknown> = {},
): Promise<Source> {
  return createSource({
    libraryId,
    providerId: 'peloton',
    kind: 'peloton-scraper',
    mediaKind: 'video',
    displayName: slug === 'bootcamp' ? 'Tread Bootcamp' : slug[0]!.toUpperCase() + slug.slice(1),
    ref: slug,
    settings,
    db: t.db,
  });
}

function entry(classId: string, season: number, episode: number): SubscriptionEntry {
  return {
    entryKey: classId,
    displayName: `${season} min Ride with Someone ${classId}`,
    downloadRef: `https://members.onepeloton.com/classes/player/${classId}`,
    preset: 'Plex TV Show by Date',
    chip: `Cycling (${season} min)`,
    overrides: {
      tv_show_directory: `/media/peloton/Cycling/Someone`,
      season_number: season,
      episode_number: episode,
    },
  };
}

async function enqueueForSource(
  source: Source,
  library: Library,
): Promise<{ jobId: string; runId: string }> {
  const run = await startRun({
    scope: 'source',
    scopeRef: source.id,
    trigger: 'cron',
    providerId: 'peloton',
    db: t.db,
  });
  const payloads = await buildPelotonDiscoveryPayloads(
    { runId: run.id, sources: [source], library },
    t.db,
  );
  const payload = payloads[0];
  if (!payload) throw new Error('expected one payload for one enabled source');
  const job = await enqueueDiscoveryJob(payload, t.db);
  return { jobId: job.id, runId: run.id };
}

beforeAll(async () => {
  t = await bootTestDb();
  process.env.DATABASE_URL = t.connectionString;
});

afterAll(async () => {
  await t.stop();
  delete process.env.DATABASE_URL;
});

describe('buildPelotonDiscoveryPayloads', () => {
  it('builds existingClassIds + PER-ACTIVITY per-duration episodeNumbering from seeded entries', async () => {
    const lib = await seedLibrary();
    const src = await seedSource(lib.id);
    await mergeEntriesForSource(
      src.id,
      [entry('aaa', 30, 2026), entry('bbb', 30, 2150), entry('ccc', 45, 176)],
      t.db,
    );
    const run = await startRun({ scope: 'source', scopeRef: src.id, trigger: 'cron', db: t.db });
    const payloads = await buildPelotonDiscoveryPayloads(
      { runId: run.id, sources: [src], library: lib },
      t.db,
    );
    expect(payloads).toHaveLength(1);
    const payload = payloads[0]!;

    expect(payload.providerId).toBe('peloton');
    expect(payload.mode).toBe('scrape');
    expect(payload.sourceId).toBe(src.id);
    expect(payload.libraryId).toBe(lib.id);
    expect([...payload.peloton.existingClassIds].sort()).toEqual(['aaa', 'bbb', 'ccc']);
    // PER-ACTIVITY nested: the `entry()` helper chips everything as Cycling, so the seed nests under
    // `cycling` — max episode per duration (contract shape {activitySlug:{duration:max}}).
    expect(payload.peloton.episodeNumbering).toEqual({ cycling: { '30': 2150, '45': 176 } });
    expect(payload.peloton.mediaRoot).toBe('/media/peloton');
    // The cap tracks the GLOBAL default (25) when the per-activity source carries no override.
    expect(payload.peloton.maxClassesPerActivity).toBe(25);
    expect(payload.peloton.folder.folderNames.bike_bootcamp).toBe('Bike Bootcamp');
    expect(payload.sourceIdsByActivity).toEqual({ cycling: src.id });
  });

  it('AGGREGATES uniformly-configured activity sources into ONE job (the worker contract)', async () => {
    const lib = await seedLibrary();
    const cycling = await seedSource(lib.id, 'cycling');
    const yoga = await seedSource(lib.id, 'yoga');
    const bootcamp = await seedSource(lib.id, 'bootcamp');
    const run = await startRun({ scope: 'library', scopeRef: lib.id, trigger: 'cron', db: t.db });

    const payloads = await buildPelotonDiscoveryPayloads(
      { runId: run.id, sources: [cycling, yoga, bootcamp], library: lib },
      t.db,
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.peloton.activities).toEqual(['bootcamp', 'cycling', 'yoga']);
    expect(payloads[0]!.sourceIdsByActivity).toEqual({
      bootcamp: bootcamp.id,
      cycling: cycling.id,
      yoga: yoga.id,
    });
    // The anchor sourceId is a member of the group (a valid report fallback target).
    expect(Object.values(payloads[0]!.sourceIdsByActivity!)).toContain(payloads[0]!.sourceId);
  });

  it('an UNMONITORED activity is excluded from the scrape but still seeds dedup + numbering', async () => {
    const lib = await seedLibrary();
    const cycling = await seedSource(lib.id, 'cycling');
    const yoga = await seedSource(lib.id, 'yoga');
    await mergeEntriesForSource(cycling.id, [entry('keepme', 30, 900)], t.db);
    const { setSourceEnabled } = await import('../domain/sources');
    const disabledCycling = await setSourceEnabled({ id: cycling.id, enabled: false, db: t.db });
    const run = await startRun({ scope: 'library', scopeRef: lib.id, trigger: 'cron', db: t.db });

    const payloads = await buildPelotonDiscoveryPayloads(
      { runId: run.id, sources: [disabledCycling, yoga], library: lib },
      t.db,
    );

    expect(payloads).toHaveLength(1);
    // cycling is NOT scraped…
    expect(payloads[0]!.peloton.activities).toEqual(['yoga']);
    // …but its persisted classIds + numbering band still anchor the shared seed, so re-monitoring
    // can never re-add or renumber (entries persist; monitored is a projection/scrape gate).
    expect(payloads[0]!.peloton.existingClassIds).toContain('keepme');
    expect(payloads[0]!.peloton.episodeNumbering.cycling).toEqual({ '30': 900 });
  });

  it('a per-source cap override honestly splits into its own job at its own cap', async () => {
    const lib = await seedLibrary();
    const cycling = await seedSource(lib.id, 'cycling', { maxClassesPerActivity: 50 });
    const yoga = await seedSource(lib.id, 'yoga');
    const rowing = await seedSource(lib.id, 'rowing');
    const run = await startRun({ scope: 'library', scopeRef: lib.id, trigger: 'cron', db: t.db });

    const payloads = await buildPelotonDiscoveryPayloads(
      { runId: run.id, sources: [cycling, yoga, rowing], library: lib },
      t.db,
    );

    expect(payloads).toHaveLength(2);
    const capped = payloads.find((p) => p.peloton.maxClassesPerActivity === 50)!;
    const defaulted = payloads.find((p) => p.peloton.maxClassesPerActivity === 25)!;
    expect(capped.peloton.activities).toEqual(['cycling']);
    expect(defaulted.peloton.activities).toEqual(['rowing', 'yoga']);
  });

  it('returns NO payloads when every activity is unmonitored', async () => {
    const lib = await seedLibrary();
    const cycling = await seedSource(lib.id, 'cycling');
    const { setSourceEnabled } = await import('../domain/sources');
    const disabled = await setSourceEnabled({ id: cycling.id, enabled: false, db: t.db });
    const run = await startRun({ scope: 'library', scopeRef: lib.id, trigger: 'cron', db: t.db });

    const payloads = await buildPelotonDiscoveryPayloads(
      { runId: run.id, sources: [disabled], library: lib },
      t.db,
    );
    expect(payloads).toEqual([]);
  });
});

describe('job lifecycle', () => {
  it('claim → heartbeat happy path (claimed → running, ownership enforced)', async () => {
    const lib = await seedLibrary();
    const src = await seedSource(lib.id);
    const { jobId } = await enqueueForSource(src, lib);

    const claimed = await claimJob({ worker: 'w1', db: t.db });
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.attempts).toBe(1);
    let row = await getJob(jobId, t.db);
    expect(row?.status).toBe('claimed');
    expect(row?.claimedBy).toBe('w1');

    const hb = await heartbeatJob({ id: jobId, worker: 'w1', db: t.db });
    expect(hb.ok).toBe(true);
    row = await getJob(jobId, t.db);
    expect(row?.status).toBe('running');

    await expect(
      heartbeatJob({ id: jobId, worker: 'someone-else', db: t.db }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('two concurrent claims never grab the same job (SKIP LOCKED)', async () => {
    const lib = await seedLibrary();
    const src = await seedSource(lib.id);
    await enqueueForSource(src, lib);
    await enqueueForSource(src, lib);

    const [a, b] = await Promise.all([
      claimJob({ worker: 'a', providerId: 'peloton', db: t.db }),
      claimJob({ worker: 'b', providerId: 'peloton', db: t.db }),
    ]);
    expect(a?.id).toBeDefined();
    expect(b?.id).toBeDefined();
    expect(a?.id).not.toBe(b?.id);
  });

  it('reclaims a job whose heartbeat lapsed past the SLA', async () => {
    const lib = await seedLibrary();
    const src = await seedSource(lib.id);
    const { jobId } = await enqueueForSource(src, lib);

    const first = await claimJob({ worker: 'w1', db: t.db });
    expect(first?.id).toBe(jobId);
    // age the heartbeat well past the expiry.
    await t.db
      .update(jobs)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(jobs.id, jobId));

    const reclaimed = await claimJob({ worker: 'w2', heartbeatExpirySec: 120, db: t.db });
    expect(reclaimed?.id).toBe(jobId);
    expect(reclaimed?.attempts).toBe(2);
    const row = await getJob(jobId, t.db);
    expect(row?.claimedBy).toBe('w2');
  });

  it('fail(retryable) requeues for reclaim; the linked Run stays warn', async () => {
    const lib = await seedLibrary();
    const src = await seedSource(lib.id);
    const { jobId, runId } = await enqueueForSource(src, lib);

    await claimJob({ worker: 'w1', db: t.db });
    const res = await failJob({
      id: jobId,
      worker: 'w1',
      error: 'transient',
      retryable: true,
      maxAttempts: 3,
      db: t.db,
    });
    expect(res.status).toBe('requeued');
    let row = await getJob(jobId, t.db);
    expect(row?.status).toBe('queued');
    expect(row?.claimedBy).toBeNull();

    const run = await getRun(runId, t.db);
    expect(run?.status).toBe('warn');

    const reclaimed = await claimJob({ worker: 'w2', db: t.db });
    expect(reclaimed?.id).toBe(jobId);
    expect(reclaimed?.attempts).toBe(2);
    row = await getJob(jobId, t.db);
    expect(row?.status).toBe('claimed');
  });

  it('max-attempts terminal fail → job error + Run finalized error with the alarm surfaced', async () => {
    const lib = await seedLibrary();
    const src = await seedSource(lib.id);
    const { jobId, runId } = await enqueueForSource(src, lib);

    // attempts 1 & 2: retryable → requeue.
    await claimJob({ worker: 'w', db: t.db });
    await failJob({
      id: jobId,
      worker: 'w',
      error: 'bearer miss',
      retryable: true,
      alarm: { kind: 'bearer_capture' },
      maxAttempts: 3,
      db: t.db,
    });
    await claimJob({ worker: 'w', db: t.db });
    await failJob({
      id: jobId,
      worker: 'w',
      error: 'bearer miss',
      retryable: true,
      alarm: { kind: 'bearer_capture' },
      maxAttempts: 3,
      db: t.db,
    });
    // attempts 3: still retryable but at the ceiling → terminal error.
    await claimJob({ worker: 'w', db: t.db });
    const res = await failJob({
      id: jobId,
      worker: 'w',
      error: 'bearer miss',
      retryable: true,
      alarm: { kind: 'bearer_capture' },
      maxAttempts: 3,
      db: t.db,
    });
    expect(res.status).toBe('error');

    const row = await getJob(jobId, t.db);
    expect(row?.status).toBe('error');

    const run = await getRun(runId, t.db);
    expect(run?.status).toBe('error');
    expect(run?.finishedAt).not.toBeNull();
    // the bearer_capture alarm is surfaced (never a silent stale token) in telemetry + summary.
    expect(run?.telemetry.bearerCaptureRetries).toBeGreaterThan(0);
    expect(run?.summary).not.toBeNull();
  });
});

describe('report path', () => {
  it('merges (not wipes) entries, preserves immutable numbering, delivers session, projects, finalizes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ytdrivarr-report-'));
    const credRoot = await mkdtemp(join(tmpdir(), 'ytdrivarr-cred-'));
    const lib = await seedLibrary({
      credentialPath: 'peloton-creds',
      projectionPath: 'peloton-out',
    });
    const src = await seedSource(lib.id);

    // Pre-existing entry: E2026 for classId "existing" — its numbering must survive a re-report.
    await mergeEntriesForSource(src.id, [entry('existing', 30, 2026)], t.db);
    const { jobId, runId } = await enqueueForSource(src, lib);
    await claimJob({ worker: 'w1', db: t.db });

    // The worker reports a NEW class + a re-report of "existing" carrying a DIFFERENT episode.
    const reReport = entry('existing', 30, 9999); // must be IGNORED (immutable numbering)
    const fresh = entry('newclass', 30, 2151);
    const outcome = await reportJob({
      id: jobId,
      worker: 'w1',
      result: {
        entries: [reReport, fresh],
        session: {
          bearer: 'Bearer test-token',
          cookies: '# Netscape\n.peloton\tTRUE\t/\tTRUE\t0\tsid\tx',
          mintedAt: '2026-07-20T11:00:00.000Z',
        },
        telemetry: {
          activities: [
            {
              activity: 'Cycling',
              existing: 1,
              added: 1,
              total: 2,
              scraped: 1,
              skipped: 0,
              scrolls: 5,
            },
          ],
          selectorDriftHits: 0,
          authOk: true,
          loginOk: true,
        },
      },
      projectionRoot: root,
      credentialRoot: credRoot,
      db: t.db,
    });

    // entries MERGED, not wiped: both the pre-existing and the new class are present.
    const rows = await listEntriesForSource(src.id, t.db);
    const byKey = new Map(rows.map((r) => [r.entryKey, r]));
    expect(byKey.size).toBe(2);
    // immutable numbering preserved: "existing" keeps E2026, NOT the re-reported 9999.
    expect(byKey.get('existing')?.episodeNumber).toBe(2026);
    expect(byKey.get('newclass')?.episodeNumber).toBe(2151);

    // session written atomically to the credential dir (relative credentialPath under credRoot).
    const bearer = await readFile(join(credRoot, 'peloton-creds', 'bearer.txt'), 'utf8');
    expect(bearer).toBe('Bearer test-token');
    const cookies = await readFile(join(credRoot, 'peloton-creds', 'cookies.txt'), 'utf8');
    expect(cookies).toContain('Netscape');

    // provider state carries the mint time (the credential-age alarm reads it).
    const session = await createStateStore('peloton', t.db).get<{ mintedAt?: string }>('session');
    expect(session?.mintedAt).toBe('2026-07-20T11:00:00.000Z');

    // library projected (atomic subscriptions.yaml with the entries).
    const subs = parse(
      await readFile(join(root, 'peloton-out', 'subscriptions.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    const preset = subs['Plex TV Show by Date'] as Record<string, Record<string, unknown>>;
    expect(preset['= Cycling (30 min)']).toBeDefined();

    // Run finalized ok with counts + a real summary; job done.
    expect(outcome.status).toBe('ok');
    expect(outcome.merged).toEqual({ added: 1, updated: 1 });
    const run = await getRun(runId, t.db);
    expect(run?.status).toBe('ok');
    expect(run?.counts.emitted).toBe(2);
    expect(run?.summary).not.toBeNull();
    const job = await getJob(jobId, t.db);
    expect(job?.status).toBe('done');

    await rm(root, { recursive: true, force: true });
    await rm(credRoot, { recursive: true, force: true });
  });

  it('ROUTES reported entries to their per-activity source by chip + composes the activity summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ytdrivarr-route-'));
    const lib = await seedLibrary({ projectionPath: 'peloton-routed' });
    const cycling = await seedSource(lib.id, 'cycling');
    const yoga = await seedSource(lib.id, 'yoga');
    await mergeEntriesForSource(cycling.id, [entry('cyc0', 30, 100)], t.db);

    const run = await startRun({ scope: 'library', scopeRef: lib.id, trigger: 'cron', db: t.db });
    const payloads = await buildPelotonDiscoveryPayloads(
      { runId: run.id, sources: [cycling, yoga], library: lib },
      t.db,
    );
    const job = await enqueueDiscoveryJob(payloads[0]!, t.db);
    await claimJob({ worker: 'router', db: t.db });

    const yogaEntry: SubscriptionEntry = {
      entryKey: 'yoga1',
      displayName: '20 min Yoga Flow with Someone yoga1',
      downloadRef: 'https://members.onepeloton.com/classes/player/yoga1',
      preset: 'Plex TV Show by Date',
      chip: 'Yoga (20 min)',
      overrides: {
        season_number: 20,
        episode_number: 7,
        tv_show_directory: '/media/peloton/Yoga/Someone',
      },
    };
    const outcome = await reportJob({
      id: job.id,
      worker: 'router',
      result: {
        entries: [entry('cyc1', 30, 101), yogaEntry],
        // The REAL worker shape: raw perActivity telemetry, no `activities` — the core composes.
        telemetry: {
          perActivity: [
            { activity: 'cycling', linksFound: 40, skippedExisting: 1, scrollsPerformed: 3 },
            { activity: 'yoga', linksFound: 22, skippedExisting: 0, scrollsPerformed: 2 },
          ],
        },
      },
      projectionRoot: root,
      db: t.db,
    });

    // Each entry landed on ITS activity's source (attribution, not the anchor).
    const cyclingRows = await listEntriesForSource(cycling.id, t.db);
    const yogaRows = await listEntriesForSource(yoga.id, t.db);
    expect(cyclingRows.map((r) => r.entryKey).sort()).toEqual(['cyc0', 'cyc1']);
    expect(yogaRows.map((r) => r.entryKey)).toEqual(['yoga1']);
    expect(outcome.merged.added).toBe(2);
    // entries count spans the provider's sources, not just one partition.
    expect(outcome.counts.entries).toBe(3);

    // The composed per-activity Changes rows: core-known existing/added/total/cap + worker scrolls,
    // per-scrape at-cap compared against the effective cap (not the historical total).
    const run2 = await getRun(run.id, t.db);
    const activities = (run2?.summary as { changes?: { activities?: Record<string, unknown>[] } })
      ?.changes?.activities;
    expect(activities).toHaveLength(2);
    const cyclingRow = activities?.find((a) => a.activity === 'Cycling');
    expect(cyclingRow).toMatchObject({ existing: 1, added: 1, total: 2, cap: 25, atCap: false });
    const yogaRow = activities?.find((a) => a.activity === 'Yoga');
    expect(yogaRow).toMatchObject({ existing: 0, added: 1, total: 1, scrolls: 2 });
    // Run attribution: the report leg stamps the provider onto the finalized run.
    expect(run2?.providerId).toBe('peloton');

    await rm(root, { recursive: true, force: true });
  });

  it('an unmonitored sibling stays OUT of the recomposed projection while its entries persist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ytdrivarr-unmon-'));
    const lib = await seedLibrary({ projectionPath: 'peloton-unmon' });
    const cycling = await seedSource(lib.id, 'cycling');
    const yoga = await seedSource(lib.id, 'yoga');
    await mergeEntriesForSource(cycling.id, [entry('cycA', 30, 500)], t.db);
    const { setSourceEnabled } = await import('../domain/sources');
    await setSourceEnabled({ id: cycling.id, enabled: false, db: t.db });

    const run = await startRun({ scope: 'library', scopeRef: lib.id, trigger: 'cron', db: t.db });
    const payloads = await buildPelotonDiscoveryPayloads(
      { runId: run.id, sources: [yoga], allSources: [cycling, yoga], library: lib },
      t.db,
    );
    const job = await enqueueDiscoveryJob(payloads[0]!, t.db);
    await claimJob({ worker: 'w-unmon', db: t.db });
    await reportJob({
      id: job.id,
      worker: 'w-unmon',
      result: { entries: [] },
      projectionRoot: root,
      db: t.db,
    });

    // The projection recompose excluded the unmonitored source's chips…
    const subs = parse(
      await readFile(join(root, 'peloton-unmon', 'subscriptions.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    const preset = subs['Plex TV Show by Date'] as Record<string, unknown>;
    expect(preset['= Cycling (30 min)']).toBeUndefined();
    // …while its entries persist for re-monitoring (the DB keeps the history).
    const kept = await listEntriesForSource(cycling.id, t.db);
    expect(kept.map((r) => r.entryKey)).toEqual(['cycA']);

    await rm(root, { recursive: true, force: true });
  });

  it('rejects a report from a worker that no longer owns the job (409)', async () => {
    const lib = await seedLibrary();
    const src = await seedSource(lib.id);
    const { jobId } = await enqueueForSource(src, lib);
    await claimJob({ worker: 'owner', db: t.db });
    await expect(
      reportJob({ id: jobId, worker: 'intruder', result: { entries: [] }, db: t.db }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
