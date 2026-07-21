import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger';
import { AuthError, ConflictError, NotFoundError, ValidationError } from '../errors';
import { apiKeyAuth, apiKeyLabel, type AuthMode } from './auth';
import { buildOpenApiDocument, type OpenApiRoute } from './openapi';
import { registerConsole } from './console';
import {
  createLibraryBody,
  claimJobBody,
  claimJobResponse,
  createRemediationBody,
  createRunBody,
  createSourceBody,
  discoveryOutcomeDto,
  entryListDto,
  failJobBody,
  failJobResponse,
  healthDto,
  heartbeatJobBody,
  idParam,
  importSummaryDto,
  importYtdlSubBody,
  libraryDto,
  okDto,
  providerDto,
  remediationJobDto,
  reportJobBody,
  reportJobResponse,
  runDto,
  sourceDto,
  updateLibraryBody,
  updateSourceBody,
} from './schemas';
import { toLibraryDto, toProviderDto, toRemediationJobDto, toRunDto, toSourceDto } from './mappers';
import { getProvider, listProviders } from '../core/registry';
import { collectHealth } from '../core/health';
import { runDiscovery } from '../core/discovery';
import {
  createLibrary,
  deleteLibrary,
  getLibrary,
  listLibraries,
  updateLibrary,
} from '../domain/libraries';
import {
  createSource,
  deleteSource,
  getSource,
  listSources,
  setSourceEnabled,
  updateSource,
} from '../domain/sources';
import { listEntriesForSource } from '../domain/entries';
import { parseSubscriptionsYaml, applyYtdlSubImport } from '../core/import-ytdl-sub';
import { claimJob, failJob, heartbeatJob } from '../core/jobs';
import { reportJob } from '../core/report';
import { getRun, listRuns } from '../domain/runs';
import {
  createRemediationJob,
  listRemediationJobs,
  requireRemediationJob,
} from '../domain/remediation';

interface RouteDef extends OpenApiRoute {
  handler: (c: Context) => Promise<Response> | Response;
}

export interface CreateAppOptions {
  apiKeys: readonly string[];
  /** D-21 — API gate mode. Defaults to `api-key` (a key is required); `open` needs no key (LAN-only). */
  authMode?: AuthMode;
  projectionRoot?: string;
  /** D-05 — base for a Library's relative credentialPath (bearer.txt / cookies.txt delivery). */
  credentialRoot?: string;
  /** D-03 — reclaim SLA + retry ceiling for the out-of-process transport. */
  jobHeartbeatExpirySec?: number;
  jobMaxAttempts?: number;
  /** Where the built operator-console assets live (tests override; prod/dev auto-resolve). */
  consoleDir?: string;
}

const limitQuery = z.object({ limit: z.coerce.number().int().positive().optional() });

async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError('invalid or missing JSON body');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError('request body failed validation', result.error.issues);
  }
  return result.data;
}

function json<T extends z.ZodType>(
  c: Context,
  schema: T,
  data: unknown,
  status: 200 | 201 = 200,
): Response {
  return c.json(schema.parse(data) as object, status);
}

function limitFromQuery(c: Context): number {
  const parsed = limitQuery.safeParse({ limit: c.req.query('limit') });
  return parsed.success && parsed.data.limit ? parsed.data.limit : 50;
}

/** A declared route param is always present; narrow the Hono `string | undefined` to `string`. */
function reqParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (value === undefined) throw new ValidationError(`missing route parameter: ${name}`);
  return value;
}

async function requireLibrary(id: string) {
  const lib = await getLibrary(id);
  if (!lib) throw new NotFoundError('library', id);
  return lib;
}

async function requireSource(id: string) {
  const src = await getSource(id);
  if (!src) throw new NotFoundError('source', id);
  return src;
}

