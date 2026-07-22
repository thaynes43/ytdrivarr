import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootTestDb, type TestDb } from '../testing/db';
import { jobs, libraries, providerState, runs, sources } from '../db/schema';
import { createLibrary } from '../domain/libraries';
import { createSource } from '../domain/sources';
import { startRun, finishRun } from '../domain/runs';
import {
  PELOTON_CREDENTIAL_WARN_SEC,
  PELOTON_CREDENTIAL_ERROR_SEC,
  PELOTON_CREDENTIAL_SLA,
} from '../providers/peloton';
import { createStateStore } from './state-store';
import { collectHealth, credentialAgeAlarm } from './health';

/** Health alarms (DESIGN-045 D-10): the credential-age policy (pure thresholds) + the collectHealth
 * enrichment surfacing credential age + selector drift per source. */

describe('credentialAgeAlarm — the threshold policy (issue #23: nightly-mint cadence)', () => {
  const mintedAgo = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
  const H = 3600;

  it('is ok when fresh, warns past the warn edge (a missed nightly), errors past the error edge', () => {
    // The Peloton default SLA: warn 30h (108000s), error 52h (187200s).
    expect(credentialAgeAlarm(mintedAgo(14 * H), PELOTON_CREDENTIAL_SLA).status).toBe('ok'); // a normal afternoon
    expect(credentialAgeAlarm(mintedAgo(31 * H), PELOTON_CREDENTIAL_SLA).status).toBe('warn'); // a missed nightly
    expect(credentialAgeAlarm(mintedAgo(53 * H), PELOTON_CREDENTIAL_SLA).status).toBe('error'); // approaching real expiry
  });

  it('honors an explicit warn/error SLA pair independently of any 1×/2× multiplier', () => {
    const sla = { warnSec: 108000, errorSec: 187200 };
    expect(credentialAgeAlarm(mintedAgo(107999), sla).status).toBe('ok');
    expect(credentialAgeAlarm(mintedAgo(108001), sla).status).toBe('warn');
    expect(credentialAgeAlarm(mintedAgo(187201), sla).status).toBe('error');
  });

  it('reports the computed age', () => {
    const alarm = credentialAgeAlarm(mintedAgo(500), PELOTON_CREDENTIAL_SLA);
    expect(alarm.ageSec).toBeGreaterThanOrEqual(499);
    expect(alarm.ageSec).toBeLessThanOrEqual(510);
  });
});

/**
 * collectHealth against embedded Postgres — the in_core PROBE enrichment (credential-age +
 * selector-drift) AND the out_of_process OBSERVED model (DESIGN-045 D-03/D-05/D-10, the false-alarm
 * fix). A Peloton (`out_of_process`) provider's credentials live only in its worker; the core never
 * holds them, so its health is derived from OBSERVED state (last run + bearer freshness + worker
 * liveness), NEVER from a core-side `test()` that would false-alarm on "missing credentials". One
 * shared embedded Postgres for the whole file (no extra boots); a `beforeEach` wipe isolates each
 * case so both per-source and overall status can be asserted.
 */
