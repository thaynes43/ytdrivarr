import { jobs } from '../db/schema';
import { resolveDb } from '../db/client';
import type { Database, DbClient } from '../db';
import type { ProviderContext, SourceProvider, SubscriptionEntry } from '../contracts';

/**
 * The job dispatcher (DESIGN-045 D-03) — routes a discovery/remediation by the provider's declared
 * runtime. `in_core` runs inline (pure yt-dlp URL enumeration, no browser). `out_of_process`
 * ENQUEUES a job row a plugin-owned worker container would claim — the core NEVER runs the scrape
 * inline and NEVER imports Selenium. M1 ships the enqueue seam; the Peloton worker is M3.
 */
export type DiscoveryDispatch =
  { mode: 'in_core'; entries: SubscriptionEntry[] } | { mode: 'out_of_process'; jobId: string };

export async function dispatchDiscovery(
  provider: SourceProvider,
  ctx: ProviderContext,
  exec?: DbClient,
): Promise<DiscoveryDispatch> {
  if (provider.runtime === 'in_core') {
    const entries = await provider.discover(ctx);
    return { mode: 'in_core', entries };
  }

  const d = resolveDb(exec) as Database;
  const inserted = await d
    .insert(jobs)
    .values({
      kind: 'discovery',
      providerId: provider.id,
      payload: { sourceId: ctx.source.id, libraryId: ctx.source.libraryId },
    })
    .returning();
  const job = inserted[0];
  if (!job) throw new Error('failed to enqueue discovery job');
  return { mode: 'out_of_process', jobId: job.id };
}