function buildRoutes(opts: CreateAppOptions): RouteDef[] {
  return [
    // --- health (open) ------------------------------------------------------------------------
    {
      method: 'get',
      path: '/health',
      summary: 'Service + per-source health (C7 / D-10)',
      tags: ['health'],
      auth: false,
      response: healthDto,
      handler: async (c) => {
        const health = await collectHealth();
        return json(c, healthDto, {
          status: health.status,
          service: 'ytdrivarr',
          providers: listProviders().map(toProviderDto),
          sources: health.sources,
        });
      },
    },

    // --- providers ----------------------------------------------------------------------------
    {
      method: 'get',
      path: '/api/v1/providers',
      summary: 'List registered providers and their declared capabilities (C1 / D-04)',
      tags: ['providers'],
      auth: true,
      response: z.array(providerDto),
      handler: (c) => json(c, z.array(providerDto), listProviders().map(toProviderDto)),
    },

    // --- libraries ----------------------------------------------------------------------------
    {
      method: 'get',
      path: '/api/v1/libraries',
      summary: 'List libraries',
      tags: ['libraries'],
      auth: true,
      response: z.array(libraryDto),
      handler: async (c) => json(c, z.array(libraryDto), (await listLibraries()).map(toLibraryDto)),
    },
    {
      method: 'post',
      path: '/api/v1/libraries',
      summary: 'Create a library',
      tags: ['libraries'],
      auth: true,
      request: { body: createLibraryBody },
      response: libraryDto,
      handler: async (c) => {
        const body = await parseBody(c, createLibraryBody);
        const lib = await createLibrary(body);
        return json(c, libraryDto, toLibraryDto(lib), 201);
      },
    },
    {
      method: 'get',
      path: '/api/v1/libraries/:id',
      summary: 'Get a library',
      tags: ['libraries'],
      auth: true,
      request: { params: idParam },
      response: libraryDto,
      handler: async (c) =>
        json(c, libraryDto, toLibraryDto(await requireLibrary(reqParam(c, 'id')))),
    },
    {
      method: 'patch',
      path: '/api/v1/libraries/:id',
      summary: 'Update a library',
      tags: ['libraries'],
      auth: true,
      request: { params: idParam, body: updateLibraryBody },
      response: libraryDto,
      handler: async (c) => {
        const body = await parseBody(c, updateLibraryBody);
        const lib = await updateLibrary({ id: reqParam(c, 'id'), patch: body });
        return json(c, libraryDto, toLibraryDto(lib));
      },
    },
    {
      method: 'delete',
      path: '/api/v1/libraries/:id',
      summary: 'Delete a library',
      tags: ['libraries'],
      auth: true,
      request: { params: idParam },
      response: okDto,
      handler: async (c) => {
        await deleteLibrary(reqParam(c, 'id'));
        return json(c, okDto, { ok: true });
      },
    },

    // --- sources ------------------------------------------------------------------------------
    {
      method: 'get',
      path: '/api/v1/sources',
      summary: 'List sources',
      tags: ['sources'],
      auth: true,
      response: z.array(sourceDto),
      handler: async (c) => json(c, z.array(sourceDto), (await listSources()).map(toSourceDto)),
    },
    {
      method: 'post',
      path: '/api/v1/sources',
      summary: 'Add a source (writes a machine-level audit row in the same transaction, D-08)',
      tags: ['sources'],
      auth: true,
      request: { body: createSourceBody },
      response: sourceDto,
      handler: async (c) => {
        const body = await parseBody(c, createSourceBody);
        await requireLibrary(body.libraryId);
        const provider = getProvider(body.providerId); // throws → 500-mapped; validated below
        const settings = body.settings ?? {};
        const settingsCheck = provider.settingsSchema.safeParse(settings);
        if (!settingsCheck.success) {
          throw new ValidationError(
            'source settings failed the provider schema',
            settingsCheck.error.issues,
          );
        }
        const source = await createSource({
          libraryId: body.libraryId,
          providerId: body.providerId,
          kind: body.kind,
          mediaKind: body.mediaKind ?? 'video',
          displayName: body.displayName,
          ref: body.ref,
          settings,
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.createdBy !== undefined ? { createdBy: body.createdBy } : {}),
          ...(body.capsContext !== undefined ? { capsContext: body.capsContext } : {}),
          apiKeyId: apiKeyLabel(c),
        });
        return json(c, sourceDto, toSourceDto(source), 201);
      },
    },
    {
      method: 'get',
      path: '/api/v1/sources/:id',
      summary: 'Get a source',
      tags: ['sources'],
      auth: true,
      request: { params: idParam },
      response: sourceDto,
      handler: async (c) => json(c, sourceDto, toSourceDto(await requireSource(reqParam(c, 'id')))),
    },
    {
      method: 'get',
      path: '/api/v1/sources/:id/entries',
      summary: 'List the discovered subscription entries for a source',
      tags: ['sources'],
      auth: true,
      request: { params: idParam },
      response: entryListDto,
      handler: async (c) => {
        const id = reqParam(c, 'id');
        await requireSource(id);
        const rows = await listEntriesForSource(id);
        return json(
          c,
          entryListDto,
          rows.map((r) => ({
            id: r.id,
            sourceId: r.sourceId,
            entryKey: r.entryKey,
            displayName: r.displayName,
            downloadRef: r.downloadRef,
            preset: r.preset,
            chip: r.chip,
            overrides: r.overrides,
            ytdlOptions: r.ytdlOptions,
            seasonNumber: r.seasonNumber,
            episodeNumber: r.episodeNumber,
          })),
        );
      },
    },
    {
      method: 'patch',
      path: '/api/v1/sources/:id',
      summary: 'Edit a source (audited same-tx, D-08)',
      tags: ['sources'],
      auth: true,
      request: { params: idParam, body: updateSourceBody },
      response: sourceDto,
      handler: async (c) => {
        const id = reqParam(c, 'id');
        const body = await parseBody(c, updateSourceBody);
        await requireSource(id);
        const apiKeyId = apiKeyLabel(c);
        if (body.enabled !== undefined) {
          await setSourceEnabled({ id, enabled: body.enabled, apiKeyId });
        }
        const patch: Record<string, unknown> = {};
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.ref !== undefined) patch.ref = body.ref;
        if (body.settings !== undefined) patch.settings = body.settings;
        if (body.mediaKind !== undefined) patch.mediaKind = body.mediaKind;
        if (body.capsContext !== undefined) patch.capsContext = body.capsContext;
        if (Object.keys(patch).length > 0) {
          await updateSource({ id, patch, apiKeyId });
        }
        return json(c, sourceDto, toSourceDto(await requireSource(id)));
      },
    },
    {
      method: 'delete',
      path: '/api/v1/sources/:id',
      summary: 'Remove a source (audited same-tx, D-08)',
      tags: ['sources'],
      auth: true,
      request: { params: idParam },
      response: okDto,
      handler: async (c) => {
        await deleteSource({ id: reqParam(c, 'id'), apiKeyId: apiKeyLabel(c) });
        return json(c, okDto, { ok: true });
      },
    },

    // --- import (ytdl-sub subscriptions.yaml takeover, D-19 M2) -------------------------------
    {
      method: 'post',
      path: '/api/v1/import/ytdl-sub',
      summary:
        'Import an existing ytdl-sub subscriptions.yaml into Sources — idempotent, media-kind aware',
      tags: ['import'],
      auth: true,
      request: { body: importYtdlSubBody },
      response: importSummaryDto,
      handler: async (c) => {
        const body = await parseBody(c, importYtdlSubBody);
        await requireLibrary(body.videoLibraryId);
        const parsed = parseSubscriptionsYaml(
          body.subscriptionsYaml,
          body.musicChip !== undefined ? { musicChip: body.musicChip } : {},
        );
        const hasMusic = parsed.channels.some((ch) => ch.mediaKind === 'music');
        if (hasMusic) {
          if (!body.musicLibraryId) {
            throw new ValidationError(
              'the file contains music channels but no musicLibraryId was provided',
            );
          }
          await requireLibrary(body.musicLibraryId);
        }
        const summary = await applyYtdlSubImport(
          parsed,
          {
            videoLibraryId: body.videoLibraryId,
            ...(body.musicLibraryId !== undefined ? { musicLibraryId: body.musicLibraryId } : {}),
          },
          {
            apiKeyId: apiKeyLabel(c),
            ...(body.applyPreset !== undefined ? { applyPreset: body.applyPreset } : {}),
          },
        );
        return json(c, importSummaryDto, { ...summary, presetNames: parsed.presetNames }, 201);
      },
    },

    // --- runs (discovery) ---------------------------------------------------------------------
    {
      method: 'get',
      path: '/api/v1/runs',
      summary: 'List discovery/emit runs',
      tags: ['runs'],
      auth: true,
      request: { query: limitQuery },
      response: z.array(runDto),
      handler: async (c) =>
        json(c, z.array(runDto), (await listRuns(limitFromQuery(c))).map(toRunDto)),
    },
    {
      method: 'post',
      path: '/api/v1/runs',
      summary: 'Trigger a discovery run and project rendered config (D-06/D-14)',
      tags: ['runs'],
      auth: true,
      request: { body: createRunBody },
      response: discoveryOutcomeDto,
      handler: async (c) => {
        const body = await parseBody(c, createRunBody);
        const outcome = await runDiscovery({
          scope: body.scope,
          ...(body.scopeRef !== undefined ? { scopeRef: body.scopeRef } : {}),
          ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
          ...(opts.projectionRoot !== undefined ? { projectionRoot: opts.projectionRoot } : {}),
        });
        return json(c, discoveryOutcomeDto, outcome, 201);
      },
    },
    {
      method: 'get',
      path: '/api/v1/runs/:id',
      summary: 'Get a run',
      tags: ['runs'],
      auth: true,
      request: { params: idParam },
      response: runDto,
      handler: async (c) => {
        const run = await getRun(reqParam(c, 'id'));
        if (!run) throw new NotFoundError('run', reqParam(c, 'id'));
        return json(c, runDto, toRunDto(run));
      },
    },

    // --- remediation --------------------------------------------------------------------------
    {
      method: 'get',
      path: '/api/v1/remediation',
      summary: 'List remediation (Fix) jobs',
      tags: ['remediation'],
      auth: true,
      request: { query: limitQuery },
      response: z.array(remediationJobDto),
      handler: async (c) =>
        json(
          c,
          z.array(remediationJobDto),
          (await listRemediationJobs(limitFromQuery(c))).map(toRemediationJobDto),
        ),
    },
    {
      method: 'post',
      path: '/api/v1/remediation',
      summary: 'Queue a per-item Fix (C6 / D-09) — the re-download itself is M5',
      tags: ['remediation'],
      auth: true,
      request: { body: createRemediationBody },
      response: remediationJobDto,
      handler: async (c) => {
        const body = await parseBody(c, createRemediationBody);
        await requireSource(body.sourceId);
        const job = await createRemediationJob({
          sourceId: body.sourceId,
          entryKey: body.entryKey,
          action: body.action,
          requestedBy: apiKeyLabel(c),
        });
        return json(c, remediationJobDto, toRemediationJobDto(job), 201);
      },
    },
    {
      method: 'get',
      path: '/api/v1/remediation/:id',
      summary: 'Get a remediation job',
      tags: ['remediation'],
      auth: true,
      request: { params: idParam },
      response: remediationJobDto,
      handler: async (c) =>
        json(
          c,
          remediationJobDto,
          toRemediationJobDto(await requireRemediationJob(reqParam(c, 'id'))),
        ),
    },

    // --- out-of-process transport (D-03) — the Python worker's HTTP contract -------------------
    {
      method: 'post',
      path: '/api/v1/jobs/claim',
      summary: 'Claim the oldest queued/reclaimable job (FOR UPDATE SKIP LOCKED, D-03)',
      tags: ['jobs'],
      auth: true,
      request: { body: claimJobBody },
      response: claimJobResponse,
      handler: async (c) => {
        const body = await parseBody(c, claimJobBody);
        const job = await claimJob({
          worker: body.worker,
          ...(body.kinds !== undefined ? { kinds: body.kinds } : {}),
          ...(body.providerId !== undefined ? { providerId: body.providerId } : {}),
          ...(opts.jobHeartbeatExpirySec !== undefined
            ? { heartbeatExpirySec: opts.jobHeartbeatExpirySec }
            : {}),
        });
        return json(c, claimJobResponse, { job });
      },
    },
    {
      method: 'post',
      path: '/api/v1/jobs/:id/heartbeat',
      summary: 'Refresh a claimed job heartbeat + flip claimed→running (409 if reclaimed, D-03)',
      tags: ['jobs'],
      auth: true,
      request: { params: idParam, body: heartbeatJobBody },
      response: okDto,
      handler: async (c) => {
        const body = await parseBody(c, heartbeatJobBody);
        const res = await heartbeatJob({ id: reqParam(c, 'id'), worker: body.worker });
        return json(c, okDto, res);
      },
    },
    {
      method: 'post',
      path: '/api/v1/jobs/:id/report',
      summary:
        'Report scraped entries + session + telemetry; core merges, delivers, emits, finalizes',
      tags: ['jobs'],
      auth: true,
      request: { params: idParam, body: reportJobBody },
      response: reportJobResponse,
      handler: async (c) => {
        const body = await parseBody(c, reportJobBody);
        const outcome = await reportJob({
          id: reqParam(c, 'id'),
          worker: body.worker,
          result: body.result,
          ...(opts.projectionRoot !== undefined ? { projectionRoot: opts.projectionRoot } : {}),
          ...(opts.credentialRoot !== undefined ? { credentialRoot: opts.credentialRoot } : {}),
        });
        return json(c, reportJobResponse, outcome);
      },
    },
    {
      method: 'post',
      path: '/api/v1/jobs/:id/fail',
      summary: 'Report a job failure (retryable → requeue + alarm; else finalize Run error, D-03)',
      tags: ['jobs'],
      auth: true,
      request: { params: idParam, body: failJobBody },
      response: failJobResponse,
      handler: async (c) => {
        const body = await parseBody(c, failJobBody);
        const res = await failJob({
          id: reqParam(c, 'id'),
          worker: body.worker,
          error: body.error,
          retryable: body.retryable,
          ...(body.alarm !== undefined ? { alarm: body.alarm } : {}),
          ...(opts.jobMaxAttempts !== undefined ? { maxAttempts: opts.jobMaxAttempts } : {}),
        });
        return json(c, failJobResponse, res);
      },
    },
  ];
}

export function createApp(opts: CreateAppOptions): Hono {
  const app = new Hono();
  const authMw = apiKeyAuth(opts.apiKeys, opts.authMode);
  const routes = buildRoutes(opts);

  app.get('/livez', (c) => c.json({ status: 'ok' }));
  // The operator console (D-20): `/` + `/ui/*`. The static shell carries no data — every fetch
  // the SPA makes rides the same X-Api-Key auth as any other API caller (D-21).
  registerConsole(app, opts.consoleDir);
  app.get('/openapi.json', (c) =>
    c.json(
      buildOpenApiDocument(routes, {
        title: 'ytdrivarr',
        version: '0.1.0',
        description: 'The *arr-shaped ytdl-content suite service (DESIGN-045).',
      }),
    ),
  );

  for (const route of routes) {
    const chain = route.auth ? [authMw, route.handler] : [route.handler];
    app.on(route.method.toUpperCase(), [route.path], ...chain);
  }

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) {
      return c.json({ error: err.message, details: err.details }, 400);
    }
    if (err instanceof AuthError) return c.json({ error: err.message }, 401);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof z.ZodError)
      return c.json({ error: 'validation failed', details: err.issues }, 400);
    logger.error({ err }, 'unhandled API error');
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
