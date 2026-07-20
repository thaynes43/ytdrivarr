import { z } from 'zod';
import { mediaKindSchema } from '../contracts';
import { remediationActionSchema } from '../contracts';

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
  status: z.enum(['ok', 'warn', 'error']),
  counts: z.record(z.string(), z.number()),
  projected: z.array(z.object({ libraryId: z.string(), dir: z.string() })),
});

export const errorDto = z.object({ error: z.string(), details: z.unknown().optional() });

export const okDto = z.object({ ok: z.literal(true) });

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

export const idParam = z.object({ id: z.string() });
