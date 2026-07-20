import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Hono } from 'hono';
import { bootTestDb, type TestDb } from '../testing/db';
import { getDefaultPool } from '../db';
import { createApp } from './app';

/**
 * The M1 walking-skeleton PROOF (DESIGN-045 D-19 M1): create a Library + a couple of Sources via the
 * REST API → discovery run → entries → rendered YAML → ATOMIC projection to a temp dir. Exercises
 * C1/C3/C5 with no auth, end to end, over embedded Postgres.
 */
const KEY = 'e2e-key';
const auth = { 'x-api-key': KEY, 'content-type': 'application/json' };

let t: TestDb;
let app: Hono;
let projectionRoot: string;

beforeAll(async () => {
  t = await bootTestDb();
  // The API handlers use the lazy default db bound to DATABASE_URL (the real runtime path).
  process.env.DATABASE_URL = t.connectionString;
  projectionRoot = await mkdtemp(join(tmpdir(), 'ytdrivarr-e2e-'));
  app = createApp({ apiKeys: [KEY], projectionRoot });
});

afterAll(async () => {
  // The API handlers used the lazy default pool (bound to DATABASE_URL); close it before the
  // embedded server stops, or its open connections get terminated as an unhandled error.
  try {
    await getDefaultPool().end();
  } catch {
    // never initialized — nothing to close
  }
  await t.stop();
  await rm(projectionRoot, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
});

async function post(path: string, body: unknown) {
  return app.request(path, { method: 'POST', headers: auth, body: JSON.stringify(body) });
}

describe('M1 end-to-end: library → sources → run → projection', () => {
  it('projects both channels into an atomically written subscriptions.yaml', async () => {
    // 1) Create a video Library projected to <root>/youtube.
    const libRes = await post('/api/v1/libraries', {
      name: 'YouTube',
      mediaRoot: '/media/youtube',
      libraryKind: 'video',
      presetName: 'Plex TV Show by Date',
      projectionPath: 'youtube',
      emitPolicy: { overrides: { tv_show_directory: '/media/youtube' } },
    });
    expect(libRes.status).toBe(201);
    const library = (await libRes.json()) as { id: string };

    // 2) Add a couple of Sources (the trivial in_core URL-list provider, no auth).
    const s1 = await post('/api/v1/sources', {
      libraryId: library.id,
      providerId: 'in-core-url-list',
      kind: 'url-list',
      mediaKind: 'video',
      displayName: 'Alex Meyers',
      ref: 'https://www.youtube.com/@AlexMeyersVids',
      settings: { chip: 'Animation' },
    });
    expect(s1.status).toBe(201);
    const source1 = (await s1.json()) as { id: string };

    const s2 = await post('/api/v1/sources', {
      libraryId: library.id,
      providerId: 'in-core-url-list',
      kind: 'url-list',
      mediaKind: 'video',
      displayName: 'Defunctland',
      ref: 'https://www.youtube.com/@Defunctland',
      settings: { chip: 'Documentaries' },
    });
    expect(s2.status).toBe(201);

    // 3) Trigger a discovery run.
    const runRes = await post('/api/v1/runs', { scope: 'all' });
    expect(runRes.status).toBe(201);
    const outcome = (await runRes.json()) as {
      status: string;
      counts: Record<string, number>;
      projected: { libraryId: string; dir: string }[];
    };
    expect(outcome.status).toBe('ok');
    expect(outcome.counts.sources).toBe(2);
    expect(outcome.counts.emitted).toBe(2);
    expect(outcome.projected).toHaveLength(1);

    // 4) The projected files exist and carry both channels under their genre chips.
    const subsPath = join(projectionRoot, 'youtube', 'subscriptions.yaml');
    const configPath = join(projectionRoot, 'youtube', 'config.yaml');
    const subs = parse(await readFile(subsPath, 'utf8')) as Record<
      string,
      Record<string, Record<string, string>>
    >;
    const config = parse(await readFile(configPath, 'utf8')) as {
      configuration: { working_directory: string };
    };
    expect(config.configuration.working_directory).toBe('/workdir/');
    const preset = subs['Plex TV Show by Date'];
    expect(preset?.['= Animation']?.['Alex Meyers']).toBe(
      'https://www.youtube.com/@AlexMeyersVids',
    );
    expect(preset?.['= Documentaries']?.['Defunctland']).toBe(
      'https://www.youtube.com/@Defunctland',
    );

    // 5) Entries were persisted (C3/C5) and are readable per source.
    const entriesRes = await app.request(`/api/v1/sources/${source1.id}/entries`, {
      headers: { 'x-api-key': KEY },
    });
    expect(entriesRes.status).toBe(200);
    const entries = (await entriesRes.json()) as unknown[];
    expect(entries).toHaveLength(1);

    // 6) The run is retrievable and healthy.
    const runsRes = await app.request('/api/v1/runs', { headers: { 'x-api-key': KEY } });
    const runs = (await runsRes.json()) as { status: string }[];
    expect(runs[0]?.status).toBe('ok');
  });

  it('rejects an unauthenticated write', async () => {
    const res = await app.request('/api/v1/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
