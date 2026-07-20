import { stringify } from 'yaml';
import type { MediaKind, SubscriptionEntry } from '../contracts';

/**
 * DESIGN-045 D-13 — config emission at LIBRARY grain by PRESET COMPOSITION (named prebuilt presets
 * + a few overrides + `= Genre`/`= Activity` chips — the estate's exact altitude, NEVER hand-written
 * plugin config). One emitter renders BOTH media-kind families structurally (the Q-03 override,
 * amended D-12): the top-level preset key and the `__preset__` policy differ by kind; the grouping
 * and entry shapes are identical. `__preset__` is rendered verbatim from library-level policy
 * (throttle, directories, ytdl_options, output_options).
 */
export interface EmitLibrary {
  presetName: string;
  workingDirectory: string;
  emitPolicy: Record<string, unknown>;
  libraryKind: MediaKind;
}

export interface EmittedConfig {
  configYaml: string;
  subscriptionsYaml: string;
}

/** An entry gets the YAML OBJECT form (`{ download, overrides, ... }`, the Peloton shape) when it
 * carries per-item overrides/options/assets; otherwise the simple `name: URL` string form (the
 * estate YouTube shape). Both are valid ytdl-sub and match the live files. */
function renderEntryValue(entry: SubscriptionEntry): unknown {
  const hasObjectForm =
    (entry.overrides && Object.keys(entry.overrides).length > 0) ||
    (entry.ytdlOptions && Object.keys(entry.ytdlOptions).length > 0) ||
    (entry.assets && Object.keys(entry.assets).length > 0);
  if (!hasObjectForm) return entry.downloadRef;
  const value: Record<string, unknown> = { download: entry.downloadRef };
  if (entry.overrides && Object.keys(entry.overrides).length > 0) value.overrides = entry.overrides;
  if (entry.ytdlOptions && Object.keys(entry.ytdlOptions).length > 0) {
    value.ytdl_options = entry.ytdlOptions;
  }
  if (entry.assets && Object.keys(entry.assets).length > 0) value.assets = entry.assets;
  return value;
}

/**
 * Compose a Library's `config.yaml` + `subscriptions.yaml` from its (already deduped + numbered)
 * entries. Entries group under their `= <chip>` label within the single named preset block.
 */
export function emitLibrary(library: EmitLibrary, entries: SubscriptionEntry[]): EmittedConfig {
  const configDoc = { configuration: { working_directory: library.workingDirectory } };

  const presetBlock: Record<string, unknown> = {};
  for (const entry of entries) {
    const value = renderEntryValue(entry);
    if (entry.chip) {
      const chipKey = `= ${entry.chip}`;
      const chip = (presetBlock[chipKey] ??= {}) as Record<string, unknown>;
      chip[entry.displayName] = value;
    } else {
      presetBlock[entry.displayName] = value;
    }
  }

  const subscriptionsDoc: Record<string, unknown> = {
    __preset__: library.emitPolicy,
    [library.presetName]: presetBlock,
  };

  return {
    configYaml: stringify(configDoc, { lineWidth: 0 }),
    subscriptionsYaml: stringify(subscriptionsDoc, { lineWidth: 0 }),
  };
}
