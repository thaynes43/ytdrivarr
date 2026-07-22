import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootTestDb, type TestDb } from '../testing/db';
import { jobs, libraries, providerState, runs, sources } from '../db/schema';
import { createLibrary } from '../domain/libraries';
import { createSource } from '../domain/sources';
import { startRun, finishRun } from '../domain/runs';
import { buildRunSummary, runSummaryToJson } from '../domain/run-summary';
import {
  PELOTON_CREDENTIAL_WARN_SEC,
  PELOTON_CREDENTIAL_ERROR_SEC,
  PELOTON_CREDENTIAL_SLA,
} from '../providers/peloton';
import { createStateStore } from './state-store';
import { collectMetrics, renderExposition, type Metric, type MetricSample } from './metrics';

/**
 * The Prometheus exposition (issue #19 / DESIGN-045 D-10) against embedded Postgres: metric NAMES +
 * LABELS are STABLE and every VALUE comes from a seeded DB — no fabricated numbers. One shared
 * embedded Postgres for the file; a `beforeEach` wipe isolates each case.
 */

function metric(metrics: Metric[], name: string): Metric {
  const m = metrics.find((x) => x.name === name);
  if (!m)
    throw new Error(`metric ${name} not found — have: ${metrics.map((x) => x.name).join(', ')}`);
  return m;
}
function sampleFor(m: Metric, labels: Record<string, string>): MetricSample | undefined {
  return m.samples.find((s) => Object.entries(labels).every(([k, v]) => (s.labels ?? {})[k] === v));
}
function valueFor(metrics: Metric[], name: string, labels: Record<string, string> = {}): number {
  const s = sampleFor(metric(metrics, name), labels);
  if (!s) throw new Error(`no ${name} sample matching ${JSON.stringify(labels)}`);
  return s.value;
}

