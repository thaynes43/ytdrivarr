/**
 * View models for the operator console — hand-mirrored from the server's zod DTOs
 * (`src/api/schemas.ts`). The console is a THIN VIEW over the REST API (DESIGN-045 D-20): it
 * renders exactly what the API returns and adds no capability the API lacks. Keeping these as
 * plain interfaces keeps zod (and the rest of the server) out of the browser bundle.
 */

export type MediaKind = 'video' | 'music';

export type RunStatus = 'running' | 'ok' | 'warn' | 'error';

export interface LibraryDto {
  id: string;
  name: string;
  player: string;
  mediaRoot: string;
  libraryKind: MediaKind;
  presetName: string;
  projectionPath: string;
  workingDirectory: string;
  credentialPath: string | null;
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
  // additive console-facing enrichment (present on list/get responses)
  entryCount?: number;
  effectiveCap?: number | null;
  lastRunAt?: string | null;
  lastRunStatus?: RunStatus | null;
}

/** The structured Changes/Health/Issues summary a finalized Run carries (D-10). */
export interface RunSummaryActivityDto {
  activity: string;
  existing: number;
  added: number;
  total: number;
  scraped?: number;
  skipped?: number;
  scrolls?: number;
  cap?: number;
  overCap?: boolean;
  atCap?: boolean;
}

export interface RunSummaryDto {
  changes?: {
    subscriptionsAdded?: number;
    subscriptionsRemoved?: number;
    subscriptionsUnchanged?: number;
    skipped?: number;
    deduped?: number;
    entriesEmitted?: number;
    activities?: RunSummaryActivityDto[];
  };
  health?: {
    authOk?: boolean | null;
    loginOk?: boolean | null;
    bearerMintedAt?: string | null;
    bearerAgeSec?: number | null;
    credentialRefreshSec?: number | null;
    credentialAgeStatus?: string;
    scrollsPerformed?: number | null;
    selectorDriftHits?: number;
  };
  issues?: string[];
}

export interface RunDto {
  id: string;
  scope: 'all' | 'library' | 'source';
  scopeRef: string | null;
  trigger: 'cron' | 'api' | 'edit';
  providerId: string | null;
  status: RunStatus;
  counts: Record<string, number>;
  telemetry: Record<string, unknown>;
  summary: RunSummaryDto | null;
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
  scheduling?: {
    mode: 'event_driven' | 'cron';
    cron?: string;
    safetyCron?: string;
    credentialRefreshSec?: number;
  };
}

export interface SourceHealthDto {
  sourceId: string;
  providerId: string;
  status: 'ok' | 'warn' | 'error' | 'unknown';
  message?: string;
  checkedAt: string;
  credentialAgeSec?: number;
  selectorDriftHits?: number;
  healthModel?: 'probe' | 'observed';
  runtime?: 'in_core' | 'out_of_process';
  lastRunStatus?: RunStatus;
  lastRunAt?: string;
  bearerMintedAt?: string;
  workerLastSeenSec?: number;
}

export interface HealthDto {
  status: 'ok' | 'warn' | 'error';
  service: 'ytdrivarr';
  providers: ProviderDto[];
  sources: SourceHealthDto[];
}

export interface SystemStatusDto {
  service: 'ytdrivarr';
  version: string;
  nodeVersion: string;
  database: { reachable: boolean; migrations: number | null };
  projectionRoot: string | null;
  authMode: 'api-key' | 'open';
  apiKeysConfigured: number;
  uptimeSec: number;
  startedAt: string;
}

export interface ImportSummaryDto {
  channels: number;
  video: number;
  music: number;
  created: number;
  updated: number;
  unchanged: number;
  presetApplied: boolean;
  presetNames: string[];
}
