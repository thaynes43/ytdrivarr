import { getProvider } from './registry';
import { buildContext } from './discovery';
import { createStateStore } from './state-store';
import { getWorkerLivenessForProvider } from './jobs';
import { listSources } from '../domain/sources';
import { getLastRunForProvider, type RunStatus } from '../domain/runs';
import type { Runtime, SourceProvider } from '../contracts';
import { resolveCredentialSla, type CredentialSla } from '../contracts/scheduling';
import type { Source } from '../db/schema';
import type { DbClient } from '../db';

/**
 * C7 (DESIGN-045 D-10) — aggregate per-source health. Two models, chosen by the provider's runtime:
 *
 *  - **`in_core` providers (PROBE):** run the provider's own `test()` reachability/credential probe,
 *    then ENRICH it with the two first-class alarms — **credential-age** (now − the provider's
 *    last-minted-session time vs its resolved bearer-freshness SLA, issue #23: WARN once the bearer
 *    is past the warn age, ERROR once past the error age) and **selector-drift** (the last run
 *    reported `selectorDriftHits > 0`: WARN).
 *
 *  - **`out_of_process` providers (OBSERVED, D-03/D-05):** their credentials live ONLY in the
 *    plugin-owned worker (the D-05/D-21 split) — the core never holds them, so calling `test()` here
 *    would false-alarm on "missing credentials" for a provider that is running fine. Instead health
 *    is derived from OBSERVED state the core already stores: (a) the last run's status + recorded
 *    alarms, (b) bearer/credential freshness from provider state vs the SLA, (c) worker liveness
 *    (last claim/heartbeat) from the jobs table. A worker genuinely lacking creds surfaces HONESTLY
 *    as failed runs / alarms via (a) — missing worker env is NEVER a core-side failure.
 */

