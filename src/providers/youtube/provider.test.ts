import { describe, expect, it } from 'vitest';
import { youtubeProvider, YOUTUBE_VIDEO_PRESET, YOUTUBE_MUSIC_PRESET } from './index';
import { validateProvider, subscriptionEntrySchema } from '../../contracts';
import { fakeContext } from '../../testing/context';

/**
 * The M2 real YouTube provider (D-12 amended) — BOTH preset families from one provider, driven by
 * the Source's mediaKind, plus stateless remediation (C6) and honest ref validation (C1 `test()`).
 */
describe('youtubeProvider', () => {
  it('is a valid provider declaring only remediation (C1 negation)', () => {
    expect(() => validateProvider(youtubeProvider)).not.toThrow();
    expect(youtubeProvider.capabilities).toEqual(['remediation']);
    expect(youtubeProvider.runtime).toBe('in_core');
    expect(youtubeProvider.mediaKinds).toEqual(['video', 'music']);
    expect(youtubeProvider.authenticate).toBeUndefined();
    expect(youtubeProvider.describeAssets).toBeUndefined();
    expect(typeof youtubeProvider.remediate).toBe('function');
  });

  it('discover() files a VIDEO source under the TV-Show preset with its genre chip', async () => {
    const entries = await youtubeProvider.discover(
      fakeContext({
        source: {
          mediaKind: 'video',
          displayName: 'Alex Meyers',
          ref: 'https://www.youtube.com/@AlexMeyersVids',
          settings: { chip: 'Animation' },
        },
      }),
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(() => subscriptionEntrySchema.parse(entry)).not.toThrow();
    expect(entry.preset).toBe(YOUTUBE_VIDEO_PRESET);
    expect(entry.chip).toBe('Animation');
    expect(entry.downloadRef).toBe('https://www.youtube.com/@AlexMeyersVids');
  });

  it('discover() files a MUSIC source under the music preset (the Q-03 override)', async () => {
    const entries = await youtubeProvider.discover(
      fakeContext({
        source: {
          mediaKind: 'music',
          displayName: 'Taylor Swift',
          ref: 'https://www.youtube.com/@TaylorSwift',
          settings: {},
        },
      }),
    );
    expect(entries[0]!.preset).toBe(YOUTUBE_MUSIC_PRESET);
    expect(entries[0]!.chip).toBeUndefined();
  });

  it('test() reports error on a malformed ref, ok on a good one', async () => {
    const bad = await youtubeProvider.test(fakeContext({ source: { ref: 'https://vimeo.com/x' } }));
    expect(bad.status).toBe('error');
    const good = await youtubeProvider.test(
      fakeContext({ source: { ref: 'https://www.youtube.com/@x' } }),
    );
    expect(good.status).toBe('ok');
  });

  it('discover() throws on an invalid ref (not a silent skip)', async () => {
    await expect(
      youtubeProvider.discover(fakeContext({ source: { ref: 'https://vimeo.com/x' } })),
    ).rejects.toThrow(/invalid source ref/);
  });

  it('remediate() returns a queued stateless re-download for a URL source', async () => {
    const result = await youtubeProvider.remediate!(
      'https://www.youtube.com/@x',
      'redownload',
      fakeContext({ source: { ref: 'https://www.youtube.com/@x' } }),
    );
    expect(result.status).toBe('queued');
    expect(result.action).toBe('redownload');
  });
});
