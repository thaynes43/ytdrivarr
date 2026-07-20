import { z } from 'zod';
import type { ProviderContext, SourceProvider, SubscriptionEntry } from '../../contracts';

/**
 * The trivial `in_core` static URL-list provider — the M1 walking-skeleton proof (exercises
 * C1/C3/C5 with NO auth). A Source's `ref` is a yt-dlp URL (a channel/playlist); the provider
 * emits one subscription entry pointing at it, under the preset family the Source's `mediaKind`
 * selects. Capability set is EMPTY: `validateProvider` therefore forbids it any auth/remediation/
 * assets hook, which is the structural proof of capability negation. A real reachability probe and
 * stateless remediation are the M2 YouTube provider's job.
 *
 * Note how few lines a `[]`-capability provider is — that is the point (the owner's *arr
 * extension-point ruling: negation keeps the trivial trivial).
 */
const settingsSchema = z.object({
  /** an optional "= Genre" / grouping chip the entry is filed under. */
  chip: z.string().optional(),
  /** an optional preset override; defaults per mediaKind. */
  preset: z.string().optional(),
});

function presetForKind(mediaKind: string): string {
  return mediaKind === 'music' ? 'YouTube Releases' : 'Plex TV Show by Date';
}

export const inCoreUrlListProvider: SourceProvider = {
  id: 'in-core-url-list',
  kind: 'url-list',
  runtime: 'in_core',
  capabilities: [],
  mediaKinds: ['video', 'music'],
  settingsSchema,
  scheduling: { mode: 'event_driven' },
  stateNamespace: 'in-core-url-list',

  async test(ctx: ProviderContext) {
    // A static URL list carries no credentials and is trivially "reachable"; a real HTTP/extractor
    // probe arrives with the M2 YouTube provider.
    return {
      status: 'ok' as const,
      message: `static URL source: ${ctx.source.ref}`,
      checkedAt: new Date().toISOString(),
    };
  },

  async discover(ctx: ProviderContext): Promise<SubscriptionEntry[]> {
    const settings = settingsSchema.parse(ctx.source.settings);
    const entry: SubscriptionEntry = {
      entryKey: ctx.source.ref,
      displayName: ctx.source.displayName,
      downloadRef: ctx.source.ref,
      preset: settings.preset ?? presetForKind(ctx.source.mediaKind),
    };
    if (settings.chip) entry.chip = settings.chip;
    return [entry];
  },
};
