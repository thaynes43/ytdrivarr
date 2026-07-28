import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { bootTestDb, type TestDb } from '../testing/db';
import { jobs, type Library } from '../db/schema';
import { createLibrary } from '../domain/libraries';
import { createSource } from '../domain/sources';
import { getRun } from '../domain/runs';
import { listEntriesForSource } from '../domain/entries';
import { runDiscovery } from './discovery';
import { ValidationError } from '../errors';

/**
 * Provider-SCOPED discovery (the per-provider scheduled cron tick). The core guarantee: a
 * `scope:'provider'` tick discovers ONLY that provider's sources — a YouTube safety re-emit must
 * never aggregate Peloton sources into a scrape job (the daily-double-login account-risk bug), while
 * `scope:'all'` (manual/API) still covers every provider. Run against embedded Postgres so the
 * enqueue/aggregate seam (out_of_process Peloton) is exercised end to end. A fresh DB per test keeps
 * the scope='all'/'provider' library walk (which spans every Library) deterministic.
 */
let t: TestDb;
let projectionRoot: string;

async function seedVideoLibrary(slug: string): Promise<Library> {
  return createLibrary({
    name: `Video ${slug}`,
    mediaRoot: '/media/youtube',
    libraryKind: 'video',
    presetName: 'Plex TV Show by Date',
    projectionPath: `video-${slug}`,
    emitPolicy: { overrides: { tv_show_directory: '/media/youtube' } },
    db: t.db,
  });
}

async function seedYoutubeSource(libraryId: string) {
  return createSource({
    libraryId,
    providerId: 'youtube',
    kind: 'youtube-url-list',
    mediaKind: 'video',
    displayName: 'Test Channel',
    ref: '@TestChannel',
    settings: { chip: 'Animation' },
    db: t.db,
  });
}

async function seedPelotonSource(libraryId: string, slug: string) {
  return createSource({
    libraryId,
    providerId: 'peloton',
    kind: 'peloton-scraper',
    mediaKind: 'video',
    displayName: slug[0]!.toUpperCase() + slug.slice(1),
    ref: slug,
    settings: {},
    db: t.db,
  });
}

async function jobsForRun(runId: string) {
  return t.db.select().from(jobs).where(eq(jobs.runId, runId));
}

beforeEach(async () => {
  t = await bootTestDb();
  process.env.DATABASE_URL = t.connectionString;
  projectionRoot = await mkdtemp(join(tmpdir(), 'ytdrivarr-discovery-'));
});

afterEach(async () => {
  await t.stop();
  await rm(projectionRoot, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
});

describe('runDiscovery — provider scope', () => {
  it('a YouTube tick discovers only YouTube and enqueues NO Peloton scrape job', async () => {
    const lib = await seedVideoLibrary('yt-tick');
    const youtube = await seedYoutubeSource(lib.id);
    const cycling = await seedPelotonSource(lib.id, 'cycling');
    const yoga = await seedPelotonSource(lib.id, 'yoga');

    const outcome = await runDiscovery({
      scope: 'provider',
      providerId: 'youtube',
      trigger: 'cron',
      projectionRoot,
      db: t.db,
    });

    // in_core-only: finalized inline as ok, nothing queued to the worker.
    expect(outcome.status).toBe('ok');
    expect(outcome.counts.queued).toBe(0);

    // THE bug guard: a YouTube tick enqueues ZERO Peloton (out_of_process) scrape jobs.
    expect(await jobsForRun(outcome.runId)).toHaveLength(0);

    // Only the YouTube source was discovered; the Peloton sources were untouched.
    expect(await listEntriesForSource(youtube.id, t.db)).toHaveLength(1);
    expect(await listEntriesForSource(cycling.id, t.db)).toHaveLength(0);
    expect(await listEntriesForSource(yoga.id, t.db)).toHaveLength(0);

    // Honest provenance: the Run reflects scope=provider + providerId=youtube (NOT peloton, NOT all).
    const run = await getRun(outcome.runId, t.db);
    expect(run?.scope).toBe('provider');
    expect(run?.providerId).toBe('youtube');
    expect(run?.status).toBe('ok');
  });

  it('a Peloton tick enqueues the Peloton scrape and leaves the Run running, attributed to peloton', async () => {
    const lib = await seedVideoLibrary('pel-tick');
    const youtube = await seedYoutubeSource(lib.id);
    await seedPelotonSource(lib.id, 'cycling');
    await seedPelotonSource(lib.id, 'yoga');

    const outcome = await runDiscovery({
      scope: 'provider',
      providerId: 'peloton',
      trigger: 'cron',
      projectionRoot,
      db: t.db,
    });

    // An out_of_process job is queued → the Run stays running (the worker report finalizes it).
    expect(outcome.status).toBe('running');
    expect(outcome.counts.queued).toBe(1);

    // Exactly one aggregated Peloton discovery job, attributed to peloton.
    const enqueued = await jobsForRun(outcome.runId);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe('discovery');
    expect(enqueued[0]!.providerId).toBe('peloton');

    // The Peloton tick did NOT discover the YouTube source (it's the other provider).
    expect(await listEntriesForSource(youtube.id, t.db)).toHaveLength(0);

    const run = await getRun(outcome.runId, t.db);
    expect(run?.scope).toBe('provider');
    expect(run?.providerId).toBe('peloton');
    expect(run?.status).toBe('running');
  });

  it("scope='all' still covers every provider — YouTube discovered AND the Peloton scrape enqueued", async () => {
    const lib = await seedVideoLibrary('all-scope');
    const youtube = await seedYoutubeSource(lib.id);
    await seedPelotonSource(lib.id, 'cycling');

    const outcome = await runDiscovery({
      scope: 'all',
      trigger: 'api',
      projectionRoot,
      db: t.db,
    });

    // The Peloton leg queues a job → the Run runs; the in_core YouTube leg already persisted.
    expect(outcome.status).toBe('running');
    expect(outcome.counts.queued).toBe(1);
    expect(await listEntriesForSource(youtube.id, t.db)).toHaveLength(1);

    const enqueued = await jobsForRun(outcome.runId);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.providerId).toBe('peloton');
  });

  it('rejects a provider scope with no providerId, and an unknown provider', async () => {
    await expect(
      runDiscovery({ scope: 'provider', trigger: 'cron', db: t.db }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      runDiscovery({ scope: 'provider', providerId: 'nope', trigger: 'cron', db: t.db }),
    ).rejects.toThrow(/unknown provider/i);
  });
});
