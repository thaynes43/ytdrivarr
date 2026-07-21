import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Hono } from 'hono';
import { bootTestDb, type TestDb } from '../testing/db';
import { getDefaultPool } from '../db';
import { createApp } from './app';
import { parseSubscriptionsYaml, deriveMusicEmitPolicy } from '../core/import-ytdl-sub';

/**
 * The M2 PROOF (DESIGN-045 D-19 M2, the Q-03 override): import the estate's LIVE subscriptions.yaml
 * → a video Library + a music Library each render and project their own family atomically. The
 * video output matches the estate's live YAML by SHAPE minus the `= Music` section (the diff gate
 * the cutover runbook automates); the music output is a correct `YouTube Releases` file. Re-import
 * is idempotent — no duplicates, the `= Music` channels relocate cleanly.
 */
const KEY = 'm2-key';
const auth = { 'x-api-key': KEY, 'content-type': 'application/json' };

const fixture = readFileSync(
  fileURLToPath(new URL('../testing/fixtures/estate-youtube-subscriptions.yaml', import.meta.url)),
  'utf8',
);

let t: TestDb;
let app: Hono;
let root: string;
let videoLibraryId: string;
let musicLibraryId: string;

async function post(path: string, body: unknown) {
  return app.request(path, { method: 'POST', headers: auth, body: JSON.stringify(body) });
}
async function get(path: string) {
  return app.request(path, { headers: { 'x-api-key': KEY } });
}
async function readSubs(dir: string): Promise<Record<string, unknown>> {
  return parse(await readFile(join(root, dir, 'subscriptions.yaml'), 'utf8')) as Record<
    string,
    unknown
  >;
}

beforeAll(async () => {
  t = await bootTestDb();
  process.env.DATABASE_URL = t.connectionString;
  root = await mkdtemp(join(tmpdir(), 'ytdrivarr-m2-'));
  app = createApp({ apiKeys: [KEY], projectionRoot: root });

  const parsed = parseSubscriptionsYaml(fixture);
  const musicPolicy = deriveMusicEmitPolicy(parsed.preset, '/media/youtube-music');

  const videoRes = await post('/api/v1/libraries', {
    name: 'YouTube',
    mediaRoot: '/media/youtube',
    libraryKind: 'video',
    presetName: 'Plex TV Show by Date',
    projectionPath: 'youtube',
  });
  videoLibraryId = ((await videoRes.json()) as { id: string }).id;

  const musicRes = await post('/api/v1/libraries', {
    name: 'YouTube Music',
    mediaRoot: '/media/youtube-music',
    libraryKind: 'music',
    presetName: 'YouTube Releases',
    projectionPath: 'youtube-music',
    emitPolicy: musicPolicy,
  });
  musicLibraryId = ((await musicRes.json()) as { id: string }).id;
});

