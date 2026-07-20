import { z } from 'zod';

/**
 * OpenAPI 3.1 generated FROM the zod schemas (DESIGN-045 D-01) — no hand-maintained spec. Each
 * route declares its params/query/body/response as zod; this walks the route table and emits the
 * document served at GET /openapi.json.
 */
export interface OpenApiRoute {
  method: 'get' | 'post' | 'patch' | 'delete';
  /** express-style path, e.g. /api/v1/libraries/:id */
  path: string;
  summary: string;
  tags: string[];
  auth: boolean;
  request?: { params?: z.ZodType; query?: z.ZodType; body?: z.ZodType };
  response: z.ZodType;
}

type JsonSchema = Record<string, unknown>;

function toSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io }) as JsonSchema;
}

function expressToOpenApiPath(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const converted = path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path: converted, params };
}

export function buildOpenApiDocument(
  routes: readonly OpenApiRoute[],
  info: { title: string; version: string; description?: string },
): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const { path: oaPath, params } = expressToOpenApiPath(route.path);
    const operation: Record<string, unknown> = {
      summary: route.summary,
      tags: route.tags,
      security: route.auth ? [{ ApiKeyAuth: [] }] : [],
    };

    const parameters: JsonSchema[] = params.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));

    if (route.request?.query) {
      const querySchema = toSchema(route.request.query, 'input');
      const props = (querySchema.properties ?? {}) as Record<string, JsonSchema>;
      const required = new Set((querySchema.required as string[] | undefined) ?? []);
      for (const [name, schema] of Object.entries(props)) {
        parameters.push({ name, in: 'query', required: required.has(name), schema });
      }
    }
    if (parameters.length > 0) operation.parameters = parameters;

    if (route.request?.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: toSchema(route.request.body, 'input') } },
      };
    }

    operation.responses = {
      '200': {
        description: 'OK',
        content: { 'application/json': { schema: toSchema(route.response, 'output') } },
      },
    };

    paths[oaPath] ??= {};
    paths[oaPath][route.method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      ...(info.description ? { description: info.description } : {}),
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      },
    },
    paths,
  };
}
