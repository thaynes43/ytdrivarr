import { z } from 'zod';
import type {
  ProviderContext,
  RemediationAction,
  RemediationResult,
  SourceProvider,
  SubscriptionEntry,
} from '../../contracts';
import { validateYoutubeRef } from './ref';

/**
 * The M2 real `in_core` YouTube URL-list provider (DESIGN-045 D-12 Tier-1, as amended — the Q-03
 * override: music FIRST-CLASS from M2). It supports BOTH preset families from one provider:
 *
 *   - `mediaKind: video` → `{player} TV Show by Date` (the estate's `Plex TV Show by Date`), the
 *     channel filed as a date-based TV show under its `= Genre` chip.
 *   - `mediaKind: music` → the music family (`YouTube Releases`: audio_extract + music_tags +
 *     artist/album/track layout), rendered into a music-kind Library.
 *
 * The media-kind split is a subscribe-time classification the SERVICE owns (Q-02 §6 #1): the
 * Source carries the `mediaKind`, the Library carries the matching `libraryKind`/preset, and the
 * emitter renders the right family. A trivial provider stays trivial — the whole discover() is a
 * single URL → one entry; the difference between the two families is only which named preset the
 * entry composes under (the top-level key is the Library's, D-13).
 *
 * Capabilities: `[remediation]` only. Auth/scrape/tokenMint/assets are NEGATED (D-04) — a YouTube
 * URL carries no credentials. Remediation is the stateless URL re-download (D-09); its end-to-end
 * execution wiring is M5, but the provider declares and validates it here so the seam is real.
 */

const settingsSchema = z.object({
  /** the `= Genre` grouping chip the entry is filed under (video); music sources are ungrouped. */
  chip: z.string().optional(),
  /** an explicit preset override; otherwise the preset is chosen by the Source's mediaKind. */
  preset: z.string().optional(),
});

/** The estate's video family key (the `{player} TV Show by Date` prebuilt preset). */
export const YOUTUBE_VIDEO_PRESET = 'Plex TV Show by Date';
/** The ytdl-sub music family key (audio_extract + music_tags + artist/album/track — Q-02 §1/§3). */
export const YOUTUBE_MUSIC_PRESET = 'YouTube Releases';

export function presetForKind(mediaKind: string): string {
  return mediaKind === 'music' ? YOUTUBE_MUSIC_PRESET : YOUTUBE_VIDEO_PRESET;
}

export const youtubeProvider: SourceProvider = {
  id: 'youtube',
  kind: 'youtube-url-list',
  runtime: 'in_core',
  capabilities: ['remediation'],
  mediaKinds: ['video', 'music'],
  settingsSchema,
  // Event-driven: a member/admin Source edit enqueues a discovery+emit for that Library (D-07/D-15),
  // with a slow daily safety re-emit so a missed edit event can't leave the projection stale.
  scheduling: { mode: 'event_driven', safetyCron: '30 4 * * *' },
  stateNamespace: 'youtube',

  async test(ctx: ProviderContext) {
    const result = validateYoutubeRef(ctx.source.ref);
    const checkedAt = new Date().toISOString();
    if (!result.ok) {
      return { status: 'error' as const, message: result.reason ?? 'invalid ref', checkedAt };
    }
    return {
      status: 'ok' as const,
      message: `valid YouTube ${result.kind} ref for ${ctx.source.mediaKind}`,
      checkedAt,
    };
  },

  async discover(ctx: ProviderContext): Promise<SubscriptionEntry[]> {
    const settings = settingsSchema.parse(ctx.source.settings);
    const check = validateYoutubeRef(ctx.source.ref);
    if (!check.ok) {
      throw new Error(`youtube: invalid source ref — ${check.reason}`);
    }
    const downloadRef = check.normalized ?? ctx.source.ref;
    const entry: SubscriptionEntry = {
      // entryKey is the per-Source subscription identity (D-06). It is the Source id, NOT the URL:
      // the estate deliberately runs two distinct shows off one channel URL (e.g. two names on
      // @jordanmatter), so URL-keying would wrongly collapse them at dedup. Each Source is one
      // deliberate subscription; the immutable-numbering guard has nothing to preserve here (TV Show
      // by Date auto-numbers off upload date), so a stable per-Source key is exactly right.
      entryKey: ctx.source.id,
      displayName: ctx.source.displayName,
      downloadRef,
      preset: settings.preset ?? presetForKind(ctx.source.mediaKind),
    };
    if (settings.chip) entry.chip = settings.chip;
    return [entry];
  },

  async remediate(
    entryKey: string,
    action: RemediationAction,
    ctx: ProviderContext,
  ): Promise<RemediationResult> {
    // Stateless re-download (D-09): re-enqueue the one subscription line, forcing past the download
    // archive. No session (URL provider). The core dispatches the actual ytdl-sub re-run in M5;
    // here we validate the ref and return the queued intent so the RemediationJob row is honest.
    const check = validateYoutubeRef(ctx.source.ref);
    if (!check.ok) {
      return { entryKey, action, status: 'error', message: check.reason ?? 'invalid ref' };
    }
    return {
      entryKey,
      action,
      status: 'queued',
      message: 'stateless re-download queued (execution wired in M5)',
    };
  },
};
