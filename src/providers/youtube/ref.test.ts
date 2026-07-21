import { describe, expect, it } from 'vitest';
import { validateYoutubeRef } from './ref';

/** Channel/playlist ref validation — the honest structural `test()` probe (D-12 Tier-1). */
describe('validateYoutubeRef', () => {
  it('accepts the estate ref forms', () => {
    const good = [
      'https://www.youtube.com/@AlexMeyersVids',
      'https://www.youtube.com/@TaylorSwift',
      'https://www.youtube.com/@TaylorSwift/releases',
      'https://www.youtube.com/user/AllEarsNet',
      'https://www.youtube.com/channel/UCabc123',
      'https://www.youtube.com/c/SomeName',
      'https://www.youtube.com/playlist?list=PL-uopgYBi65HwiiDR9Y23lomAkGr9mm-S',
    ];
    for (const ref of good) {
      expect(validateYoutubeRef(ref).ok, ref).toBe(true);
    }
  });

  it('normalizes a bare @handle to a canonical URL', () => {
    const r = validateYoutubeRef('@MrBeast');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('handle');
    expect(r.normalized).toBe('https://www.youtube.com/@MrBeast');
  });

  it('rejects non-YouTube hosts, bad protocols, and junk', () => {
    const bad = [
      'https://vimeo.com/@someone',
      'ftp://www.youtube.com/@x',
      'not a url at all',
      'https://www.youtube.com/playlist',
      '',
      'https://www.youtube.com/@x/community',
    ];
    for (const ref of bad) {
      expect(validateYoutubeRef(ref).ok, ref).toBe(false);
    }
  });
});
