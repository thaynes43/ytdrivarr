import type { Library, RemediationJob, Run, Source } from '../db/schema';
import type { SourceProvider } from '../contracts';
import { renderRunSummaryMarkdown, type RunSummary } from '../domain/run-summary';
import { effectivePelotonCap, pelotonSettingsSchema } from '../providers/peloton';
import type { LibraryDto, ProviderDto, RemediationJobDto, RunDto, SourceDto } from './schemas';

export function toLibraryDto(row: Library): LibraryDto {
  return {
    id: row.id,
    name: row.name,
    player: row.player,
    mediaRoot: row.mediaRoot,
    libraryKind: row.libraryKind,
    presetName: row.presetName,
    projectionPath: row.projectionPath,
    workingDirectory: row.workingDirectory,
    credentialPath: row.credentialPath,
    emitPolicy: row.emitPolicy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The console-facing enrichment carried on a source DTO (all optional, computed by the API). */
export interface SourceEnrichment {
  entryCount?: number;
  lastRunAt?: string | null;
  lastRunStatus?: 'running' | 'ok' | 'warn' | 'error' | null;
}

/**
 * The EFFECTIVE cap column value: Peloton sources resolve their per-source override against the
 * global default; uncapped providers (a YouTube channel) carry null. Settings that fail the
 * provider schema (never expected post-migration) also resolve to the global default, honestly.
 */
export function sourceEffectiveCap(row: Pick<Source, 'providerId' | 'settings'>): number | null {
  if (row.providerId !== 'peloton') return null;
  const parsed = pelotonSettingsSchema.safeParse(row.settings);
  return effectivePelotonCap(parsed.success ? parsed.data : {});
}

export function toSourceDto(row: Source, enrichment?: SourceEnrichment): SourceDto {
  return {
    id: row.id,
    libraryId: row.libraryId,
    providerId: row.providerId,
    kind: row.kind,
    mediaKind: row.mediaKind,
    displayName: row.displayName,
    ref: row.ref,
    settings: row.settings,
    enabled: row.enabled,
    createdBy: row.createdBy,
    capsContext: row.capsContext,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(enrichment !== undefined
      ? {
          entryCount: enrichment.entryCount ?? 0,
          effectiveCap: sourceEffectiveCap(row),
          lastRunAt: enrichment.lastRunAt ?? null,
          lastRunStatus: enrichment.lastRunStatus ?? null,
        }
      : {}),
  };
}

/**
 * The most recent Run covering each source: scope `all`, its library, the source itself, or its
 * `provider` (the per-provider scheduled tick covers only that provider's sources) — `runs` MUST be
 * sorted most-recent-first (the listRuns order). Pure, so the coverage rule is unit-testable
 * without a database.
 */
export function lastRunBySource(
  sources: readonly Pick<Source, 'id' | 'libraryId' | 'providerId'>[],
  runs: readonly Pick<Run, 'scope' | 'scopeRef' | 'providerId' | 'status' | 'startedAt'>[],
): Map<string, { at: string; status: 'running' | 'ok' | 'warn' | 'error' }> {
  const result = new Map<string, { at: string; status: 'running' | 'ok' | 'warn' | 'error' }>();
  for (const source of sources) {
    const hit = runs.find(
      (run) =>
        run.scope === 'all' ||
        (run.scope === 'library' && run.scopeRef === source.libraryId) ||
        (run.scope === 'source' && run.scopeRef === source.id) ||
        (run.scope === 'provider' && run.providerId === source.providerId),
    );
    if (hit) result.set(source.id, { at: hit.startedAt.toISOString(), status: hit.status });
  }
  return result;
}

export function toRunDto(row: Run): RunDto {
  return {
    id: row.id,
    scope: row.scope,
    scopeRef: row.scopeRef,
    trigger: row.trigger,
    providerId: row.providerId,
    status: row.status,
    counts: row.counts,
    telemetry: row.telemetry,
    summary: row.summary ?? null,
    summaryMarkdown: row.summary
      ? renderRunSummaryMarkdown(row.summary as unknown as RunSummary)
      : null,
    logExcerpt: row.logExcerpt,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export function toRemediationJobDto(row: RemediationJob): RemediationJobDto {
  return {
    id: row.id,
    sourceId: row.sourceId,
    entryKey: row.entryKey,
    action: row.action,
    status: row.status,
    requestedBy: row.requestedBy,
    providerRunId: row.providerRunId,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProviderDto(provider: SourceProvider): ProviderDto {
  return {
    id: provider.id,
    kind: provider.kind,
    runtime: provider.runtime,
    capabilities: [...provider.capabilities],
    mediaKinds: [...provider.mediaKinds],
    stateNamespace: provider.stateNamespace,
    scheduling:
      provider.scheduling.mode === 'cron'
        ? {
            mode: 'cron',
            cron: provider.scheduling.cron,
            ...(provider.scheduling.credentialRefreshSec !== undefined
              ? { credentialRefreshSec: provider.scheduling.credentialRefreshSec }
              : {}),
            ...(provider.scheduling.credentialWarnSec !== undefined
              ? { credentialWarnSec: provider.scheduling.credentialWarnSec }
              : {}),
            ...(provider.scheduling.credentialErrorSec !== undefined
              ? { credentialErrorSec: provider.scheduling.credentialErrorSec }
              : {}),
          }
        : {
            mode: 'event_driven',
            ...(provider.scheduling.safetyCron !== undefined
              ? { safetyCron: provider.scheduling.safetyCron }
              : {}),
          },
  };
}