describe('collectMetrics — the exposition surface', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootTestDb();
    process.env.DATABASE_URL = t.connectionString;
  });
  afterAll(async () => {
    await t.stop();
    delete process.env.DATABASE_URL;
  });
  beforeEach(async () => {
    await t.db.delete(jobs);
    await t.db.delete(runs);
    await t.db.delete(providerState);
    await t.db.delete(sources);
    await t.db.delete(libraries);
  });

  const mintedAgo = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();

  async function seedPelotonLibrary() {
    const lib = await createLibrary({
      name: 'Peloton',
      mediaRoot: '/media/peloton',
      libraryKind: 'video',
      presetName: 'Plex TV Show by Date',
      projectionPath: 'peloton',
      db: t.db,
    });
    const cycling = await createSource({
      libraryId: lib.id,
      providerId: 'peloton',
      kind: 'peloton-scraper',
      mediaKind: 'video',
      displayName: 'Cycling',
      ref: 'cycling',
      settings: {},
      db: t.db,
    });
    const strength = await createSource({
      libraryId: lib.id,
      providerId: 'peloton',
      kind: 'peloton-scraper',
      mediaKind: 'video',
      displayName: 'Strength',
      ref: 'strength',
      settings: { maxClassesPerActivity: 40 },
      enabled: false, // unmonitored — counts toward sources, not sources_monitored
      db: t.db,
    });
    return { lib, cycling, strength };
  }

  async function seedYouTubeLibrary() {
    const lib = await createLibrary({
      name: 'YouTube',
      mediaRoot: '/media/youtube',
      libraryKind: 'video',
      presetName: 'Plex TV Show by Date',
      projectionPath: 'youtube',
      db: t.db,
    });
    await createSource({
      libraryId: lib.id,
      providerId: 'youtube',
      kind: 'youtube-url-list',
      mediaKind: 'video',
      displayName: 'A Channel',
      ref: 'https://www.youtube.com/@test',
      db: t.db,
    });
    return lib;
  }

  it('exposes build_info, up, and one provider_info per registered provider', async () => {
    const m = await collectMetrics({ db: t.db });
    expect(valueFor(m, 'ytdrivarr_up')).toBe(1);
    expect(metric(m, 'ytdrivarr_build_info').samples[0]?.labels).toHaveProperty('node_version');
    const providerInfo = metric(m, 'ytdrivarr_provider_info');
    const ids = providerInfo.samples.map((s) => s.labels?.provider);
    expect(ids).toContain('peloton');
    expect(ids).toContain('youtube');
    expect(sampleFor(providerInfo, { provider: 'peloton' })?.labels?.runtime).toBe(
      'out_of_process',
    );
    expect(valueFor(m, 'ytdrivarr_db_reachable')).toBe(1);
  });

  it('counts sources / monitored / per-activity ledger + cap from live rows', async () => {
    const { cycling } = await seedPelotonLibrary();
    await seedYouTubeLibrary();
    // give cycling three ledger entries so the activity ledger is non-zero.
    await t.db.insert(await import('../db/schema').then((s) => s.subscriptionEntries)).values(
      [1, 2, 3].map((n) => ({
        sourceId: cycling.id,
        entryKey: `c-${n}`,
        displayName: `Class ${n}`,
        downloadRef: `ref-${n}`,
        preset: 'Plex TV Show by Date',
      })),
    );

    const m = await collectMetrics({ db: t.db });
    expect(
      valueFor(m, 'ytdrivarr_sources', {
        provider: 'peloton',
        library: 'Peloton',
        media_kind: 'video',
      }),
    ).toBe(2);
    // one of the two peloton activities is unmonitored (strength).
    expect(
      valueFor(m, 'ytdrivarr_sources_monitored', {
        provider: 'peloton',
        library: 'Peloton',
        media_kind: 'video',
      }),
    ).toBe(1);
    expect(
      valueFor(m, 'ytdrivarr_sources', {
        provider: 'youtube',
        library: 'YouTube',
        media_kind: 'video',
      }),
    ).toBe(1);

    expect(
      valueFor(m, 'ytdrivarr_activity_entries', { provider: 'peloton', activity: 'cycling' }),
    ).toBe(3);
    expect(
      valueFor(m, 'ytdrivarr_activity_cap', { provider: 'peloton', activity: 'cycling' }),
    ).toBe(25);
    expect(
      valueFor(m, 'ytdrivarr_activity_cap', { provider: 'peloton', activity: 'strength' }),
    ).toBe(40);

    expect(
      valueFor(m, 'ytdrivarr_library_entries', { library: 'Peloton', media_kind: 'video' }),
    ).toBe(3);
    expect(
      valueFor(m, 'ytdrivarr_library_entries', { library: 'YouTube', media_kind: 'video' }),
    ).toBe(0);
  });

  it('renders the #2168 per-activity breakdown + last-run counts from a finalized Peloton run', async () => {
    const { cycling } = await seedPelotonLibrary();
    const telemetry = {
      activities: [
        {
          activity: 'Cycling',
          existing: 100,
          added: 5,
          total: 105,
          scraped: 50,
          skipped: 45,
          scrolls: 10,
          cap: 25,
          atCap: false,
          overCap: false,
        },
      ],
      selectorDriftHits: 2,
      scrollsPerformed: 10,
      linksFound: 50,
      malformed: 1,
      loginAttempts: 1,
      bearerAttempts: 1,
      perActivity: [{ activity: 'cycling', scrollCapped: true }],
      maxClassesPerActivity: 25,
    };
    const counts = {
      discovered: 5,
      added: 5,
      removed: 0,
      unchanged: 0,
      deduped: 2,
      emitted: 104,
      windowedOut: 1,
    };
    const summary = buildRunSummary({
      counts,
      telemetry,
      credentialSla: PELOTON_CREDENTIAL_SLA,
    });
    const run = await startRun({
      scope: 'source',
      scopeRef: cycling.id,
      trigger: 'cron',
      providerId: 'peloton',
      db: t.db,
    });
    await finishRun({
      id: run.id,
      status: 'ok',
      counts,
      telemetry,
      summary: runSummaryToJson(summary),
      providerId: 'peloton',
      db: t.db,
    });

    const m = await collectMetrics({ db: t.db });
    // the #2168 per-activity table as gauges (activity label = the summary's activity name).
    expect(
      valueFor(m, 'ytdrivarr_last_run_activity_existing', {
        provider: 'peloton',
        activity: 'Cycling',
      }),
    ).toBe(100);
    expect(
      valueFor(m, 'ytdrivarr_last_run_activity_added', {
        provider: 'peloton',
        activity: 'Cycling',
      }),
    ).toBe(5);
    expect(
      valueFor(m, 'ytdrivarr_last_run_activity_total', {
        provider: 'peloton',
        activity: 'Cycling',
      }),
    ).toBe(105);
    expect(
      valueFor(m, 'ytdrivarr_last_run_activity_cap', { provider: 'peloton', activity: 'Cycling' }),
    ).toBe(25);
    expect(
      valueFor(m, 'ytdrivarr_last_run_activity_scraped', {
        provider: 'peloton',
        activity: 'Cycling',
      }),
    ).toBe(50);

    // run-level last-run snapshot.
    expect(valueFor(m, 'ytdrivarr_last_run_status', { provider: 'peloton' })).toBe(0); // ok
    expect(valueFor(m, 'ytdrivarr_last_run_added', { provider: 'peloton' })).toBe(5);
    expect(valueFor(m, 'ytdrivarr_last_run_emitted', { provider: 'peloton' })).toBe(104);
    expect(valueFor(m, 'ytdrivarr_last_run_selector_drift_hits', { provider: 'peloton' })).toBe(2);
    expect(valueFor(m, 'ytdrivarr_last_run_links_found', { provider: 'peloton' })).toBe(50);
    expect(valueFor(m, 'ytdrivarr_last_run_links_malformed', { provider: 'peloton' })).toBe(1);
    expect(valueFor(m, 'ytdrivarr_last_run_scroll_capped', { provider: 'peloton' })).toBe(1);
  });

  it('sums cumulative counters across runs and buckets unattributed runs under `core`', async () => {
    const { cycling } = await seedPelotonLibrary();
    for (const added of [5, 7]) {
      const run = await startRun({
        scope: 'source',
        scopeRef: cycling.id,
        trigger: 'cron',
        providerId: 'peloton',
        db: t.db,
      });
      await finishRun({
        id: run.id,
        status: 'ok',
        counts: { added, deduped: 1 },
        providerId: 'peloton',
        db: t.db,
      });
    }
    // an unattributed in_core discovery run (YouTube is event-driven, finalized inline) → `core`.
    const coreRun = await startRun({ scope: 'all', trigger: 'api', db: t.db });
    await finishRun({ id: coreRun.id, status: 'ok', counts: { added: 3, emitted: 3 }, db: t.db });

    const m = await collectMetrics({ db: t.db });
    expect(valueFor(m, 'ytdrivarr_entries_added_total', { provider: 'peloton' })).toBe(12);
    expect(valueFor(m, 'ytdrivarr_entries_deduped_total', { provider: 'peloton' })).toBe(2);
    expect(valueFor(m, 'ytdrivarr_runs_total', { provider: 'peloton', status: 'ok' })).toBe(2);
    expect(valueFor(m, 'ytdrivarr_entries_added_total', { provider: 'core' })).toBe(3);
    expect(valueFor(m, 'ytdrivarr_last_run_status', { provider: 'core' })).toBe(0);
  });

  it('surfaces bearer age vs the warn+error SLA gauges + credential status from provider state', async () => {
    await seedPelotonLibrary();
    await createStateStore('peloton', t.db).set('session', {
      mintedAt: mintedAgo(PELOTON_CREDENTIAL_WARN_SEC + 500), // past warn, before error
    });
    const m = await collectMetrics({ db: t.db });
    expect(valueFor(m, 'ytdrivarr_bearer_sla_seconds', { provider: 'peloton' })).toBe(
      PELOTON_CREDENTIAL_WARN_SEC,
    );
    expect(valueFor(m, 'ytdrivarr_bearer_sla_error_seconds', { provider: 'peloton' })).toBe(
      PELOTON_CREDENTIAL_ERROR_SEC,
    );
    expect(
      valueFor(m, 'ytdrivarr_bearer_age_seconds', { provider: 'peloton' }),
    ).toBeGreaterThanOrEqual(PELOTON_CREDENTIAL_WARN_SEC);
    expect(valueFor(m, 'ytdrivarr_credential_age_status', { provider: 'peloton' })).toBe(1); // warn (>= warn SLA)
  });

  it('reads OK for a bearer most of a day old — the nightly-cadence false-alarm fix (issue #23)', async () => {
    await seedPelotonLibrary();
    await createStateStore('peloton', t.db).set('session', {
      mintedAt: mintedAgo(14 * 3600), // 14h — was warn under the old 6h SLA, now ok
    });
    const m = await collectMetrics({ db: t.db });
    expect(valueFor(m, 'ytdrivarr_credential_age_status', { provider: 'peloton' })).toBe(0); // ok
  });

  it('reports job queue depth + worker heartbeat age from the jobs table', async () => {
    await seedPelotonLibrary();
    await t.db.insert(jobs).values({ kind: 'discovery', providerId: 'peloton', status: 'queued' });
    const seen = new Date(Date.now() - 30 * 1000);
    await t.db.insert(jobs).values({
      kind: 'discovery',
      providerId: 'peloton',
      status: 'running',
      claimedBy: 'w1',
      claimedAt: seen,
      heartbeatAt: seen,
      attempts: 2,
    });
    const m = await collectMetrics({ db: t.db });
    expect(valueFor(m, 'ytdrivarr_jobs', { provider: 'peloton', status: 'queued' })).toBe(1);
    expect(valueFor(m, 'ytdrivarr_jobs', { provider: 'peloton', status: 'running' })).toBe(1);
    expect(
      valueFor(m, 'ytdrivarr_worker_heartbeat_age_seconds', { provider: 'peloton' }),
    ).toBeGreaterThanOrEqual(25);
  });

  it('stats projected files for size + last-emit when a projection root is given', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ytdrivarr-proj-'));
    const lib = await createLibrary({
      name: 'Peloton',
      mediaRoot: '/media/peloton',
      libraryKind: 'video',
      presetName: 'Plex TV Show by Date',
      projectionPath: 'peloton',
      db: t.db,
    });
    void lib;
    await mkdir(join(root, 'peloton'), { recursive: true });
    await writeFile(join(root, 'peloton', 'subscriptions.yaml'), 'a: 1\n');
    await writeFile(join(root, 'peloton', 'config.yaml'), 'configuration: {}\n');

    const m = await collectMetrics({ db: t.db, projectionRoot: root });
    expect(
      valueFor(m, 'ytdrivarr_projection_file_size_bytes', {
        library: 'Peloton',
        file: 'subscriptions',
      }),
    ).toBeGreaterThan(0);
    expect(
      valueFor(m, 'ytdrivarr_projection_last_emit_timestamp_seconds', { library: 'Peloton' }),
    ).toBeGreaterThan(0);
  });

  it('renders a valid Prometheus exposition (HELP/TYPE headers, escaped labels, trailing newline)', async () => {
    await seedYouTubeLibrary();
    const run = await startRun({ scope: 'all', trigger: 'api', db: t.db });
    await finishRun({ id: run.id, status: 'ok', counts: { added: 1 }, db: t.db });
    const text = renderExposition(await collectMetrics({ db: t.db }));
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('# HELP ytdrivarr_up ');
    expect(text).toContain('# TYPE ytdrivarr_up gauge');
    expect(text).toMatch(/^ytdrivarr_up 1$/m);
    expect(text).toContain('# TYPE ytdrivarr_runs_total counter');
    // a labelled series renders as name{k="v"} value
    expect(text).toMatch(/ytdrivarr_provider_info\{[^}]*provider="youtube"[^}]*\} 1/);
  });

  it('degrades to up + db_reachable=0 when the database is unreachable', async () => {
    // Point the collector at a dead client — every query rejects and the collector must still
    // return `up` + `db_reachable 0` rather than throw.
    const dead = await import('../db').then((mod) => mod.createDb('postgres://127.0.0.1:1/none'));
    dead.pool.on('error', () => {}); // swallow idle-client errors from the refused connection
    const metrics = await collectMetrics({ db: dead.db });
    await dead.pool.end().catch(() => {});
    expect(valueFor(metrics, 'ytdrivarr_up')).toBe(1);
    expect(valueFor(metrics, 'ytdrivarr_db_reachable')).toBe(0);
  });
});