describe('collectHealth — per-source health models', () => {
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
    // clean slate (a .test.ts file may write sources directly — the D-08 guard skips test files).
    await t.db.delete(jobs);
    await t.db.delete(runs);
    await t.db.delete(providerState);
    await t.db.delete(sources);
    await t.db.delete(libraries);
  });

  const mintedAgo = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();

  async function seedPeloton() {
    const lib = await createLibrary({
      name: 'Peloton',
      mediaRoot: '/media/peloton',
      libraryKind: 'video',
      presetName: 'Plex TV Show by Date',
      projectionPath: 'peloton',
      db: t.db,
    });
    return createSource({
      libraryId: lib.id,
      providerId: 'peloton',
      kind: 'peloton-scraper',
      mediaKind: 'video',
      displayName: 'Peloton',
      ref: 'peloton',
      settings: { activities: ['cycling'] },
      db: t.db,
    });
  }
  async function seedYouTube() {
    const lib = await createLibrary({
      name: 'YouTube',
      mediaRoot: '/media/youtube',
      libraryKind: 'video',
      presetName: 'Plex TV Show by Date',
      projectionPath: 'youtube',
      db: t.db,
    });
    return createSource({
      libraryId: lib.id,
      providerId: 'youtube',
      kind: 'youtube-url-list',
      mediaKind: 'video',
      displayName: 'A Channel',
      ref: 'https://www.youtube.com/@test',
      db: t.db,
    });
  }
  const setSession = (sec: number) =>
    createStateStore('peloton', t.db).set('session', { mintedAt: mintedAgo(sec) });
  async function okRun(srcId: string) {
    const r = await startRun({
      scope: 'source',
      scopeRef: srcId,
      trigger: 'cron',
      providerId: 'peloton',
      db: t.db,
    });
    await finishRun({ id: r.id, status: 'ok', counts: { added: 199 }, db: t.db });
  }

  // --- in_core PROBE model (unchanged) --------------------------------------------------------

  it('surfaces the credential age for a Peloton source with a minted session', async () => {
    const src = await seedPeloton();
    // a session minted ~50000s ago — the age is surfaced on the source health regardless of status.
    await setSession(50000);
    const health = await collectHealth(t.db);
    const sh = health.sources.find((s) => s.sourceId === src.id);
    expect(sh?.credentialAgeSec).toBeGreaterThanOrEqual(49000);
  });

  it('raises a selector-drift WARN from the last run telemetry (in_core probe model)', async () => {
    const src = await seedYouTube();
    const run = await startRun({
      scope: 'source',
      scopeRef: src.id,
      trigger: 'cron',
      providerId: 'youtube',
      db: t.db,
    });
    await finishRun({ id: run.id, status: 'warn', telemetry: { selectorDriftHits: 3 }, db: t.db });

    const health = await collectHealth(t.db);
    const sh = health.sources.find((s) => s.sourceId === src.id);
    expect(sh?.selectorDriftHits).toBe(3);
    expect(sh?.status).toBe('warn'); // youtube test() is ok; the drift alarm escalates it to warn
    expect(sh?.healthModel).toBe('probe'); // in_core provider → the unchanged probe model
  });

  // --- out_of_process OBSERVED model (the false-alarm fix) ------------------------------------

  it('is ok with a fresh bearer + an ok run — and NEVER core-side-fails on missing worker creds', async () => {
    const src = await seedPeloton();
    await setSession(100); // fresh — well within the warn SLA
    await okRun(src.id);

    const health = await collectHealth(t.db);
    const sh = health.sources.find((s) => s.sourceId === src.id);
    expect(sh?.healthModel).toBe('observed');
    expect(sh?.status).toBe('ok');
    expect(health.status).toBe('ok');
    expect(sh?.lastRunStatus).toBe('ok');
    expect(sh?.bearerMintedAt).toBeTruthy();
    // the defect: the core-side test() would have said this — it must NOT surface here.
    expect(sh?.message ?? '').not.toMatch(/missing/i);
  });

  it('NEVER core-side-fails on missing worker env: no creds + no bearer + no run is warn, not error', async () => {
    const src = await seedPeloton(); // ctx.secrets is always {} in-core; no session, no run
    const health = await collectHealth(t.db);
    const sh = health.sources.find((s) => s.sourceId === src.id);
    expect(sh?.status).not.toBe('error');
    expect(sh?.status).toBe('warn'); // pre-first-run, honestly visible
    expect(sh?.message ?? '').not.toMatch(/missing.*credential/i);
  });

  it('warns on a bearer aged past the warn SLA — a missed nightly (with an otherwise-ok run)', async () => {
    const src = await seedPeloton();
    await setSession(PELOTON_CREDENTIAL_WARN_SEC + 100); // ≥ warn, < error
    await okRun(src.id);
    const health = await collectHealth(t.db);
    const sh = health.sources.find((s) => s.sourceId === src.id);
    expect(sh?.status).toBe('warn');
    expect(sh?.credentialAgeSec).toBeGreaterThanOrEqual(PELOTON_CREDENTIAL_WARN_SEC);
  });

  it('errors on a bearer aged past the error SLA — approaching real expiry', async () => {
    const src = await seedPeloton();
    await setSession(PELOTON_CREDENTIAL_ERROR_SEC + 100);
    await okRun(src.id);
    const health = await collectHealth(t.db);
    const sh = health.sources.find((s) => s.sourceId === src.id);
    expect(sh?.status).toBe('error');
  });

  it('is ok on a bearer most of a day old — the false-alarm the nightly-cadence tune fixes', async () => {
    const src = await seedPeloton();
    await setSession(14 * 3600); // 14h old — a perfectly healthy afternoon, was RED under the old 6h SLA
    await okRun(src.id);
    const health = await collectHealth(t.db);
    const sh = health.sources.find((s) => s.sourceId === src.id);
    expect(sh?.status).toBe('ok');
  });

  it('errors when the last run failed with alarms (a worker-side failure surfaces honestly)', async () => {
    const src = await seedPeloton();
    await setSession(100); // bearer FRESH — the error must come from the failed run, not creds
    const r = await startRun({
      scope: 'source',
      scopeRef: src.id,
      trigger: 'cron',
      providerId: 'peloton',
      db: t.db,
    });
    await finishRun({
      id: r.id,
      status: 'error',
      telemetry: { alarms: [{ kind: 'login', message: 'bad_credentials' }], loginFailures: 3 },
      db: t.db,
    });
    const health = await collectHealth(t.db);
    const sh = health.sources.find((s) => s.sourceId === src.id);
    expect(sh?.status).toBe('error');
    expect(sh?.lastRunStatus).toBe('error');
    expect(sh?.message ?? '').toContain('login');
  });

  it('warns on worker liveness: an in-flight job whose heartbeat lapsed past the reclaim SLA', async () => {
    const src = await seedPeloton();
    await setSession(100);
    await okRun(src.id);
    // a job still `running` but whose last heartbeat is well past DEFAULT_HEARTBEAT_EXPIRY_SEC (120s).
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await t.db.insert(jobs).values({
      kind: 'discovery',
      providerId: 'peloton',
      status: 'running',
      claimedBy: 'w-dead',
      claimedAt: stale,
      heartbeatAt: stale,
    });
    const health = await collectHealth(t.db);
    const sh = health.sources.find((s) => s.sourceId === src.id);
    expect(sh?.status).toBe('warn');
    expect(sh?.message ?? '').toMatch(/worker heartbeat stale/);
    expect(sh?.workerLastSeenSec).toBeGreaterThanOrEqual(590);
  });
});
