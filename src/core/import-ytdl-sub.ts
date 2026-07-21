import { parse } from 'yaml';
import type { MediaKind } from '../contracts';
import type { DbClient } from '../db';
import { inTransaction } from '../db/client';
import { ValidationError } from '../errors';
import { createSource, listSources, updateSource, type CreateSourceInput } from '../domain/sources';
import { updateLibrary } from '../domain/libraries';

/**
 * Import an existing ytdl-sub `subscriptions.yaml` (the estate's shape) into ytdrivarr Sources
 * (DESIGN-045 D-19 M2) — the cutover path that brings the ~80 YouTube channels in. Two halves,
 * both pure-testable:
 *
 *   1. `parseSubscriptionsYaml(text)` — reads the `__preset__` policy + the `{preset}` block's
 *      `= Genre` chips into a flat channel list, classifying each channel's `mediaKind` (the
 *      `= Music` chip → `music`, everything else → `video` — the Q-03 override, D-12).
 *   2. `applyYtdlSubImport(parsed, targets, opts)` — IDEMPOTENTLY upserts each channel as a Source
 *      keyed on `(providerId, displayName)` (the ytdl-sub subscription/show name — NOT the URL, so
 *      the estate's two named shows off one channel URL both survive): a re-import UPDATES (incl.
 *      relocating a channel between the video and music Libraries) and NEVER duplicates. Every
 *      mutation rides the audited single-writer (D-08).
 */

export const DEFAULT_MUSIC_CHIP = 'Music';
export const DEFAULT_PROVIDER_ID = 'youtube';
export const DEFAULT_SOURCE_KIND = 'youtube-url-list';

export interface ParsedChannel {
  displayName: string;
  ref: string;
  /** the `= Genre` chip this channel sat under (null when directly under the preset). */
  chip: string | null;
  mediaKind: MediaKind;
}

export interface ParsedSubscriptions {
  /** the top-level preset key(s) found (the estate has one: `Plex TV Show by Date`). */
  presetNames: string[];
  /** the `__preset__` policy block, verbatim (throttle, overrides, ytdl_options). */
  preset: Record<string, unknown>;
  channels: ParsedChannel[];
}

/** Pull the download URL out of a subscription value — a bare string, or the object form's `download`. */
function refFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { download?: unknown }).download === 'string'
  ) {
    return (value as { download: string }).download;
  }
  return undefined;
}

export interface ParseOptions {
  /** the chip whose channels classify as `music` (default `Music`). */
  musicChip?: string;
}

