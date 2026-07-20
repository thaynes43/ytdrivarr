import { getProvider } from './registry';
import { buildContext } from './discovery';
import { listSources } from '../domain/sources';
import type { DbClient } from '../db';

/**
 * C7 (DESIGN-045 D-10) — aggregate per-source health by running each provider's `test()` probe.
 * This is the surface GET /health exposes and the app mirrors into its status read. The two
 * first-class alarms (credential-age, selector-drift) ride through from the provider's HealthResult.
 */
export interface SourceHealth {
  sourceId: string;
  providerId: string;
  status: 'ok' | 'warn' | 'error' | 'unknown';
  message?: string;
  checkedAt: string;
  credentialAgeSec?: number;
  selectorDriftHits?: number;
}

export interface ServiceHealth {
  status: 'ok' | 'warn' | 'error';
  sources: SourceHealth[];
}

function worse(
  a: 'ok' | 'warn' | 'error',
  b: 'ok' | 'warn' | 'error' | 'unknown',
): 'ok' | 'warn' | 'error' {
  const rank = { ok: 0, unknown: 1, warn: 1, error: 2 } as const;
  const b2: 'ok' | 'warn' | 'error' = b === 'unknown' ? 'warn' : b;
  return rank[a] >= rank[b2] ? a : b2;
}

export async function collectHealth(exec?: DbClient): Promise<ServiceHealth> {
  const sources = await listSources(exec);
  const results: SourceHealth[] = [];
  let overall: 'ok' | 'warn' | 'error' = 'ok';

  for (const source of sources) {
    try {
      const provider = getProvider(source.providerId);
      const ctx = buildContext(source, provider.stateNamespace, exec);
      const health = await provider.test(ctx);
      results.push({
        sourceId: source.id,
        providerId: source.providerId,
        status: health.status,
        checkedAt: health.checkedAt,
        ...(health.message !== undefined ? { message: health.message } : {}),
        ...(health.credentialAgeSec !== undefined
          ? { credentialAgeSec: health.credentialAgeSec }
          : {}),
        ...(health.selectorDriftHits !== undefined
          ? { selectorDriftHits: health.selectorDriftHits }
          : {}),
      });
      overall = worse(overall, health.status);
    } catch (err) {
      results.push({
        sourceId: source.id,
        providerId: source.providerId,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      });
      overall = 'error';
    }
  }

  return { status: overall, sources: results };
}
