import { eq } from 'drizzle-orm';
import { sources, sourceAudit, type Source } from '../db/schema';
import { inTransaction, resolveDb } from '../db/client';
import type { Database, DbClient } from '../db';
import type { MediaKind } from '../contracts';
import { NotFoundError } from '../errors';

/**
 * The SINGLE-WRITER for the `sources` table (DESIGN-045 D-08; hard rule 6 applied service-side).
 * EVERY mutation here writes a `source_audit` row in the SAME transaction as the state change — the
 * two commit together or not at all. Audit is MACHINE-LEVEL (the calling API key, `apiKeyId`), with
 * NO user identity (D-21). Nothing else in the codebase writes `sources`; the guard test
 * (`no-direct-source-writes.test.ts`) fails the build if it tries.
 */

/** Normalize a row to a plain, JSON-serializable audit payload (Dates → ISO strings). */
function snapshot(row: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

export interface CreateSourceInput {
  libraryId: string;
  providerId: string;
  kind: string;
  mediaKind: MediaKind;
  displayName: string;
  ref: string;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  createdBy?: string;
  capsContext?: Record<string, unknown>;
  /** the calling API key label recorded in the audit row (machine-level). */
  apiKeyId?: string;
  db?: DbClient;
}

export async function createSource(input: CreateSourceInput): Promise<Source> {
  return inTransaction(input.db, async (tx) => {
    const inserted = await tx
      .insert(sources)
      .values({
        libraryId: input.libraryId,
        providerId: input.providerId,
        kind: input.kind,
        mediaKind: input.mediaKind,
        displayName: input.displayName,
        ref: input.ref,
        settings: input.settings ?? {},
        enabled: input.enabled ?? true,
        createdBy: input.createdBy ?? 'api',
        capsContext: input.capsContext ?? {},
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('createSource: insert returned no row');
    await tx.insert(sourceAudit).values({
      sourceId: row.id,
      action: 'create',
      apiKeyId: input.apiKeyId ?? 'api',
      after: snapshot(row),
    });
    return row;
  });
}

export interface UpdateSourceInput {
  id: string;
  patch: Partial<
    Pick<Source, 'displayName' | 'ref' | 'settings' | 'mediaKind' | 'capsContext' | 'libraryId'>
  >;
  apiKeyId?: string;
  db?: DbClient;
}

export async function updateSource(input: UpdateSourceInput): Promise<Source> {
  return inTransaction(input.db, async (tx) => {
    const before = (await tx.select().from(sources).where(eq(sources.id, input.id)).limit(1))[0];
    if (!before) throw new NotFoundError('source', input.id);
    const updated = await tx
      .update(sources)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(eq(sources.id, input.id))
      .returning();
    const row = updated[0];
    if (!row) throw new NotFoundError('source', input.id);
    await tx.insert(sourceAudit).values({
      sourceId: input.id,
      action: 'update',
      apiKeyId: input.apiKeyId ?? 'api',
      before: snapshot(before),
      after: snapshot(row),
    });
    return row;
  });
}

export interface SetSourceEnabledInput {
  id: string;
  enabled: boolean;
  apiKeyId?: string;
  db?: DbClient;
}

export async function setSourceEnabled(input: SetSourceEnabledInput): Promise<Source> {
  return inTransaction(input.db, async (tx) => {
    const before = (await tx.select().from(sources).where(eq(sources.id, input.id)).limit(1))[0];
    if (!before) throw new NotFoundError('source', input.id);
    const updated = await tx
      .update(sources)
      .set({ enabled: input.enabled, updatedAt: new Date() })
      .where(eq(sources.id, input.id))
      .returning();
    const row = updated[0];
    if (!row) throw new NotFoundError('source', input.id);
    await tx.insert(sourceAudit).values({
      sourceId: input.id,
      action: input.enabled ? 'enable' : 'disable',
      apiKeyId: input.apiKeyId ?? 'api',
      before: snapshot(before),
      after: snapshot(row),
    });
    return row;
  });
}

export interface DeleteSourceInput {
  id: string;
  apiKeyId?: string;
  db?: DbClient;
}

export async function deleteSource(input: DeleteSourceInput): Promise<void> {
  return inTransaction(input.db, async (tx) => {
    const before = (await tx.select().from(sources).where(eq(sources.id, input.id)).limit(1))[0];
    if (!before) throw new NotFoundError('source', input.id);
    await tx.delete(sources).where(eq(sources.id, input.id));
    // The audit row is NOT FK-bound to `sources`, so it survives the delete it records.
    await tx.insert(sourceAudit).values({
      sourceId: input.id,
      action: 'delete',
      apiKeyId: input.apiKeyId ?? 'api',
      before: snapshot(before),
    });
  });
}

// --- reads (unguarded) ------------------------------------------------------------------------

export async function getSource(id: string, exec?: DbClient): Promise<Source | undefined> {
  const d = resolveDb(exec) as Database;
  return (await d.select().from(sources).where(eq(sources.id, id)).limit(1))[0];
}

export async function listSources(exec?: DbClient): Promise<Source[]> {
  const d = resolveDb(exec) as Database;
  return d.select().from(sources);
}

export async function listSourcesForLibrary(libraryId: string, exec?: DbClient): Promise<Source[]> {
  const d = resolveDb(exec) as Database;
  return d.select().from(sources).where(eq(sources.libraryId, libraryId));
}
