/**
 * YouTube channel/playlist reference validation (DESIGN-045 D-12 Tier-1) — the honest `test()` probe
 * for an `in_core` URL-list provider that carries no credentials. A malformed handle/URL is an
 * ERROR the operator sees on the source's health, not a silent no-op at download time (the donor's
 * failure mode). A real network HEAD is deliberately out of scope: the provider never reaches out
 * from the core process (that is yt-dlp's job at download time), so the probe is structural.
 */

export type YoutubeRefKind = 'handle' | 'user' | 'custom' | 'channel' | 'playlist';

export interface YoutubeRefResult {
  ok: boolean;
  kind?: YoutubeRefKind;
  /** the normalized canonical URL (bare `@handle` is accepted and normalized). */
  normalized?: string;
  reason?: string;
}

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
/** channel sub-tabs a handle/channel URL may legitimately carry (video vs music `releases`). */
const KNOWN_TABS = new Set(['videos', 'releases', 'streams', 'shorts', 'playlists', 'featured']);

/**
 * Validate (and lightly normalize) a Source `ref`. Accepts the estate's forms — `@handle`,
 * `/user/Name`, `/c/Name`, `/channel/UC…`, `/playlist?list=…` — plus a bare `@handle` shorthand.
 */
export function validateYoutubeRef(ref: string): YoutubeRefResult {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty ref' };

  // Bare "@handle" shorthand → canonical channel URL.
  if (/^@[A-Za-z0-9._-]+$/.test(trimmed)) {
    return { ok: true, kind: 'handle', normalized: `https://www.youtube.com/${trimmed}` };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: `not a URL or @handle: ${ref}` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `must be http(s): ${ref}` };
  }
  if (!HOSTS.has(url.hostname)) {
    return { ok: false, reason: `not a youtube.com host: ${url.hostname}` };
  }

  if (url.pathname === '/playlist') {
    return url.searchParams.get('list')
      ? { ok: true, kind: 'playlist', normalized: trimmed }
      : { ok: false, reason: 'playlist URL missing ?list=' };
  }

  const seg = url.pathname.split('/').filter(Boolean);

  if (seg[0]?.startsWith('@')) {
    if (seg.length >= 2 && !KNOWN_TABS.has(seg[1] ?? '')) {
      return { ok: false, reason: `unrecognized channel tab: /${seg[1]}` };
    }
    return { ok: true, kind: 'handle', normalized: trimmed };
  }
  if (seg[0] === 'user' && seg[1]) return { ok: true, kind: 'user', normalized: trimmed };
  if (seg[0] === 'c' && seg[1]) return { ok: true, kind: 'custom', normalized: trimmed };
  if (seg[0] === 'channel' && seg[1]) return { ok: true, kind: 'channel', normalized: trimmed };

  return { ok: false, reason: `unrecognized YouTube channel/playlist URL: ${ref}` };
}
