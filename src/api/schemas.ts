import { z } from 'zod';
import { mediaKindSchema } from '../contracts';
import { remediationActionSchema } from '../contracts';
import { subscriptionEntrySchema } from '../contracts';

/** Zod schemas for every REST request/response (DESIGN-045 D-01) — OpenAPI is generated from them. */

const jsonObject = z.record(z.string(), z.unknown());

// --- response DTOs ----------------------------------------------------------------------------

export const libraryDto = z.object({
  id: z.string(),
  name: z.string(),
  player: z.string(),
  mediaRoot: z.string(),
  libraryKind: mediaKindSchema,
  presetName: z.string(),
  projectionPath: z.string(),
  workingDirectory: z.string(),
  credentialPath: z.string().nullable(),
  emitPolicy: jsonObject,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LibraryDto = z.infer<typeof libraryDto>;

export const sourceDto = z.object({
  id: z.string(),
  libraryId: z.string(),
  providerId: z.string(),
  kind: z.string(),
  mediaKind: mediaKindSchema,
  displayName: z.string(),
  ref: z.string(),
  settings: jsonObject,
  enabled: z.boolean(),
  createdBy: z.string(),
  capsContext: jsonObject,
  createdAt: z.string(),
  updatedAt: z.string(),
  // --- additive console-facing enrichment (the *arr Sources table columns) --------------------
  /** persisted subscription entries attributed to this source. */
  entryCount: z.number().optional(),
  /** the EFFECTIVE classes-per-scrape cap (per-source override ?? the global default) for a
   * capped provider (Peloton); null for uncapped providers (a YouTube channel has no cap). */
  effectiveCap: z.number().nullable().optional(),
  /** the most recent Run whose scope covered this source (all | its library | itself). */
  lastRunAt: z.string().nullable().optional(),
  lastRunStatus: z.enum(['running', 'ok', 'warn', 'error']).nullable().optional(),
});
export type SourceDto = z.infer<typeof sourceDto>;

export const runDto = z.object({
  id: z.string(),
  scope: z.enum(['all', 'library', 'source']),
  scopeRef: z.string().nullable(),
  trigger: z.enum(['cron', 'api', 'edit']),
  providerId: z.string().nullable(),
  status: z.enum(['running', 'ok', 'warn', 'error']),
  counts: z.record(z.string(), z.number()),
  telemetry: jsonObject,
  /** the owner's Changes/Health/Issues summary object (D-10) — null until the run finalizes. */
  summary: jsonObject.nullable(),
  /** the same summary rendered to markdown (server-side), for the console's summary expander. */
  summaryMarkdown: z.string().nullable(),
  logExcerpt: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RunDto = z.infer<typeof runDto>;

export const remediationJobDto = z.object({
  id: z.string(),
  sourceId: z.string(),
  entryKey: z.string(),
  action: remediationActionSchema,
  status: z.enum(['queued', 'running', 'ok', 'error']),
  requestedBy: z.string(),
  providerRunId: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RemediationJobDto = z.infer<typeof remediationJobDto>;

export const providerDto = z.object({
  id: z.string(),
  kind: z.string(),
  runtime: z.enum(['in_core', 'out_of_process']),
  capabilities: z.array(z.enum(['auth', 'scrape', 'tokenMint', 'assets', 'remediation'])),
  mediaKinds: z.array(mediaKindSchema),
  stateNamespace: z.string(),
  /** the provider's declared discovery cadence (C4/D-07) — additive, for the console's cards. */
  scheduling: z
    .object({
      mode: z.enum(['event_driven', 'cron']),
      cron: z.string().optional(),
      safetyCron: z.string().optional(),
      /** DEPRECATED (issue #23) — the single-knob SLA; prefer the warn/error pair below. */
      credentialRefreshSec: z.number().optional(),
      /** bearer-freshness WARN threshold in seconds (a missed nightly mint). */
      credentialWarnSec: z.number().optional(),
      /** bearer-freshness ERROR threshold in seconds (approaching real expiry). */
      credentialErrorSec: z.number().optional(),
    })
    .optional(),
});
export type ProviderDto = z.infer<typeof providerDto>;

export const sourceHealthDto = z.object({
  sourceId: z.string(),
  providerId: z.string(),
  status: z.enum(['ok', 'warn', 'error', 'unknown']),
  message: z.string().optional(),
  checkedAt: z.string(),
  credentialAgeSec: z.number().optional(),
  selectorDriftHits: z.number().optional(),
  // Additive observed-state fields (out_of_process health model, D-03/D-10) — optional so the
  // existing console rendering stays truthful; a probe-model (in_core) row carries only the first.
  healthModel: z.enum(['probe', 'observed']).optional(),
  runtime: z.enum(['in_core', 'out_of_process']).optional(),
  lastRunStatus: z.enum(['running', 'ok', 'warn', 'error']).optional(),
  lastRunAt: z.string().optional(),
  bearerMintedAt: z.string().optional(),
  workerLastSeenSec: z.number().optional(),
});
export const healthDto = z.object({
  status: z.enum(['ok', 'warn', 'error']),
  service: z.literal('ytdrivarr'),
  providers: z.array(providerDto),
  sources: z.array(sourceHealthDto),
});
export type HealthDto = z.infer<typeof healthDto>;

export const discoveryOutcomeDto = z.object({
  runId: z.string(),
  // `running` when an out_of_process job was queued — the worker report/fail finalizes the Run (D-03).
  status: z.enum(['running', 'ok', 'warn', 'error']),
  counts: z.record(z.string(), z.number()),
  projected: z.array(z.object({ libraryId: z.string(), dir: z.string() })),
});

export const errorDto = z.object({ error: z.string(), details: z.unknown().optional() });

export const okDto = z.object({ ok: z.literal(true) });

/** GET /api/v1/system/status — the System → Status "About" facts (D-20). Honest runtime state
 * only; never secret VALUES (key count yes, keys never). */
export const systemStatusDto = z.object({
  service: z.literal('ytdrivarr'),
  version: z.string(),
  nodeVersion: z.string(),
  /** database reachability + applied drizzle migration count (null when unreachable). */
  database: z.object({
    reachable: z.boolean(),
    migrations: z.number().nullable(),
  }),
  projectionRoot: z.string().nullable(),
  /** D-21 — `open` (keyless on a LAN-only ingress) or `api-key`. */
  authMode: z.enum(['api-key', 'open']),
  apiKeysConfigured: z.number(),
  uptimeSec: z.number(),
  startedAt: z.string(),
});
export type SystemStatusDto = z.infer<typeof systemStatusDto>;

export const entryDto = z.object({
  id: z.string(),
  sourceId: z.string(),
  entryKey: z.string(),
  displayName: z.string(),
  downloadRef: z.string(),
  preset: z.string(),
  chip: z.string().nullable(),
  overrides: jsonObject.nullable(),
  ytdlOptions: jsonObject.nullable(),
  seasonNumber: z.number().nullable(),
  episodeNumber: z.number().nullable(),
});
export const entryListDto = z.array(entryDto);

// --- request bodies ---------------------------------------------------------------------------

export const createLibraryBody = z.object({
  name: z.string().min(1),
  player: z.string().optional(),
  mediaRoot: z.string().min(1),
  libraryKind: mediaKindSchema.optional(),
  presetName: z.string().optional(),
  projectionPath: z.string().min(1),
  workingDirectory: z.string().optional(),
  credentialPath: z.string().optional(),
  emitPolicy: jsonObject.optional(),
});

export const updateLibraryBody = z.object({
  name: z.string().min(1).optional(),
  player: z.string().optional(),
  mediaRoot: z.string().min(1).optional(),
  presetName: z.string().optional(),
  projectionPath: z.string().min(1).optional(),
  workingDirectory: z.string().optional(),
  emitPolicy: jsonObject.optional(),
});

export const createSourceBody = z.object({
  libraryId: z.string().min(1),
  providerId: z.string().min(1),
  kind: z.string().min(1),
  mediaKind: mediaKindSchema.optional(),
  displayName: z.string().min(1),
  ref: z.string().min(1),
  settings: jsonObject.optional(),
  enabled: z.boolean().optional(),
  createdBy: z.string().optional(),
  capsContext: jsonObject.optional(),
});

export const updateSourceBody = z.object({
  displayName: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  settings: jsonObject.optional(),
  mediaKind: mediaKindSchema.optional(),
  enabled: z.boolean().optional(),
  capsContext: jsonObject.optional(),
});

export const createRunBody = z.object({
  scope: z.enum(['all', 'library', 'source']).default('all'),
  scopeRef: z.string().optional(),
  trigger: z.enum(['cron', 'api', 'edit']).optional(),
});

export const createRemediationBody = z.object({
  sourceId: z.string().min(1),
  entryKey: z.string().min(1),
  action: remediationActionSchema,
});

// --- import (operator-grain ytdl-sub subscriptions.yaml takeover, D-19 M2) --------------------

export const importYtdlSubBody = z.object({
  /** the raw ytdl-sub subscriptions.yaml text (the estate's shape). */
  subscriptionsYaml: z.string().min(1),
  /** the target video Library everything non-music imports into. */
  videoLibraryId: z.string().min(1),
  /** the target music Library the `= Music` channels import into (required if any are present). */
  musicLibraryId: z.string().optional(),
  /** the chip that classifies music (default `Music`). */
  musicChip: z.string().optional(),
  /** also set the video Library's emitPolicy from the parsed `__preset__` (default false). */
  applyPreset: z.boolean().optional(),
});

export const importSummaryDto = z.object({
  channels: z.number(),
  video: z.number(),
  music: z.number(),
  created: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  presetApplied: z.boolean(),
  presetNames: z.array(z.string()),
  sources: z.array(
    z.object({
      ref: z.string(),
      mediaKind: mediaKindSchema,
      libraryId: z.string(),
      action: z.enum(['created', 'updated', 'unchanged']),
    }),
  ),
});

export const idParam = z.object({ id: z.string() });

// --- out-of-process transport (the worker HTTP contract, D-03) ---------------------------------

const jobKindDto = z.enum(['discovery', 'remediation']);

/** POST /api/v1/jobs/claim — a worker claims the oldest queued/reclaimable job. */
export const claimJobBody = z.object({
  worker: z.string().min(1),
  kinds: z.array(jobKindDto).optional(),
  providerId: z.string().min(1).optional(),
});

export const claimedJobDto = z.object({
  id: z.string(),
  kind: jobKindDto,
  providerId: z.string(),
  payload: jsonObject,
  attempts: z.number(),
});
export const claimJobResponse = z.object({ job: claimedJobDto.nullable() });

/** POST /api/v1/jobs/:id/heartbeat — refresh ownership + flip claimed→running. */
export const heartbeatJobBody = z.object({ worker: z.string().min(1) });

/** The session artifacts a worker mints and reports for delivery (C2 / D-05). */
export const sessionArtifactsDto = z.object({
  bearer: z.string().optional(),
  cookies: z.string().optional(),
  mintedAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

/** POST /api/v1/jobs/:id/report — a worker reports its scraped entries + session + telemetry. */
export const reportJobBody = z.object({
  worker: z.string().min(1),
  result: z.object({
    entries: z.array(subscriptionEntrySchema),
    session: sessionArtifactsDto.optional(),
    telemetry: jsonObject.optional(),
    summary: jsonObject.optional(),
  }),
});

export const reportJobResponse = z.object({
  jobId: z.string(),
  runId: z.string().nullable(),
  status: z.enum(['ok', 'warn']),
  counts: z.record(z.string(), z.number()),
  merged: z.object({ added: z.number(), updated: z.number() }),
  projected: z.object({ libraryId: z.string(), dir: z.string() }).optional(),
  credential: z.object({ bearer: z.boolean(), cookies: z.boolean() }).optional(),
});

/** POST /api/v1/jobs/:id/fail — a worker reports a failure (retryable → requeue; else finalize error). */
export const failJobBody = z.object({
  worker: z.string().min(1),
  error: z.string().min(1),
  retryable: z.boolean(),
  alarm: z
    .object({
      kind: z.enum(['login', 'bearer_capture', 'selector_drift', 'scroll_timeout']),
      message: z.string().optional(),
    })
    .optional(),
});

export const failJobResponse = z.object({
  status: z.enum(['requeued', 'error']),
  attempts: z.number(),
});
