import { getProvider } from './registry';
import { buildContext } from './discovery';
import { createStateStore } from './state-store';
import { listSources } from '../domain/sources';
import { getLastRunForProvider } from '../domain/runs';
import type { DbClient } from '../db';

/**
 * C7 (DESIGN-045 D-10) — aggregate per-source health by running each provider's `test()` probe, then
 * ENRICH it with the two first-class alarms that are today's SILENT failures:
 *
 *  - **credential-age** — now − the provider's last-minted-session time (provider state `session`)
 *    vs its bearer-freshness SLA (`scheduling.credentialRefreshSec`, D-07): WARN at ≥1× the SLA,
 *    ERROR at ≥2× (the aging-token → downloads-silently-stop gap, closed).
 *  - **selector-drift** — the last run for the provider whose telemetry reported
 *    `selectorDriftHits > 0` (a scrape whose selectors returned zero/malformed hits): WARN, so the
 *    estate hears about a broken scrape BEFORE it notices missing downloads.
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

const STATUS_RANK = { ok: 0, unknown: 1, warn: 2, error: 3 } as const;
type HealthStatus4 = 'ok' | 'warn' | 'error' | 'unknown';

/** Escalate a status toward a new (warn/error) alarm level, never downgrading. */
function escalate(current: HealthStatus4, next: 'warn' | 'error'): HealthStatus4 {
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : current;
}

export interface CredentialAgeAlarm {
  status: 'ok' | 'warn' | 'error';
  ageSec: number;
  message: string;
}

/**
 * The credential-age alarm policy (D-10) — a PURE function so the thresholds are unit-testable
 * without a DB: WARN once the bearer is at least one SLA old, ERROR at two. Returns the computed age
 * so the caller can surface it on the source health.
 */
export function credentialAgeAlarm(
  mintedAtIso: string,
  refreshSec: number,
  now: number = Date.now(),
): CredentialAgeAlarm {
  const ageSec = Math.max(0, Math.floor((now - Date.parse(mintedAtIso)) / 1000));
  if (refreshSec > 0 && ageSec >= refreshSec * 2) {
    return {
      status: 'error',
      ageSec,
      message: `bearer minted ${ageSec}s ago ≥ 2× SLA (${refreshSec}s)`,
    };
  }
  if (refreshSec > 0 && ageSec >= refreshSec) {
    return {
      status: 'warn',
      ageSec,
      message: `bearer minted ${ageSec}s ago ≥ SLA (${refreshSec}s)`,
    };
  }
  return {
    status: 'ok',
    ageSec,
    message: `bearer minted ${ageSec}s ago (within SLA ${refreshSec}s)`,
  };
}

export async function collectHealth(exec?: DbClient): Promise<ServiceHealth> {
  const sources = await listSources(exec);
  const results: SourceHealth[] = [];
  let overall: 'ok' | 'warn' | 'error' = 'ok';

  for (const source of sources) {
    try {
      const provider = getProvider(source.providerId);
      const ctx = buildContext(source, provider.stateNamespace, exec);
      const base = await provider.test(ctx);

      let status: HealthStatus4 = base.status;
      let message = base.message;
      let credentialAgeSec = base.credentialAgeSec;
      let selectorDriftHits = base.selectorDriftHits;

      // --- credential-age alarm (D-10) — read the provider's last-minted-session directly, so the
      //     alarm fires even when test() reported another status. Only for providers that declare a
      //     bearer-freshness SLA (cron providers with credentialRefreshSec — Peloton).
      const refreshSec =
        provider.scheduling.mode === 'cron' ? provider.scheduling.credentialRefreshSec : undefined;
      if (refreshSec && refreshSec > 0) {
        const session = await createStateStore(provider.stateNamespace, exec).get<{
          mintedAt?: string;
        }>('session');
        if (session?.mintedAt) {
          const alarm = credentialAgeAlarm(session.mintedAt, refreshSec);
          credentialAgeSec = alarm.ageSec;
          if (alarm.status !== 'ok') {
            status = escalate(status, alarm.status);
            message = alarm.message;
          }
        }
      }

      // --- selector-drift alarm (D-10) — the last run for this provider reported drift hits.
      const lastRun = await getLastRunForProvider(source.providerId, exec);
      const drift = lastRun
        ? Number((lastRun.telemetry as { selectorDriftHits?: number }).selectorDriftHits ?? 0)
        : 0;
      if (drift > 0) {
        selectorDriftHits = drift;
        status = escalate(status, 'warn');
        message = message
          ? `${message}; selector drift ${drift}`
          : `selector drift ${drift} on last run`;
      }

      results.push({
        sourceId: source.id,
        providerId: source.providerId,
        status,
        checkedAt: base.checkedAt,
        ...(message !== undefined ? { message } : {}),
        ...(credentialAgeSec !== undefined ? { credentialAgeSec } : {}),
        ...(selectorDriftHits !== undefined ? { selectorDriftHits } : {}),
      });
      overall = worse(overall, status);
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
