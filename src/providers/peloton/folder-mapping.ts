/**
 * Peloton activity → folder mapping (DESIGN-045 D-06) — ported from the donor
 * `activity_based_path_strategy.py` (`_map_activity_name` lines 98-121) and `webscraper/models.py`
 * (`_get_activity_folder_name` lines 150-171 / `to_subscription_entry` lines 173-201).
 *
 * The chip and the folder share ONE display string (donor `duration_key =
 * f"= {activity_folder_name} ({duration} min)"`): e.g. activity `bike_bootcamp` →
 * `Bike Bootcamp` → chip `Bike Bootcamp (30 min)` and folder `.../Bike Bootcamp/{Instructor}`.
 */

/** The donor `Activity` enum keys (value.lower()) — the canonical activity vocabulary. */
export type ActivityKey =
  | 'all'
  | 'strength'
  | 'yoga'
  | 'meditation'
  | 'cardio'
  | 'stretching'
  | 'cycling'
  | 'running'
  | 'walking'
  | 'bootcamp'
  | 'bike_bootcamp'
  | 'rowing'
  | 'row_bootcamp';

const ACTIVITY_KEYS: readonly ActivityKey[] = [
  'all',
  'strength',
  'yoga',
  'meditation',
  'cardio',
  'stretching',
  'cycling',
  'running',
  'walking',
  'bootcamp',
  'bike_bootcamp',
  'rowing',
  'row_bootcamp',
];

/**
 * Human-form → enum special mappings (donor `special_mappings`, lines 18-22). Note the SPACE-form
 * human names map to the underscore enum keys, and `tread bootcamp` maps to the plain `bootcamp`.
 */
const SPECIAL_MAPPINGS: Readonly<Record<string, ActivityKey>> = {
  'tread bootcamp': 'bootcamp',
  'row bootcamp': 'row_bootcamp',
  'bike bootcamp': 'bike_bootcamp',
};

/** Enum → display folder name (donor `_get_activity_folder_name` bootcamp_mappings, lines 152-156). */
const FOLDER_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  bootcamp: 'Tread Bootcamp',
  bike_bootcamp: 'Bike Bootcamp',
  row_bootcamp: 'Row Bootcamp',
};

