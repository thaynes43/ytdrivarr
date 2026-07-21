import { z } from 'zod';

/**
 * Connection config = environment/secrets only (DESIGN-045 D-01). Nothing behavioral lives in
 * env beyond caps/toggles; source/library behaviour is durable DB state the service re-renders.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  /** D-21 — a single API key guards the API (comma-separated for rotation, ESO-friendly). */
  YTDRIVARR_API_KEYS: z.string().default(''),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default('info'),
  /** D-14 — the base of the downloader-mounted projection volume (per-Library projectionPath is
   * resolved under this root when relative). */
  PROJECTION_ROOT: z.string().optional(),
  /** D-05 — the base a Library's (relative) credentialPath resolves under for session artifacts
   * (bearer.txt / cookies.txt). Falls back to PROJECTION_ROOT, then cwd (tests). */
  CREDENTIAL_ROOT: z.string().optional(),
  /** D-03 — a claimed/running job is reclaimable once its heartbeat is older than this SLA. */
  JOB_HEARTBEAT_EXPIRY_SEC: z.coerce.number().int().positive().default(120),
  /** D-03 — the retry ceiling: a retryable fail past this many attempts finalizes the Run as error. */
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  YTDRIVARR_SKIP_MIGRATE: z.string().optional(),
});

export interface AppConfig {
  databaseUrl: string | undefined;
  apiKeys: string[];
  port: number;
  logLevel: string;
  projectionRoot: string | undefined;
  credentialRoot: string | undefined;
  jobHeartbeatExpirySec: number;
  jobMaxAttempts: number;
  skipMigrate: boolean;
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const apiKeys = parsed.YTDRIVARR_API_KEYS.split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return {
    databaseUrl: parsed.DATABASE_URL,
    apiKeys,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    projectionRoot: parsed.PROJECTION_ROOT,
    credentialRoot: parsed.CREDENTIAL_ROOT,
    jobHeartbeatExpirySec: parsed.JOB_HEARTBEAT_EXPIRY_SEC,
    jobMaxAttempts: parsed.JOB_MAX_ATTEMPTS,
    skipMigrate: truthy(parsed.YTDRIVARR_SKIP_MIGRATE),
  };
}
