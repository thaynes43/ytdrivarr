import { z } from 'zod';

/**
 * C3 (DESIGN-045 D-06) — the atomic thing a discovery run produces: one ytdl-sub subscription
 * row. `discover(ctx) → SubscriptionEntry[]` is the provider's core output; the CORE owns YAML
 * assembly, cross-source/library dedup, and persistence. The entry backend may be a yt-dlp
 * playlist/channel URL (URL-list sources) or a bespoke authenticated scraper (Peloton) — the
 * contract is uniform: "PRODUCE SUBSCRIPTION ENTRIES" (Q-02 §6 #9).
 */
export const subscriptionEntrySchema = z.object({
  /** stable identity for cross-source/library dedup + IMMUTABLE numbering (D-06). */
  entryKey: z.string().min(1),
  /** the subscription's display name in the rendered YAML ("Alex Meyers", a class title). */
  displayName: z.string().min(1),
  /** the yt-dlp download target: a channel/playlist URL, or a per-item player URL (Peloton). */
  downloadRef: z.string().min(1),
  /** the named prebuilt preset this entry composes under ("Plex TV Show by Date", "YouTube Releases"). */
  preset: z.string().min(1),
  /** the "= Genre" / "= Activity (min)" grouping chip, if any (the estate altitude, D-13). */
  chip: z.string().optional(),
  /** per-item overrides (season/episode/dir; artist/album) — presence forces the YAML object form. */
  overrides: z.record(z.string(), z.unknown()).optional(),
  /** per-entry ytdl_options (cookies/headers) — a Peloton bearer rides here (D-05). */
  ytdlOptions: z.record(z.string(), z.unknown()).optional(),
  /** optional C8 assets (thumbnails/posters); YouTube has none. */
  assets: z.record(z.string(), z.unknown()).optional(),
});
export type SubscriptionEntry = z.infer<typeof subscriptionEntrySchema>;
