/**
 * View models for the operator console — hand-mirrored from the server's zod DTOs
 * (`src/api/schemas.ts`). The console is a THIN VIEW over the REST API (DESIGN-045 D-20): it
 * renders exactly what the API returns and adds no capability the API lacks. Keeping these as
 * plain interfaces keeps zod (and the rest of the server) out of the browser bundle.
 */

export type MediaKind = 'video' | 'music';

export interface LibraryDto {
  id: string;
  name: string;
  player: string;
  mediaRoot: string;
  libraryKind: MediaKind;
  presetName: string;
  projectionPath: string;
  workingDirectory: string;
  emitPolicy: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SourceDto {
  id: string;
  libraryId: string;
  providerId: string;
  kind: string;
  mediaKind: MediaKind;
  displayName: string;
  ref: string;
  settings: Record<string, unknown>;
  enabled: boolean;
  createdBy: string;
  capsContext: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RunDto {
  id: string;
  scope: 'all' | 'library' | 'source';
  scopeRef: string | null;
  trigger: 'cron' | 'api' | 'edit';
  providerId: string | null;
  status: 'running' | 'ok' | 'warn' | 'error';
  counts: Record<string, number>;
  telemetry: Record<string, unknown>;
  summary: Record<string, unknown> | null;
  summaryMarkdown: string | null;
  logExcerpt: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ProviderDto {
  id: string;
  kind: string;
  runtime: 'in_core' | 'out_of_process';
  capabilities: ('auth' | 'scrape' | 'tokenMint' | 'assets' | 'remediation')[];
  mediaKinds: MediaKind[];
  stateNamespace: string;
}

export interface SourceHealthDto {
  sourceId: string;
  providerId: string;
  status: 'ok' | 'warn' | 'error' | 'unknown';
  message?: string;
  checkedAt: string;
  credentialAgeSec?: number;
  selectorDriftHits?: number;
}

export interface HealthDto {
  status: 'ok' | 'warn' | 'error';
  service: 'ytdrivarr';
  providers: ProviderDto[];
  sources: SourceHealthDto[];
}