export interface SourceHealth {
  sourceId: string;
  providerId: string;
  status: 'ok' | 'warn' | 'error' | 'unknown';
  message?: string;
  checkedAt: string;
  credentialAgeSec?: number;
  selectorDriftHits?: number;
  // --- additive observed-state fields (kept optional so existing consumers stay truthful) -------
  /** which health model produced this row: `probe` = the provider's in-core test(); `observed` =
   *  derived from stored run/credential/worker state (out_of_process providers). */
  healthModel?: 'probe' | 'observed';
  /** the provider's runtime, echoed so the console/API can see which model was used. */
  runtime?: Runtime;
  /** (observed) the provider's most recent run status. */
  lastRunStatus?: RunStatus;
  /** (observed) when that run finished (or started, if still running). */
  lastRunAt?: string;
  /** (observed) the last-minted bearer timestamp read from provider state. */
  bearerMintedAt?: string;
  /** (observed) seconds since the worker was last seen (last claim/heartbeat), when any. */
  workerLastSeenSec?: number;
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
 * The credential-age alarm policy (issue #23 / D-10) — a PURE function so the thresholds are
 * unit-testable without a DB: WARN once the bearer is at least the SLA's warn age, ERROR once it is
 * at least the error age. Tuned to the nightly-mint cadence (warn = a missed nightly, error =
 * approaching real expiry), NOT a 1×/2× multiplier. Returns the computed age so the caller can
 * surface it on the source health.
 */
export function credentialAgeAlarm(
  mintedAtIso: string,
  sla: CredentialSla,
  now: number = Date.now(),
): CredentialAgeAlarm {
  const ageSec = Math.max(0, Math.floor((now - Date.parse(mintedAtIso)) / 1000));
  if (sla.errorSec > 0 && ageSec >= sla.errorSec) {
    return {
      status: 'error',
      ageSec,
      message: `bearer minted ${ageSec}s ago ≥ error SLA (${sla.errorSec}s)`,
    };
  }
  if (sla.warnSec > 0 && ageSec >= sla.warnSec) {
    return {
      status: 'warn',
      ageSec,
      message: `bearer minted ${ageSec}s ago ≥ warn SLA (${sla.warnSec}s)`,
    };
  }
  return {
    status: 'ok',
    ageSec,
    message: `bearer minted ${ageSec}s ago (within SLA: warn ${sla.warnSec}s / error ${sla.errorSec}s)`,
  };
}

/**
 * IN-CORE (PROBE) health — the provider's own `test()` reachability/credential probe, ENRICHED with
 * the credential-age + selector-drift alarms. This is the ORIGINAL model, unchanged, and is used for
 * `in_core` providers whose `test()` runs entirely inside the core.
 */
async function probedHealth(
  source: Source,
  provider: SourceProvider,
  exec?: DbClient,
): Promise<SourceHealth> {
  const ctx = buildContext(source, provider.stateNamespace, exec);
  const base = await provider.test(ctx);

  let status: HealthStatus4 = base.status;
  let message = base.message;
  let credentialAgeSec = base.credentialAgeSec;
  let selectorDriftHits = base.selectorDriftHits;

  // --- credential-age alarm (D-10) — read the provider's last-minted-session directly, so the
  //     alarm fires even when test() reported another status. Only for providers that declare a
  //     bearer-freshness SLA (cron providers with a resolved warn/error pair).
  const sla = resolveCredentialSla(provider.scheduling);
  if (sla) {
    const session = await createStateStore(provider.stateNamespace, exec).get<{
      mintedAt?: string;
    }>('session');
    if (session?.mintedAt) {
      const alarm = credentialAgeAlarm(session.mintedAt, sla);
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

  return {
    sourceId: source.id,
    providerId: source.providerId,
    status,
    checkedAt: base.checkedAt,
    healthModel: 'probe',
    runtime: provider.runtime,
    ...(message !== undefined ? { message } : {}),
    ...(credentialAgeSec !== undefined ? { credentialAgeSec } : {}),
    ...(selectorDriftHits !== undefined ? { selectorDriftHits } : {}),
  };
}

/**
 * OUT-OF-PROCESS (OBSERVED) health — DESIGN-045 D-03/D-05/D-10. NEVER calls the provider's `test()`:
 * an out_of_process provider's credentials live only in its worker (the D-05/D-21 split), so a
 * core-side `test()` would false-alarm on "missing credentials". Health is derived from OBSERVED
 * state the core already stores. Missing worker env is NOT a failure here — a worker genuinely
 * lacking creds surfaces as failed runs / alarms via (a), which this model reflects honestly.
 */
async function observedHealth(
  source: Source,
  provider: SourceProvider,
  exec?: DbClient,
): Promise<SourceHealth> {
  const checkedAt = new Date().toISOString();
  let status: HealthStatus4 = 'ok';
  const notes: string[] = [];
  let credentialAgeSec: number | undefined;
  let selectorDriftHits: number | undefined;
  let bearerMintedAt: string | undefined;
  let lastRunStatus: RunStatus | undefined;
  let lastRunAt: string | undefined;
  let workerLastSeenSec: number | undefined;

  // (b) bearer/credential freshness — the last-minted-session age vs the SLA (D-07/D-10).
  const sla = resolveCredentialSla(provider.scheduling);
  const session = await createStateStore(provider.stateNamespace, exec).get<{
    mintedAt?: string;
  }>('session');
  if (session?.mintedAt) {
    bearerMintedAt = session.mintedAt;
    if (sla) {
      const alarm = credentialAgeAlarm(session.mintedAt, sla);
      credentialAgeSec = alarm.ageSec;
      notes.push(alarm.message);
      if (alarm.status !== 'ok') status = escalate(status, alarm.status);
    } else {
      credentialAgeSec = Math.max(
        0,
        Math.floor((Date.now() - Date.parse(session.mintedAt)) / 1000),
      );
      notes.push(`bearer minted ${credentialAgeSec}s ago`);
    }
  } else {
    // No bearer minted yet — the downloader has no token, but this is a pre-first-run state, not a
    // failure. WARN so it is visible without turning overall health red on a brand-new source.
    status = escalate(status, 'warn');
    notes.push('no bearer minted yet');
  }

  // (a) last completed run status + recorded alarms (D-10).
  const lastRun = await getLastRunForProvider(source.providerId, exec);
  if (lastRun) {
    lastRunStatus = lastRun.status;
    lastRunAt = (lastRun.finishedAt ?? lastRun.startedAt).toISOString();
    const telemetry = lastRun.telemetry as {
      selectorDriftHits?: number;
      alarms?: Array<{ kind?: string }>;
    };
    const drift = Number(telemetry.selectorDriftHits ?? 0);
    if (drift > 0) {
      selectorDriftHits = drift;
      status = escalate(status, 'warn');
      notes.push(`selector drift ${drift}`);
    }
    const alarmKinds = Array.isArray(telemetry.alarms)
      ? telemetry.alarms.map((a) => a?.kind).filter((k): k is string => typeof k === 'string')
      : [];
    if (lastRun.status === 'error') {
      status = escalate(status, 'error');
      notes.push(
        alarmKinds.length ? `last run failed (${alarmKinds.join(', ')})` : 'last run failed',
      );
    } else if (lastRun.status === 'warn') {
      status = escalate(status, 'warn');
      notes.push(
        alarmKinds.length ? `last run warned (${alarmKinds.join(', ')})` : 'last run warned',
      );
    } else {
      notes.push(`last run ${lastRun.status}`);
    }
  } else {
    notes.push('no runs yet');
  }

  // (c) worker liveness — the last claim/heartbeat age (cheaply visible from the jobs table).
  const liveness = await getWorkerLivenessForProvider(source.providerId, { db: exec });
  if (liveness) {
    workerLastSeenSec = Math.max(
      0,
      Math.floor((Date.now() - liveness.lastSeenAt.getTime()) / 1000),
    );
    if (liveness.stuck) {
      status = escalate(status, 'warn');
      notes.push('worker heartbeat stale on an in-flight job');
    }
  }

  return {
    sourceId: source.id,
    providerId: source.providerId,
    status,
    checkedAt,
    healthModel: 'observed',
    runtime: provider.runtime,
    message: notes.join('; '),
    ...(credentialAgeSec !== undefined ? { credentialAgeSec } : {}),
    ...(selectorDriftHits !== undefined ? { selectorDriftHits } : {}),
    ...(bearerMintedAt !== undefined ? { bearerMintedAt } : {}),
    ...(lastRunStatus !== undefined ? { lastRunStatus } : {}),
    ...(lastRunAt !== undefined ? { lastRunAt } : {}),
    ...(workerLastSeenSec !== undefined ? { workerLastSeenSec } : {}),
  };
}

export async function collectHealth(exec?: DbClient): Promise<ServiceHealth> {
  const sources = await listSources(exec);
  const results: SourceHealth[] = [];
  let overall: 'ok' | 'warn' | 'error' = 'ok';

  for (const source of sources) {
    try {
      const provider = getProvider(source.providerId);
      const sh =
        provider.runtime === 'out_of_process'
          ? await observedHealth(source, provider, exec)
          : await probedHealth(source, provider, exec);
      results.push(sh);
      overall = worse(overall, sh.status);
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