afterAll(async () => {
  try {
    await getDefaultPool().end();
  } catch {
    // never initialized
  }
  await t.stop();
  await rm(root, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
});

describe('M2: two-library import → emission → projection', () => {
  it('imports the estate file media-kind-aware and applies the video __preset__', async () => {
    const res = await post('/api/v1/import/ytdl-sub', {
      subscriptionsYaml: fixture,
      videoLibraryId,
      musicLibraryId,
      applyPreset: true,
    });
    expect(res.status).toBe(201);
    const summary = (await res.json()) as {
      channels: number;
      video: number;
      music: number;
      created: number;
      presetApplied: boolean;
    };
    expect(summary.channels).toBe(73);
    expect(summary.video).toBe(68);
    expect(summary.music).toBe(5);
    expect(summary.created).toBe(73);
    expect(summary.presetApplied).toBe(true);
  });

  it('projects the VIDEO library matching the estate YAML shape minus the = Music section', async () => {
    const runRes = await post('/api/v1/runs', { scope: 'all' });
    expect(runRes.status).toBe(201);

    const rendered = await readSubs('youtube');
    const estate = parse(fixture) as Record<string, unknown>;

    // __preset__ block byte-for-shape (throttle, only-recent, cookiefile) — applyPreset set it.
    expect(rendered.__preset__).toEqual(estate.__preset__);

    // The preset block equals the estate's MINUS the relocated `= Music` group — the diff gate.
    const expectedVideo = { ...(estate['Plex TV Show by Date'] as Record<string, unknown>) };
    delete expectedVideo['= Music'];
    expect(rendered['Plex TV Show by Date']).toEqual(expectedVideo);

    // The video file must NOT carry the music channels or a music preset.
    expect(
      (rendered['Plex TV Show by Date'] as Record<string, unknown>)['= Music'],
    ).toBeUndefined();
    expect(rendered['YouTube Releases']).toBeUndefined();
    const yaml = await readFile(join(root, 'youtube', 'subscriptions.yaml'), 'utf8');
    expect(yaml).not.toContain('Taylor Swift');
  });

  it('projects the MUSIC library as a correct YouTube Releases family file', async () => {
    const rendered = await readSubs('youtube-music');
    expect(rendered['YouTube Releases']).toBeDefined();
    expect(rendered['Plex TV Show by Date']).toBeUndefined();

    // Music channels render ungrouped (the library IS the grouping — no `= Genre` chip).
    const preset = rendered['YouTube Releases'] as Record<string, unknown>;
    expect(preset['Taylor Swift']).toBe('https://www.youtube.com/@TaylorSwift');
    expect(preset['Daft Punk']).toBe('https://www.youtube.com/@daftpunk');
    expect(Object.keys(preset)).toHaveLength(5);
    expect(Object.keys(preset).some((k) => k.startsWith('= '))).toBe(false);

    // The music __preset__ carries music_directory, no tv_show_directory / only_recent.
    const musicPreset = rendered.__preset__ as { overrides: Record<string, unknown> };
    expect(musicPreset.overrides.music_directory).toBe('/media/youtube-music');
    expect(musicPreset.overrides.tv_show_directory).toBeUndefined();
    expect(musicPreset.overrides.only_recent_date_range).toBeUndefined();
  });

  it('renders genre grouping faithfully in the video library', async () => {
    const rendered = await readSubs('youtube');
    const preset = rendered['Plex TV Show by Date'] as Record<string, Record<string, unknown>>;
    expect(preset['= Animation']?.['Alex Meyers']).toBe('https://www.youtube.com/@AlexMeyersVids');
    expect(preset['= Tech Vlogs']?.['Linus Tech Tips']).toBe(
      'https://www.youtube.com/@LinusTechTips',
    );
    // the estate's literal-quoted chip key (`= "Tech - Official"`) survives a parse round-trip
    expect(preset['= "Tech - Official"']?.['Home Assistant']).toBe(
      'https://www.youtube.com/@home_assistant',
    );
  });

  it('is idempotent — a re-import creates no duplicates and relocates nothing new', async () => {
    const before = ((await (await get('/api/v1/sources')).json()) as unknown[]).length;
    expect(before).toBe(73);

    const res = await post('/api/v1/import/ytdl-sub', {
      subscriptionsYaml: fixture,
      videoLibraryId,
      musicLibraryId,
      applyPreset: true,
    });
    const summary = (await res.json()) as { created: number; updated: number; unchanged: number };
    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.unchanged).toBe(73);

    const after = ((await (await get('/api/v1/sources')).json()) as unknown[]).length;
    expect(after).toBe(73);
  });

  it('re-classifies a channel when its chip moves (video → music) on re-import', async () => {
    // A hand-edited file that MOVES "Vivziepop" from the Animation chip to the Music chip.
    const edited = fixture
      .replace('      "Vivziepop": "https://www.youtube.com/@SpindleHorse"\n', '')
      .replace(
        '    = Music:\n',
        '    = Music:\n      "Vivziepop": "https://www.youtube.com/@SpindleHorse"\n',
      );
    const res = await post('/api/v1/import/ytdl-sub', {
      subscriptionsYaml: edited,
      videoLibraryId,
      musicLibraryId,
    });
    const summary = (await res.json()) as { updated: number; sources: { ref: string }[] };
    expect(summary.updated).toBe(1);

    const sources = (await (await get('/api/v1/sources')).json()) as {
      ref: string;
      mediaKind: string;
      libraryId: string;
    }[];
    const vivzie = sources.find((s) => s.ref === 'https://www.youtube.com/@SpindleHorse');
    expect(vivzie?.mediaKind).toBe('music');
    expect(vivzie?.libraryId).toBe(musicLibraryId);
    // still no duplicate rows
    expect(sources.filter((s) => s.ref === 'https://www.youtube.com/@SpindleHorse')).toHaveLength(
      1,
    );
  });
});
