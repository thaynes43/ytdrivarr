import { desc, eq } from 'drizzle-orm';
import { runs, type Run } from '../db/schema';
import { resolveDb } from '../db/client';
import type { Database, DbClient } from '../db';

/** Run recording (DESIGN-045 D-02/D-10) — the machine-level discovery/emit history + telemetry. */

export type RunScope = 'all' | 'library' | 'source';
export type RunTrigger = 'cron' | 'api' | 'edit';
export type RunStatus = 'running' | 'ok' | 'warn' | 'error';

export interface StartRunInput {
  scope: RunScope;
  scopeRef?: string;
  trigger: RunTrigger;
  providerId?: string;
  db?: DbClient;
}

export async function startRun(input: StartRunInput): Promise<Run> {
  const d = resolveDb(input.db) as Database;
  const inserted = await d
    .insert(runs)
    .values({
      scope: input.scope,
      scopeRef: input.scopeRef ?? null,
      trigger: input.trigger,
      providerId: input.providerId ?? null,
      status: 'running',
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('startRun: insert returned no row');
  return row;
}

export interface FinishRunInput {
  id: string;
  status: RunStatus;
  counts?: Record<string, number>;
  telemetry?: Record<string, unknown>;
  logExcerpt?: string;
  db?: DbClient;
}

export async function finishRun(input: FinishRunInput): Promise<Run> {
  const d = resolveDb(input.db) as Database;
  const updated = await d
    .update(runs)
    .set({
      status: input.status,
      counts: input.counts ?? {},
      telemetry: input.telemetry ?? {},
      logExcerpt: input.logExcerpt ?? null,
      finishedAt: new Date(),
    })
    .where(eq(runs.id, input.id))
    .returning();
  const row = updated[0];
  if (!row) throw new Error(`finishRun: run ${input.id} not found`);
  return row;
}

export async function getRun(id: string, exec?: DbClient): Promise<Run | undefined> {
  const d = resolveDb(exec) as Database;
  return (await d.select().from(runs).where(eq(runs.id, id)).limit(1))[0];
}

export async function listRuns(limit = 50, exec?: DbClient): Promise<Run[]> {
  const d = resolveDb(exec) as Database;
  return d.select().from(runs).orderBy(desc(runs.startedAt)).limit(limit);
}
