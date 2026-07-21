import { parse } from 'yaml';
import type { DbClient } from '../db';
import type { SubscriptionEntry } from '../contracts';
import { inTransaction } from '../db/client';
import { ValidationError } from '../errors';
import { createLibrary, listLibraries, updateLibrary } from '../domain/libraries';
import { createSource, listSources, updateSource } from '../domain/sources';
import { loadPublishedNumbering, mergeEntriesForSource } from '../domain/entries';
import { preservePublishedNumbering } from './dedup';
import { pelotonSettingsSchema } from '../providers/peloton';
import { parseChip } from '../providers/peloton/folder-mapping';
import { extractClassId } from '../providers/peloton/numbering';

/**
 * Import the estate's LIVE Peloton `subscriptions.yaml` (DESIGN-045 D-19 M3) into ytdrivarr: the
 * `__preset__` policy + the `= {Activity} ({N} min)` groups → ONE Peloton Library + ONE Peloton
 * Source + all subscription entries (entryKey = classId; season/episode preserved). IDEMPOTENT and
 * AUDITED (the Source write rides the single-writer, D-08). The round-trip is exact: emitting the
 * seeded Library reproduces the live file's parsed structure (deep-equal on parsed YAML).
 */

export const PELOTON_LIBRARY_NAME = 'Peloton';
export const PELOTON_SOURCE_REF = 'peloton';
export const PELOTON_MEDIA_ROOT = '/media/peloton';
export const PELOTON_PRESET_NAME = 'Plex TV Show by Date';
export const PELOTON_PROJECTION_PATH = 'peloton';
export const PELOTON_MAX_CLASSES_PER_ACTIVITY = 25;

export interface ParsedPelotonEntry {
  classId: string;
  displayName: string;
  /** the `= {Activity} ({N} min)` label, WITHOUT the leading `= ` (e.g. `Bike Bootcamp (30 min)`). */
  chip: string;
  /** the canonical activity slug parsed off the chip (e.g. `bike_bootcamp`). */
  activity: string;
  durationMinutes: number;
  downloadRef: string;
  seasonNumber: number;
  episodeNumber: number;
  /** the entry's `overrides` block VERBATIM (tv_show_directory / season_number / episode_number). */
  overrides: Record<string, unknown>;
}