export function parseSubscriptionsYaml(text: string, opts: ParseOptions = {}): ParsedSubscriptions {
  const musicChip = opts.musicChip ?? DEFAULT_MUSIC_CHIP;
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new ValidationError(
      `not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ValidationError('subscriptions.yaml must be a YAML mapping');
  }
  const root = doc as Record<string, unknown>;
  const preset = (root.__preset__ ?? {}) as Record<string, unknown>;

  const presetNames: string[] = [];
  const channels: ParsedChannel[] = [];

  for (const [topKey, topValue] of Object.entries(root)) {
    if (topKey === '__preset__') continue;
    if (!topValue || typeof topValue !== 'object') continue;
    presetNames.push(topKey);

    for (const [innerKey, innerValue] of Object.entries(topValue as Record<string, unknown>)) {
      if (innerKey.startsWith('= ')) {
        // a `= Genre` chip group: iterate its channels.
        const chip = innerKey.slice(2).trim();
        const mediaKind: MediaKind = chip === musicChip ? 'music' : 'video';
        if (innerValue && typeof innerValue === 'object') {
          for (const [name, value] of Object.entries(innerValue as Record<string, unknown>)) {
            const ref = refFromValue(value);
            if (ref) channels.push({ displayName: name, ref, chip, mediaKind });
          }
        }
      } else {
        // a channel directly under the preset (no chip).
        const ref = refFromValue(innerValue);
        if (ref) channels.push({ displayName: innerKey, ref, chip: null, mediaKind: 'video' });
      }
    }
  }

  return { presetNames, preset, channels };
}

export interface ImportTargets {
  videoLibraryId: string;
  /** required when the parsed file carries any `music` channels. */
  musicLibraryId?: string;
}

export interface ImportOptions {
  apiKeyId?: string;
  /** also set the video Library's `emitPolicy` to the parsed `__preset__` (default false). */
  applyPreset?: boolean;
  providerId?: string;
  kind?: string;
  db?: DbClient;
}

export type ImportAction = 'created' | 'updated' | 'unchanged';

export interface ImportedSource {
  ref: string;
  mediaKind: MediaKind;
  libraryId: string;
  action: ImportAction;
}

export interface ImportSummary {
  channels: number;
  video: number;
  music: number;
  created: number;
  updated: number;
  unchanged: number;
  presetApplied: boolean;
  sources: ImportedSource[];
}

/** The Source shape the import wants for a channel, before comparing to what's persisted. */
interface DesiredSource {
  libraryId: string;
  providerId: string;
  kind: string;
  mediaKind: MediaKind;
  displayName: string;
  ref: string;
  settings: Record<string, unknown>;
}

function desiredFor(
  channel: ParsedChannel,
  targets: ImportTargets,
  providerId: string,
  kind: string,
): DesiredSource {
  // Music channels move to the dedicated music Library and shed their `= Music` chip (the Library
  // IS the grouping); video channels keep their `= Genre` chip.
  const isMusic = channel.mediaKind === 'music';
  const libraryId = isMusic ? targets.musicLibraryId : targets.videoLibraryId;
  if (!libraryId) {
    throw new ValidationError(
      `channel "${channel.displayName}" is music but no musicLibraryId was provided`,
    );
  }
  const settings: Record<string, unknown> = {};
  if (!isMusic && channel.chip) settings.chip = channel.chip;
  return {
    libraryId,
    providerId,
    kind,
    mediaKind: channel.mediaKind,
    displayName: channel.displayName,
    ref: channel.ref,
    settings,
  };
}

/**
 * True when the persisted source already matches what the import wants (no update needed). The
 * import is keyed on the subscription NAME (the ytdl-sub show identity), so displayName is always
 * equal; the fields a re-import can change are the library (relocation), mediaKind, the channel URL
 * (`ref`), and the `= Genre` chip.
 */
function matches(
  existing: { libraryId: string; mediaKind: MediaKind; ref: string; chip: string | null },
  desired: DesiredSource,
): boolean {
  return (
    existing.libraryId === desired.libraryId &&
    existing.mediaKind === desired.mediaKind &&
    existing.ref === desired.ref &&
    existing.chip === ((desired.settings.chip as string | undefined) ?? null)
  );
}

export async function applyYtdlSubImport(
  parsed: ParsedSubscriptions,
  targets: ImportTargets,
  opts: ImportOptions = {},
): Promise<ImportSummary> {
  const providerId = opts.providerId ?? DEFAULT_PROVIDER_ID;
  const kind = opts.kind ?? DEFAULT_SOURCE_KIND;

  return inTransaction(opts.db, async (tx) => {
    // One read of the existing sources; match on (providerId, displayName) — the subscription NAME
    // is the ytdl-sub show identity and the stable idempotency key. Keying on the URL would be
    // WRONG: the estate deliberately runs two named shows off one channel URL, and URL-keying would
    // collapse the second into the first (a lost subscription).
    const existing = await listSources(tx);
    const byName = new Map<string, (typeof existing)[number]>();
    for (const src of existing) {
      if (src.providerId === providerId) byName.set(src.displayName, src);
    }

    const summary: ImportSummary = {
      channels: parsed.channels.length,
      video: 0,
      music: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      presetApplied: false,
      sources: [],
    };

    for (const channel of parsed.channels) {
      const desired = desiredFor(channel, targets, providerId, kind);
      if (channel.mediaKind === 'music') summary.music += 1;
      else summary.video += 1;

      const prior = byName.get(channel.displayName);
      let action: ImportAction;
      if (!prior) {
        const input: CreateSourceInput = {
          libraryId: desired.libraryId,
          providerId,
          kind,
          mediaKind: desired.mediaKind,
          displayName: desired.displayName,
          ref: desired.ref,
          settings: desired.settings,
          createdBy: 'import',
          ...(opts.apiKeyId !== undefined ? { apiKeyId: opts.apiKeyId } : {}),
          db: tx,
        };
        const created = await createSource(input);
        byName.set(channel.displayName, created);
        action = 'created';
        summary.created += 1;
      } else if (
        matches(
          {
            libraryId: prior.libraryId,
            mediaKind: prior.mediaKind,
            ref: prior.ref,
            chip: (prior.settings.chip as string | undefined) ?? null,
          },
          desired,
        )
      ) {
        action = 'unchanged';
        summary.unchanged += 1;
      } else {
        const updated = await updateSource({
          id: prior.id,
          patch: {
            libraryId: desired.libraryId,
            mediaKind: desired.mediaKind,
            ref: desired.ref,
            settings: desired.settings,
          },
          ...(opts.apiKeyId !== undefined ? { apiKeyId: opts.apiKeyId } : {}),
          db: tx,
        });
        byName.set(channel.displayName, updated);
        action = 'updated';
        summary.updated += 1;
      }
      summary.sources.push({
        ref: channel.ref,
        mediaKind: channel.mediaKind,
        libraryId: desired.libraryId,
        action,
      });
    }

    if (opts.applyPreset && Object.keys(parsed.preset).length > 0) {
      await updateLibrary({
        id: targets.videoLibraryId,
        patch: { emitPolicy: parsed.preset },
        db: tx,
      });
      summary.presetApplied = true;
    }

    return summary;
  });
}

/**
 * Derive a music-family `__preset__` from the estate's video policy (DESIGN-045 D-12 amended) — the
 * disjoint music family: swap the `tv_show_directory` override for `music_directory` pointed at the
 * music media root, drop the TV-oriented `only_recent_*` window, keep the shared throttle governance
 * (one account identity, Q-02 §6 #4), and repoint the cookiefile beside the music root.
 */
export function deriveMusicEmitPolicy(
  videoPolicy: Record<string, unknown>,
  musicMediaRoot: string,
): Record<string, unknown> {
  const src = structuredClone(videoPolicy) as Record<string, unknown>;
  const srcOverrides = (src.overrides ?? {}) as Record<string, unknown>;
  const overrides: Record<string, unknown> = { music_directory: musicMediaRoot };
  // carry through any non-TV overrides the estate set, but never the video-only keys.
  for (const [k, v] of Object.entries(srcOverrides)) {
    if (k === 'tv_show_directory' || k.startsWith('only_recent')) continue;
    overrides[k] = v;
  }
  const policy: Record<string, unknown> = { overrides };
  if (src.throttle_protection) policy.throttle_protection = src.throttle_protection;
  policy.ytdl_options = { cookiefile: `${musicMediaRoot}/cookies.txt` };
  return policy;
}
