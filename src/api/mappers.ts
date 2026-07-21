import type { Library, RemediationJob, Run, Source } from '../db/schema';
import type { SourceProvider } from '../contracts';
import { renderRunSummaryMarkdown, type RunSummary } from '../domain/run-summary';
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

export function toSourceDto(row: Source): SourceDto {
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
  };
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
  };
}
