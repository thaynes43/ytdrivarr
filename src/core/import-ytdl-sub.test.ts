import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSubscriptionsYaml, deriveMusicEmitPolicy } from './import-ytdl-sub';

const fixture = readFileSync(
  fileURLToPath(new URL('../testing/fixtures/estate-youtube-subscriptions.yaml', import.meta.url)),
  'utf8',
);

/**
 * Parser + policy-derive over the estate's LIVE subscriptions.yaml (the cutover ground truth). The
 * idempotent DB apply is proven in `src/api/import.e2e.test.ts` against embedded Postgres.
 */
describe('parseSubscriptionsYaml — the estate live file', () => {
  const parsed = parseSubscriptionsYaml(fixture);

  it('finds the single preset block and the __preset__ policy verbatim', () => {
    expect(parsed.presetNames).toEqual(['Plex TV Show by Date']);
    const overrides = (parsed.preset.overrides ?? {}) as Record<string, unknown>;
    expect(overrides.tv_show_directory).toBe('/media/youtube');
    expect(overrides.only_recent_date_range).toBe('24months');
    expect(overrides.only_recent_max_files).toBe(300);
    const ytdl = (parsed.preset.ytdl_options ?? {}) as Record<string, unknown>;
    expect(ytdl.cookiefile).toBe('/media/youtube/cookies.txt');
    expect(parsed.preset.throttle_protection).toBeDefined();
  });

  it('classifies the = Music chip channels as music, everything else as video', () => {
    expect(parsed.channels).toHaveLength(73);
    const music = parsed.channels.filter((c) => c.mediaKind === 'music');
    expect(music.map((c) => c.displayName).sort()).toEqual([
      'Benson Boone',
      'Daft Punk',
      'JVKE',
      'Taylor Swift',
      'The Living Tombstone',
    ]);
    expect(parsed.channels.filter((c) => c.mediaKind === 'video')).toHaveLength(68);
  });

  it('preserves the = Genre chip on video channels', () => {
    const alex = parsed.channels.find((c) => c.displayName === 'Alex Meyers');
    expect(alex?.chip).toBe('Animation');
    expect(alex?.ref).toBe('https://www.youtube.com/@AlexMeyersVids');
  });

  it('handles the object (Peloton) value form by reading its download URL', () => {
    const parsedObj = parseSubscriptionsYaml(`
__preset__: {}
Plex TV Show by Date:
  "= Bootcamp":
    "A class":
      download: "https://members.onepeloton.com/classes/player/abc"
      overrides: { season_number: 30 }
`);
    expect(parsedObj.channels[0]?.ref).toBe('https://members.onepeloton.com/classes/player/abc');
  });

  it('rejects non-YAML / non-mapping input', () => {
    expect(() => parseSubscriptionsYaml('- just\n- a\n- list')).toThrow(/mapping/);
  });
});

describe('deriveMusicEmitPolicy', () => {
  const parsed = parseSubscriptionsYaml(fixture);
  const music = deriveMusicEmitPolicy(parsed.preset, '/media/youtube-music');

  it('swaps tv_show_directory for music_directory and drops the only_recent window', () => {
    const overrides = music.overrides as Record<string, unknown>;
    expect(overrides.music_directory).toBe('/media/youtube-music');
    expect(overrides.tv_show_directory).toBeUndefined();
    expect(overrides.only_recent_date_range).toBeUndefined();
    expect(overrides.only_recent_max_files).toBeUndefined();
  });

  it('keeps the shared throttle governance and repoints the cookiefile', () => {
    expect(music.throttle_protection).toEqual(parsed.preset.throttle_protection);
    expect((music.ytdl_options as Record<string, unknown>).cookiefile).toBe(
      '/media/youtube-music/cookies.txt',
    );
  });
});
