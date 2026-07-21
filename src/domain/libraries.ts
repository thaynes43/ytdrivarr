import { eq } from 'drizzle-orm';
import { libraries, type Library } from '../db/schema';
import { resolveDb } from '../db/client';
import type { Database, DbClient } from '../db';
import type { MediaKind } from '../contracts';
import { NotFoundError } from '../errors';

/**
 * Library writers (DESIGN-045 D-02). Libraries are operator config (the emit unit), not the audited
 * member-facing source list, so they carry no audit trail — only Source mutations do (D-08).
 */

export interface CreateLibraryInput {
  name: string;
  player?: string;
  mediaRoot: string;
  libraryKind?: MediaKind;
  presetName?: string;
  projectionPath: string;
  workingDirectory?: string;
  /** the session-artifact (bearer.txt/cookies.txt) dir (D-05); null → falls back to mediaRoot. */
  credentialPath?: string;
  emitPolicy?: Record<string, unknown>;
  db?: DbClient;
}

function defaultPresetName(kind: MediaKind): string {
  return kind === 'music' ? 'YouTube Releases' : 'Plex TV Show by Date';
}

export async function createLibrary(input: CreateLibraryInput): Promise<Library> {
  const d = resolveDb(input.db) as Database;
  const kind: MediaKind = input.libraryKind ?? 'video';
  const inserted = await d
    .insert(libraries)
    .values({
      name: input.name,
      player: input.player ?? 'plex',
      mediaRoot: input.mediaRoot,
      libraryKind: kind,
      presetName: input.presetName ?? defaultPresetName(kind),
      projectionPath: input.projectionPath,
      workingDirectory: input.workingDirectory ?? '/workdir/',
      credentialPath: input.credentialPath ?? null,
      emitPolicy: input.emitPolicy ?? {},
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('createLibrary: insert returned no row');
  return row;
}

export interface UpdateLibraryInput {
  id: string;
  patch: Partial<
    Pick<
      Library,
      | 'name'
      | 'player'
      | 'mediaRoot'
      | 'presetName'
      | 'projectionPath'
      | 'workingDirectory'
      | 'credentialPath'
      | 'emitPolicy'
    >
  >;
  db?: DbClient;
}

export async function updateLibrary(input: UpdateLibraryInput): Promise<Library> {
  const d = resolveDb(input.db) as Database;
  const updated = await d
    .update(libraries)
    .set({ ...input.patch, updatedAt: new Date() })
    .where(eq(libraries.id, input.id))
    .returning();
  const row = updated[0];
  if (!row) throw new NotFoundError('library', input.id);
  return row;
}

export async function deleteLibrary(id: string, exec?: DbClient): Promise<void> {
  const d = resolveDb(exec) as Database;
  const deleted = await d.delete(libraries).where(eq(libraries.id, id)).returning();
  if (deleted.length === 0) throw new NotFoundError('library', id);
}

export async function getLibrary(id: string, exec?: DbClient): Promise<Library | undefined> {
  const d = resolveDb(exec) as Database;
  return (await d.select().from(libraries).where(eq(libraries.id, id)).limit(1))[0];
}

export async function listLibraries(exec?: DbClient): Promise<Library[]> {
  const d = resolveDb(exec) as Database;
  return d.select().from(libraries);
}