export interface ParsedPeloton {
  presetName: string;
  preset: Record<string, unknown>;
  entries: ParsedPelotonEntry[];
  /** the distinct activity slugs present in the file (the Source's `activities` setting). */
  activities: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parse the live Peloton subscriptions.yaml into its Library + entries. Structure (parity target):
 * `__preset__` + a single `Plex TV Show by Date` preset holding `= {Activity} ({N} min)` groups,
 * each mapping a `"{Title} with {Instructor}"` display name to `{ download, overrides }`.
 */
export function parsePelotonSubscriptions(text: string): ParsedPeloton {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new ValidationError(
      `not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const root = asRecord(doc);
  if (!root) throw new ValidationError('subscriptions.yaml must be a YAML mapping');

  const preset = asRecord(root.__preset__) ?? {};
  let presetName = PELOTON_PRESET_NAME;
  const entries: ParsedPelotonEntry[] = [];
  const activities = new Set<string>();

  for (const [topKey, topValue] of Object.entries(root)) {
    if (topKey === '__preset__') continue;
    const presetBlock = asRecord(topValue);
    if (!presetBlock) continue;
    presetName = topKey;

    for (const [groupKey, groupValue] of Object.entries(presetBlock)) {
      // only the `= {Activity} ({N} min)` chip groups carry Peloton classes.
      if (!groupKey.startsWith('= ')) continue;
      const chip = groupKey.slice(2).trim();
      const parsedChip = parseChip(chip);
      const group = asRecord(groupValue);
      if (!group) continue;

      for (const [displayName, entryValue] of Object.entries(group)) {
        const entry = asRecord(entryValue);
        const downloadRef = typeof entry?.download === 'string' ? entry.download : undefined;
        if (!downloadRef) continue;
        const classId = extractClassId(downloadRef);
        if (!classId) continue;
        const overrides = asRecord(entry?.overrides) ?? {};
        const seasonNumber =
          typeof overrides.season_number === 'number' ? overrides.season_number : 0;
        const episodeNumber =
          typeof overrides.episode_number === 'number' ? overrides.episode_number : 0;
        const activity = parsedChip?.activity ?? chip.toLowerCase();
        activities.add(activity);
        entries.push({
          classId,
          displayName,
          chip,
          activity,
          durationMinutes: parsedChip?.durationMinutes ?? seasonNumber,
          downloadRef,
          seasonNumber,
          episodeNumber,
          overrides,
        });
      }
    }
  }

  return { presetName, preset, entries, activities: [...activities].sort() };
}

/** Convert a parsed entry to the persisted SubscriptionEntry shape (entryKey = classId). */
export function parsedEntryToSubscription(
  parsed: ParsedPelotonEntry,
  presetName: string,
): SubscriptionEntry {
  return {
    entryKey: parsed.classId,
    displayName: parsed.displayName,
    downloadRef: parsed.downloadRef,
    preset: presetName,
    chip: parsed.chip,
    overrides: parsed.overrides,
  };
}

export interface PelotonImportOptions {
  apiKeyId?: string;
  workingDirectory?: string;
  db?: DbClient;
}

export interface PelotonImportSummary {
  presetName: string;
  activities: string[];
  entries: number;
  libraryId: string;
  libraryAction: 'created' | 'updated';
  sourceId: string;
  sourceAction: 'created' | 'updated';
  entriesAdded: number;
  entriesUpdated: number;
}

/**
 * Idempotently ensure the Peloton Library + the single Peloton Source + all subscription entries.
 * Re-running produces no new rows (entries upsert by classId; the Library/Source match on their
 * stable keys). Every Source write is audited in the same transaction (D-08).
 */
export async function applyPelotonImport(
  parsed: ParsedPeloton,
  opts: PelotonImportOptions = {},
): Promise<PelotonImportSummary> {
  const workingDirectory = opts.workingDirectory ?? '/config';

  return inTransaction(opts.db, async (tx) => {
    // 1) ensure the Library (match on the stable name).
    const libraries = await listLibraries(tx);
    const existingLib = libraries.find((l) => l.name === PELOTON_LIBRARY_NAME);
    let libraryId: string;
    let libraryAction: 'created' | 'updated';
    if (existingLib) {
      const updated = await updateLibrary({
        id: existingLib.id,
        patch: {
          mediaRoot: PELOTON_MEDIA_ROOT,
          presetName: parsed.presetName,
          projectionPath: PELOTON_PROJECTION_PATH,
          workingDirectory,
          emitPolicy: parsed.preset,
        },
        db: tx,
      });
      libraryId = updated.id;
      libraryAction = 'updated';
    } else {
      const created = await createLibrary({
        name: PELOTON_LIBRARY_NAME,
        mediaRoot: PELOTON_MEDIA_ROOT,
        libraryKind: 'video',
        presetName: parsed.presetName,
        projectionPath: PELOTON_PROJECTION_PATH,
        workingDirectory,
        emitPolicy: parsed.preset,
        db: tx,
      });
      libraryId = created.id;
      libraryAction = 'created';
    }

    // 2) ensure the single Peloton Source (match on providerId + ref).
    const settings = pelotonSettingsSchema.parse({
      activities: parsed.activities,
      maxClassesPerActivity: PELOTON_MAX_CLASSES_PER_ACTIVITY,
    });
    const sources = await listSources(tx);
    const existingSource = sources.find(
      (s) => s.providerId === 'peloton' && s.ref === PELOTON_SOURCE_REF,
    );
    let sourceId: string;
    let sourceAction: 'created' | 'updated';
    if (existingSource) {
      const updated = await updateSource({
        id: existingSource.id,
        patch: { libraryId, settings },
        ...(opts.apiKeyId !== undefined ? { apiKeyId: opts.apiKeyId } : {}),
        db: tx,
      });
      sourceId = updated.id;
      sourceAction = 'updated';
    } else {
      const created = await createSource({
        libraryId,
        providerId: 'peloton',
        kind: 'peloton-scraper',
        mediaKind: 'video',
        displayName: PELOTON_LIBRARY_NAME,
        ref: PELOTON_SOURCE_REF,
        settings,
        createdBy: 'import',
        ...(opts.apiKeyId !== undefined ? { apiKeyId: opts.apiKeyId } : {}),
        db: tx,
      });
      sourceId = created.id;
      sourceAction = 'created';
    }

    // 3) seed the subscription entries (entryKey = classId), preserving immutable numbering.
    const desired = parsed.entries.map((e) => parsedEntryToSubscription(e, parsed.presetName));
    const published = await loadPublishedNumbering(sourceId, tx);
    const numbered = preservePublishedNumbering(desired, published);
    const merged = await mergeEntriesForSource(sourceId, numbered, tx);

    return {
      presetName: parsed.presetName,
      activities: parsed.activities,
      entries: parsed.entries.length,
      libraryId,
      libraryAction,
      sourceId,
      sourceAction,
      entriesAdded: merged.added,
      entriesUpdated: merged.updated,
    };
  });
}
