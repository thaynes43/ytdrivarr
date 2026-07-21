import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestDb, type TestDb } from '../testing/db';
import { createLibrary } from '../domain/libraries';
import { createSource } from '../domain/sources';
import { startRun, finishRun } from '../domain/runs';
import { createStateStore } from './state-store';
import { collectHealth, credentialAgeAlarm } from './health';

/** Health alarms (DESIGN-045 D-10): the credential-age policy (pure thresholds) + the collectHealth
 * enrichment surfacing credential age + selector drift per source. */

describe('credentialAgeAlarm — the threshold policy', () => {
  const mintedAgo = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();

  it('is ok below the SLA, warns at 1×, errors at 2×', () => {
    expect(credentialAgeAlarm(mintedAgo(100), 21600).status).toBe('ok');
    expect(credentialAgeAlarm(mintedAgo(21600), 21600).status).toBe('warn');
    expect(credentialAgeAlarm(mintedAgo(43300), 21600).status).toBe('error');
  });

  it('reports the computed age', () => {
    const alarm = credentialAgeAlarm(mintedAgo(500), 21600);
    expect(alarm.ageSec).toBeGreaterThanOrEqual(499);
    expect(alarm.ageSec).toBeLessThanOrEqual(510);
  });
});

describe('collectHealth — per-source alarm enrichment', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootTestDb();
    process.env.DATABASE_URL = t.connectionString;
  });
  afterAll(async () => {
    await t.stop();
    delete process.env.DATABASE_URL;
  });

  it('surfaces the credential age for a Peloton source with a minted session', async () => {
    const lib = await createLibrary({
      name: 'Peloton',
      mediaRoot: '/media/peloton',
      libraryKind: 'video',
      presetName: 'Plex TV Show by Date',
      projectionPath: 'peloton',
      db: t.db,
    });
    const src = await createSource({
      libraryId: lib.id,
      providerId: 'peloton',
      kind: 'peloton-scraper',
      mediaKind: 'video',
      displayName: 'Peloton',
      ref: 'peloton',
      settings: { activities: ['cycling'] },
      db: t.db,
    });
    // a session minted ~50000s ago (> the 21600s SLA → the age is surfaced as an alarm signal).
    await createStateStore('peloton', t.db).set('session', {
      mintedAt: new Date(Date.now() - 50000 * 1000).toISOString(),
    });

    const health = await collectHealth(t.db);
    const sh = health.sources.find((s) => s.sourceId === src.id);
    expect(sh?.credentialAgeSec).toBeGreaterThanOrEqual(49000);
  });

  it('raises a selector-drift WARN from the last run telemetry', async () => {
    const lib = await createLibrary({
      name: 'YouTube',
      mediaRoot: '/media/youtube',
      libraryKind: 'video',
      presetName: 'Plex TV Show by Date',
      projectionPath: 'youtube',
      db: t.db,
    });
    const src = await createSource({
      libraryId: lib.id,
      providerId: 'youtube',
      kind: 'youtube-url-list',
      mediaKind: 'video',
      displayName: 'A Channel',
      ref: 'https://www.youtube.com/@test',
      db: t.db,
    });
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
  });
});
