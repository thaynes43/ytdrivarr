import { pgTable, uuid, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { mediaKindEnum } from './enums';

/**
 * Library (T-218 / DESIGN-045 D-02) — the emit unit: one `{ config.yaml + subscriptions.yaml +
 * downloader CronJob }` tuple per `library × player × media-root`. Sources are rows rendered INTO
 * a Library's files. `emitPolicy` is the `__preset__` block the core renders in (throttle,
 * directories, only-recent windows, ytdl_options) — library-level policy at the estate's altitude.
 */
export const libraries = pgTable('libraries', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  /** the target player family (plex | jellyfin | …) — free text, drives preset variant selection. */
  player: text('player').notNull().default('plex'),
  mediaRoot: text('media_root').notNull(),
  /** video | music — disjoint preset families/dirs (D-12, amended: music first-class from M2). */
  libraryKind: mediaKindEnum('library_kind').notNull().default('video'),
  /** the top-level ytdl-sub preset key entries compose under (e.g. "Plex TV Show by Date"). */
  presetName: text('preset_name').notNull(),
  /** the downloader-mounted path this Library's config is atomically projected to (D-14). */
  projectionPath: text('projection_path').notNull(),
  /** ytdl-sub `configuration.working_directory` for the emitted config.yaml. */
  workingDirectory: text('working_directory').notNull().default('/workdir/'),
  /** the `__preset__` block (overrides/throttle/ytdl_options/output_options) rendered verbatim. */
  emitPolicy: jsonb('emit_policy').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Library = typeof libraries.$inferSelect;
export type NewLibrary = typeof libraries.$inferInsert;
