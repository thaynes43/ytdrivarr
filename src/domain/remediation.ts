import { desc, eq } from 'drizzle-orm';
import { remediationJobs, type RemediationJob } from '../db/schema';
import { resolveDb } from '../db/client';
import type { Database, DbClient } from '../db';
import type { RemediationAction } from '../contracts';
import { NotFoundError } from '../errors';

/**
 * RemediationJob writers (DESIGN-045 D-09) — the per-item Fix seam (the reason for the *arr shape).
 * M1 lands the table + create/read; the actual re-download (URL: stateless; Peloton: auth-gated
 * worker) is M5. `requestedBy` is machine-level (the API key), never a member (D-08/D-18).
 */

export interface CreateRemediationJobInput {
  sourceId: string;
  entryKey: string;
  action: RemediationAction;
  requestedBy?: string;
  db?: DbClient;
}

export async function createRemediationJob(
  input: CreateRemediationJobInput,
): Promise<RemediationJob> {
  const d = resolveDb(input.db) as Database;
  const inserted = await d
    .insert(remediationJobs)
    .values({
      sourceId: input.sourceId,
      entryKey: input.entryKey,
      action: input.action,
      requestedBy: input.requestedBy ?? 'api',
      status: 'queued',
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('createRemediationJob: insert returned no row');
  return row;
}

export async function getRemediationJob(
  id: string,
  exec?: DbClient,
): Promise<RemediationJob | undefined> {
  const d = resolveDb(exec) as Database;
  return (await d.select().from(remediationJobs).where(eq(remediationJobs.id, id)).limit(1))[0];
}

export async function listRemediationJobs(limit = 50, exec?: DbClient): Promise<RemediationJob[]> {
  const d = resolveDb(exec) as Database;
  return d.select().from(remediationJobs).orderBy(desc(remediationJobs.createdAt)).limit(limit);
}

export async function requireRemediationJob(id: string, exec?: DbClient): Promise<RemediationJob> {
  const job = await getRemediationJob(id, exec);
  if (!job) throw new NotFoundError('remediationJob', id);
  return job;
}
