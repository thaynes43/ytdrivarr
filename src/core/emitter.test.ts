import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { emitLibrary, type EmitLibrary } from './emitter';
import type { SubscriptionEntry } from '../contracts';

/**
 * YAML emission fixtures (the DESIGN-045 test strategy) — preset composition matches the estate's
 * live files by SHAPE, for BOTH media-kind families (the Q-03 override, D-12). The video fixture is
 * modeled on the live YouTube `subscriptions.yaml`; the object-form fixture on Peloton's per-class
 * entries; the music fixture proves the second preset family renders through the SAME emitter.
 */

const youtubeEmitPolicy = {
  overrides: {
    tv_show_directory: '/media/youtube',
    only_recent_date_range: '24months',
    only_recent_max_files: 300,
  },
  throttle_protection: {
    sleep_per_download_s: { min: 20, max: 70 },
    subscription_download_probability: 0.5,
  },
  ytdl_options: { cookiefile: '/media/youtube/cookies.txt' },
};

const videoLibrary: EmitLibrary = {
  presetName: 'Plex TV Show by Date',
  workingDirectory: '/workdir/',
  emitPolicy: youtubeEmitPolicy,
  libraryKind: 'video',
};

const videoEntries: SubscriptionEntry[] = [
  {
    entryKey: 'https://www.youtube.com/@AlexMeyersVids',
    displayName: 'Alex Meyers',
    downloadRef: 'https://www.youtube.com/@AlexMeyersVids',
    preset: 'Plex TV Show by Date',
    chip: 'Animation',
  },
  {
    entryKey: 'https://www.youtube.com/@Defunctland',
    displayName: 'Defunctland',
    downloadRef: 'https://www.youtube.com/@Defunctland',
    preset: 'Plex TV Show by Date',
    chip: 'Documentaries',
  },
];

describe('emitLibrary — video (YouTube shape)', () => {
  const emitted = emitLibrary(videoLibrary, videoEntries);

  it('renders config.yaml with the working directory', () => {
    const config = parse(emitted.configYaml) as { configuration: { working_directory: string } };
    expect(config.configuration.working_directory).toBe('/workdir/');
  });

  it('renders __preset__ verbatim and the preset block with genre chips (string form)', () => {
    const subs = parse(emitted.subscriptionsYaml) as Record<string, unknown>;
    expect((subs.__preset__ as typeof youtubeEmitPolicy).overrides.tv_show_directory).toBe(
      '/media/youtube',
    );
    const preset = subs['Plex TV Show by Date'] as Record<string, Record<string, unknown>>;
    // simple `name: URL` string form, exactly like the estate YouTube file
    expect(preset['= Animation']?.['Alex Meyers']).toBe('https://www.youtube.com/@AlexMeyersVids');
    expect(preset['= Documentaries']?.['Defunctland']).toBe('https://www.youtube.com/@Defunctland');
  });
});

describe('emitLibrary — per-item object form (Peloton shape)', () => {
  const pelotonLibrary: EmitLibrary = {
    presetName: 'Plex TV Show by Date',
    workingDirectory: '/workdir/',
    emitPolicy: { overrides: { tv_show_directory: '/media/peloton' } },
    libraryKind: 'video',
  };
  const entries: SubscriptionEntry[] = [
    {
      entryKey: 'class-1',
      displayName: '30 min Bootcamp: 50-50 with Cody Rigsby',
      downloadRef: 'https://members.onepeloton.com/classes/player/abc',
      preset: 'Plex TV Show by Date',
      chip: 'Bike Bootcamp (30 min)',
      overrides: {
        tv_show_directory: '/media/peloton/Bike Bootcamp/Cody Rigsby',
        season_number: 30,
        episode_number: 730,
      },
    },
  ];

  it('renders the object form with download + overrides when overrides are present', () => {
    const subs = parse(emitLibrary(pelotonLibrary, entries).subscriptionsYaml) as Record<
      string,
      Record<string, Record<string, { download: string; overrides: Record<string, unknown> }>>
    >;
    const item =
      subs['Plex TV Show by Date']?.['= Bike Bootcamp (30 min)']?.[
        '30 min Bootcamp: 50-50 with Cody Rigsby'
      ];
    expect(item?.download).toBe('https://members.onepeloton.com/classes/player/abc');
    expect(item?.overrides.season_number).toBe(30);
    expect(item?.overrides.episode_number).toBe(730);
  });
});

describe('emitLibrary — music family (the Q-03 override, structurally proven)', () => {
  const musicLibrary: EmitLibrary = {
    presetName: 'YouTube Releases',
    workingDirectory: '/workdir/',
    emitPolicy: { overrides: { music_directory: '/media/music' } },
    libraryKind: 'music',
  };
  const musicEntries: SubscriptionEntry[] = [
    {
      entryKey: 'https://www.youtube.com/@taylorswift/releases',
      displayName: 'Taylor Swift',
      downloadRef: 'https://www.youtube.com/@taylorswift/releases',
      preset: 'YouTube Releases',
      chip: 'Pop',
    },
  ];

  it('renders under the music preset key, not the TV one', () => {
    const subs = parse(emitLibrary(musicLibrary, musicEntries).subscriptionsYaml) as Record<
      string,
      unknown
    >;
    expect(subs['YouTube Releases']).toBeDefined();
    expect(subs['Plex TV Show by Date']).toBeUndefined();
    const preset = subs['YouTube Releases'] as Record<string, Record<string, unknown>>;
    expect(preset['= Pop']?.['Taylor Swift']).toBe('https://www.youtube.com/@taylorswift/releases');
  });
});
