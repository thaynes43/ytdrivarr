-- 0002_peloton_per_activity — the WATCH-GRAIN split (owner-approved console redesign direction):
-- one aggregate Peloton Source (settings.activities = [12 slugs]) becomes TWELVE per-activity
-- Sources, peers of the YouTube channels on the console's Sources page. Each activity row carries
-- its own monitored toggle (`enabled`) and cap override; the discovery payload builder re-aggregates
-- the ENABLED activities into one scrape job, so the worker contract is unchanged.
--
-- What this migration does, atomically (single DO block = one statement, one transaction):
--   1. For every aggregate-shaped Peloton source (settings ? 'activities'):
--      a. rewrite the EXISTING row into the first activity (alphabetical) — its id is PRESERVED,
--         so an in-flight discovery job whose payload still references the old source id keeps a
--         valid merge/report target across the deploy (the nightly-cron safety requirement);
--      b. insert one source per remaining activity (same library/kind/enabled/createdBy), with
--         settings = the old scrape profile MINUS `activities` and MINUS a `maxClassesPerActivity`
--         equal to the global default 25 (an equal-to-default value melts into "tracks the global
--         default"; any other value is preserved as that activity's per-source override);
--      c. reattribute every subscription entry to its activity's source by parsing the chip
--         (`{Activity} ({N} min)`) back to the activity slug — season/episode numbering lives ON
--         the entries and MOVES WITH THEM, so published numbering is untouched (the IDs-never-
--         renumbered doctrine). Entries whose chip cannot be mapped stay on the preserved row;
--      d. write source_audit rows in the SAME transaction (D-08): one `update` for the rewritten
--         row, one `create` per inserted row (apiKeyId `migration:0002`; snapshots are raw
--         row-to-jsonb, snake_case keys).
--   2. Nothing else. No schema change; `provider_state` (the minted-session record) is provider-
--      level and stays put; YouTube sources are untouched.
--
-- Idempotent by shape: only `settings ? 'activities'` rows match, and a target (library_id, ref)
-- that already exists is skipped — re-running against an already-split database is a no-op.
--
-- Reverse path (documented, not shipped): pick one activity row per library as the survivor, set
-- its settings.activities = the sibling refs + restore ref='peloton'/display_name='Peloton',
-- repoint all sibling entries at it, delete the siblings. No information is lost by the split.
DO $$
DECLARE
  agg RECORD;
  slug TEXT;
  slugs TEXT[];
  anchor_slug TEXT;
  base_settings JSONB;
  new_id UUID;
  target_id UUID;
  before_row JSONB;
  display TEXT;
BEGIN
  FOR agg IN
    SELECT * FROM sources
    WHERE provider_id = 'peloton' AND settings ? 'activities'
    ORDER BY created_at
  LOOP
    -- The activity slugs this aggregate watched, alphabetical for a deterministic anchor.
    SELECT array_agg(a ORDER BY a)
      INTO slugs
      FROM jsonb_array_elements_text(agg.settings -> 'activities') AS t(a);
    IF slugs IS NULL OR array_length(slugs, 1) = 0 THEN
      CONTINUE; -- an empty aggregate has nothing to split into
    END IF;
    anchor_slug := slugs[1];

    -- Per-activity settings: the scrape profile minus the aggregate's activities array; a cap
    -- equal to the global default (25) melts away so the row tracks the default.
    base_settings := agg.settings - 'activities';
    IF (base_settings -> 'maxClassesPerActivity') = to_jsonb(25) THEN
      base_settings := base_settings - 'maxClassesPerActivity';
    END IF;

    before_row := to_jsonb(agg);

    FOREACH slug IN ARRAY slugs LOOP
      -- Display name = the activity folder name (donor mapping): the tread bootcamp slug is the
      -- one override; every other slug title-cases (bike_bootcamp -> Bike Bootcamp).
      display := CASE WHEN slug = 'bootcamp' THEN 'Tread Bootcamp'
                      ELSE initcap(replace(slug, '_', ' ')) END;

      IF slug = anchor_slug THEN
        -- (a) rewrite the existing row in place — id preserved for in-flight job payloads.
        UPDATE sources
           SET ref = slug, display_name = display, settings = base_settings, updated_at = now()
         WHERE id = agg.id;
        INSERT INTO source_audit (source_id, action, api_key_id, before, after)
        SELECT agg.id, 'update', 'migration:0002', before_row, to_jsonb(s) FROM sources s WHERE s.id = agg.id;
        target_id := agg.id;
      ELSE
        -- (b) insert the sibling activity source (skip if it already exists — idempotency).
        SELECT id INTO target_id FROM sources
         WHERE library_id = agg.library_id AND provider_id = 'peloton' AND ref = slug;
        IF target_id IS NULL THEN
          INSERT INTO sources (library_id, provider_id, kind, media_kind, display_name, ref,
                               settings, enabled, created_by, caps_context)
          VALUES (agg.library_id, agg.provider_id, agg.kind, agg.media_kind, display, slug,
                  base_settings, agg.enabled, agg.created_by, agg.caps_context)
          RETURNING id INTO new_id;
          INSERT INTO source_audit (source_id, action, api_key_id, after)
          SELECT new_id, 'create', 'migration:0002', to_jsonb(s) FROM sources s WHERE s.id = new_id;
          target_id := new_id;
        END IF;
      END IF;

      -- (c) reattribute this activity's entries by chip -> slug (numbering rides along on the
      -- rows). Chip parse mirrors src/providers/peloton/folder-mapping.ts parseChip/mapActivityName:
      -- '{Folder} ({N} min)' -> lower(folder, ' '->'_'), with 'Tread Bootcamp' -> 'bootcamp'.
      IF slug <> anchor_slug THEN
        UPDATE subscription_entries e
           SET source_id = target_id, updated_at = now()
         WHERE e.source_id = agg.id
           AND e.chip ~ '^.* \(\d+ min\)$'
           AND (CASE WHEN lower(replace(substring(e.chip FROM '^(.*) \(\d+ min\)$'), ' ', '_'))
                          = 'tread_bootcamp'
                     THEN 'bootcamp'
                     ELSE lower(replace(substring(e.chip FROM '^(.*) \(\d+ min\)$'), ' ', '_'))
                END) = slug;
      END IF;
    END LOOP;
  END LOOP;
END $$;