/** Title-case each word (donor `str.title()`), so `cycling` → `Cycling`, `hiit cardio` → `Hiit Cardio`. */
function titleCase(name: string): string {
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a filesystem/label activity name to a canonical `ActivityKey` (donor `_map_activity_name`):
 *   1. direct enum lookup on the lowercased name (`bike_bootcamp`, `cycling`, …);
 *   2. the human-form special mappings (`bike bootcamp` → `bike_bootcamp`, `tread bootcamp` →
 *      `bootcamp`);
 *   3. the 50/50 edge case — a name containing `50/50`, `50-50` or `bootcamp 50` infers the discipline
 *      (`bike` → bike_bootcamp, else `row` → row_bootcamp, else `bootcamp` → bootcamp);
 *   4. else `undefined` (donor returns None).
 *
 * The `= Bike Bootcamp (30 min)` chips carry the DISPLAY form, so a space-separated `bike bootcamp`
 * resolves via step 2, and the already-display `Bike Bootcamp` lowercases into that same path.
 */
export function mapActivityName(activityName: string): ActivityKey | undefined {
  const lower = activityName.toLowerCase();
  if ((ACTIVITY_KEYS as readonly string[]).includes(lower)) return lower as ActivityKey;
  if (lower in SPECIAL_MAPPINGS) return SPECIAL_MAPPINGS[lower];
  if (['50/50', '50-50', 'bootcamp 50'].some((p) => lower.includes(p))) {
    if (lower.includes('bike')) return 'bike_bootcamp';
    if (lower.includes('row')) return 'row_bootcamp';
    if (lower.includes('bootcamp')) return 'bootcamp';
  }
  return undefined;
}

/**
 * The display folder name for an activity (donor `_get_activity_folder_name`): the bootcamp
 * overrides (`bootcamp` → `Tread Bootcamp`, `bike_bootcamp` → `Bike Bootcamp`, `row_bootcamp` →
 * `Row Bootcamp`), else the activity title-cased. Accepts either a canonical `ActivityKey` or a
 * looser scraped/label string (which it maps first); an unmappable name falls back to its title-case.
 */
export function activityFolderName(activity: string): string {
  const key = (ACTIVITY_KEYS as readonly string[]).includes(activity.toLowerCase())
    ? (activity.toLowerCase() as ActivityKey)
    : mapActivityName(activity);
  if (key && key in FOLDER_NAME_OVERRIDES) return FOLDER_NAME_OVERRIDES[key] as string;
  if (key) return titleCase(key.replace(/_/g, ' '));
  return titleCase(activity);
}

/**
 * Build the per-class `tv_show_directory` override (donor `to_subscription_entry`):
 * `{mediaRoot-without-trailing-slash}/{activityFolderName}/{instructor}`.
 */
export function buildTvShowDirectory(
  mediaRoot: string,
  activity: string,
  instructor: string,
): string {
  const root = mediaRoot.replace(/[/\\]+$/, '');
  return `${root}/${activityFolderName(activity)}/${instructor}`;
}

/** Build the `= {Activity} ({N} min)` chip label the emitter groups the entry under (donor duration_key). */
export function buildChip(activity: string, durationMinutes: number): string {
  return `${activityFolderName(activity)} (${durationMinutes} min)`;
}

/**
 * The inverse of `buildChip` — parse a stored chip (`Bike Bootcamp (30 min)`, WITHOUT the emitter's
 * leading `= `) back to `{ folderName, activity(slug), durationMinutes }`. The activity is resolved
 * to its canonical slug (`Bike Bootcamp` → `bike_bootcamp`, `Tread Bootcamp` → `bootcamp`) so the
 * per-(activity, duration) numbering seed is keyed by the SAME slug the worker scrapes. Returns null
 * when the chip is not the `{Activity} ({N} min)` shape.
 */
export function parseChip(
  chip: string,
): { folderName: string; activity: string; durationMinutes: number } | null {
  const match = /^(.*?) \((\d+) min\)$/.exec(chip.trim());
  if (!match) return null;
  const folderName = match[1] as string;
  return {
    folderName,
    activity: mapActivityName(folderName) ?? folderName.toLowerCase(),
    durationMinutes: Number.parseInt(match[2] as string, 10),
  };
}

/**
 * Resolve the canonical activity SLUG from an entry's chip (the `= {Activity} ({N} min)` label
 * WITHOUT the leading `= `, e.g. `Bike Bootcamp (30 min)` → `bike_bootcamp`, `Tread Bootcamp (…)` →
 * `bootcamp`, `Cycling (…)` → `cycling`). The single reuse point for chip → slug derivation the
 * per-(activity, duration) numbering seed is keyed by. Returns undefined for a null/empty chip or one
 * that isn't the `{Activity} ({N} min)` shape (the entry then attributes to no activity bucket).
 */
export function activitySlugFromChip(chip: string | null | undefined): string | undefined {
  if (!chip) return undefined;
  return parseChip(chip)?.activity;
}

/**
 * The folder config the discovery payload carries to the out-of-process worker (D-03) so the
 * activity→folder mapping lives in ONE place (core) and the Python worker applies the SAME rules
 * rather than re-hardcoding them. Shape is deliberately explicit for the worker contract.
 */
export interface FolderConfig {
  mediaRoot: string;
  /** enum key → display folder (the bootcamp overrides pre-resolved). */
  folderNames: Record<string, string>;
  /** human/label form → canonical enum key (direct + special mappings). */
  activityAliases: Record<string, string>;
}

export function buildFolderConfig(mediaRoot: string): FolderConfig {
  const folderNames: Record<string, string> = {};
  for (const key of ACTIVITY_KEYS) folderNames[key] = activityFolderName(key);
  const activityAliases: Record<string, string> = {};
  for (const key of ACTIVITY_KEYS) activityAliases[key] = key;
  for (const [human, key] of Object.entries(SPECIAL_MAPPINGS)) activityAliases[human] = key;
  return { mediaRoot: mediaRoot.replace(/[/\\]+$/, ''), folderNames, activityAliases };
}

/**
 * The 12 live disciplines as SCRAPE SLUGS (the donor `Activity` enum VALUES — `application.py`
 * passes `activity.value` to the scraper, which builds `/classes/{slug}` URLs). A Peloton Source
 * seeds its `activities[]` from these; the worker scrapes each slug and derives the display folder
 * via `activityFolderName`. NOTE the bootcamp slugs: `bootcamp` is the TREAD bootcamp (its URL/enum
 * value), `bike_bootcamp` and `row_bootcamp` the others.
 */
export const DEFAULT_ACTIVITIES: readonly string[] = [
  'bike_bootcamp',
  'bootcamp',
  'row_bootcamp',
  'rowing',
  'cycling',
  'running',
  'walking',
  'cardio',
  'strength',
  'yoga',
  'stretching',
  'meditation',
];
