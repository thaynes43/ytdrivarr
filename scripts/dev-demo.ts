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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootTestDb } from '../src/testing/db';
import { createApp } from '../src/api/app';
import { logger } from '../src/logger';

const KEY = 'demo-key';
const PORT = 3222;

async function main(): Promise<void> {
  const t = await bootTestDb();
  process.env.DATABASE_URL = t.connectionString;
  const projectionRoot = await mkdtemp(join(tmpdir(), 'ytdrivarr-demo-'));
  const app = createApp({ apiKeys: [KEY], projectionRoot });

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const libRes = await post('/api/v1/libraries', {
    name: 'YouTube',
    mediaRoot: '/media/youtube',
    libraryKind: 'video',
    presetName: 'Plex TV Show by Date',
    projectionPath: 'youtube',
    emitPolicy: { overrides: { tv_show_directory: '/media/youtube' } },
  });
  const library = (await libRes.json()) as { id: string };

  const sources = [
    {
      displayName: 'Alex Meyers',
      ref: 'https://www.youtube.com/@AlexMeyersVids',
      chip: 'Animation',
    },
    {
      displayName: 'Defunctland',
      ref: 'https://www.youtube.com/@Defunctland',
      chip: 'Documentaries',
    },
    {
      displayName: 'Technology Connections',
      ref: 'https://www.youtube.com/@TechnologyConnections',
      chip: 'Technology',
    },
  ];
  for (const s of sources) {
    await post('/api/v1/sources', {
      libraryId: library.id,
      providerId: 'in-core-url-list',
      kind: 'url-list',
      mediaKind: 'video',
      displayName: s.displayName,
      ref: s.ref,
      settings: { chip: s.chip },
    });
  }
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
