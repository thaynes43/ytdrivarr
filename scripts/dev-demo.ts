/**
 * Local console-dev harness: boots the API over an EMBEDDED Postgres 16 (the test harness), seeds
 * a small honest dataset through the REST API itself (a library, a few sources, one discovery
 * run), and serves the operator console on http://localhost:3222 with API key `demo-key`.
 *
 * This is a dev loop for the console, not a runtime mode — nothing here ships. Data lives in a
 * temp dir and is discarded on exit.
 *
 * Usage: pnpm build:console && pnpm dev:demo
 */
import { serve } from '@hono/node-server';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootTestDb } from '../src/testing/db';
import { createApp } from '../src/api/app';
import { parseSubscriptionsYaml, deriveMusicEmitPolicy } from '../src/core/import-ytdl-sub';
import { parsePelotonSubscriptions, applyPelotonImport } from '../src/core/import-peloton';
import { logger } from '../src/logger';

const KEY = 'demo-key';
const PORT = 3222;
/** AUTH_MODE=open boots the keyless (LAN) console experience; default demos the api-key gate. */
const OPEN = process.env.AUTH_MODE === 'open';

async function main(): Promise<void> {
  const t = await bootTestDb();
  process.env.DATABASE_URL = t.connectionString;
  const projectionRoot = await mkdtemp(join(tmpdir(), 'ytdrivarr-demo-'));
  const app = createApp({
    apiKeys: [KEY],
    projectionRoot,
    ...(OPEN ? { authMode: 'open' as const } : {}),
  });

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // Seed the console with a realistic M2 dataset: import the estate's live subscriptions.yaml into
  // a video Library + a music Library (the Q-03 override), then run discovery so both families
  // render. Uses the same `youtube` provider + import path the cutover uses.
  const fixture = readFileSync(
    fileURLToPath(
      new URL('../src/testing/fixtures/estate-youtube-subscriptions.yaml', import.meta.url),
    ),
    'utf8',
  );
  const parsed = parseSubscriptionsYaml(fixture);
  const musicPolicy = deriveMusicEmitPolicy(parsed.preset, '/media/youtube-music');

  const videoLib = (await (
    await post('/api/v1/libraries', {
      name: 'YouTube',
      mediaRoot: '/media/youtube',
      libraryKind: 'video',
      presetName: 'Plex TV Show by Date',
      projectionPath: 'youtube',
    })
  ).json()) as { id: string };
  const musicLib = (await (
    await post('/api/v1/libraries', {
      name: 'YouTube Music',
      mediaRoot: '/media/youtube-music',
      libraryKind: 'music',
      presetName: 'YouTube Releases',
      projectionPath: 'youtube-music',
      emitPolicy: musicPolicy,
    })
  ).json()) as { id: string };

  await post('/api/v1/import/ytdl-sub', {
    subscriptionsYaml: fixture,
    videoLibraryId: videoLib.id,
    musicLibraryId: musicLib.id,
    applyPreset: true,
  });

  // The Peloton library at its real grain: the watch-grain import seeds one Source PER ACTIVITY
  // (bookmark-monitored peers of the channels) with all entries attributed by chip.
  const pelotonFixture = readFileSync(
    fileURLToPath(
      new URL('../src/testing/fixtures/estate-peloton-subscriptions.yaml', import.meta.url),
    ),
    'utf8',
  );
  await applyPelotonImport(parsePelotonSubscriptions(pelotonFixture), { apiKeyId: 'demo-seed' });

  // A finalized Peloton run WITH the per-activity Changes/Health summary: enqueue via the real
  // discovery path, then play the worker's claim+report legs (empty scrape = the no-op nightly).
  await post('/api/v1/runs', { scope: 'all', trigger: 'api' });
  const claimed = (await (
    await post('/api/v1/jobs/claim', { worker: 'demo-worker', providerId: 'peloton' })
  ).json()) as { job: { id: string; payload: { peloton: { activities: string[] } } } | null };
  if (claimed.job) {
    const perActivity = claimed.job.payload.peloton.activities.map((activity) => ({
      activity,
      linksFound: 80,
      newEntries: 0,
      skippedExisting: 80,
      scrollsPerformed: 4,
      selectorDrift: false,
      zeroLinks: false,
    }));
    // No session artifacts: the demo pod has no /media volume to deliver a bearer into, and the
    // console renders the "no bearer minted yet" state honestly.
    await post(`/api/v1/jobs/${claimed.job.id}/report`, {
      worker: 'demo-worker',
      result: {
        entries: [],
        telemetry: { perActivity, durationMs: 72000, linksFound: 960 },
      },
    });
  }

  // An in-flight run (queued to the worker) so the console shows a live running row honestly.
  await post('/api/v1/runs', { scope: 'all', trigger: 'api' });

  serve({ fetch: app.fetch, port: PORT }, () => {
    logger.info(
      { port: PORT, apiKey: KEY, projectionRoot },
      'demo console up — open http://localhost:3222 and connect with the demo key',
    );
  });

  const shutdown = (): void => {
    void t.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  logger.error({ err }, 'demo boot failed');
  process.exit(1);
});
