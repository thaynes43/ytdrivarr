import { z } from 'zod';
import type {
  AssetDescriptor,
  ProviderContext,
  RemediationAction,
  RemediationResult,
  SessionArtifacts,
  SourceProvider,
  SubscriptionEntry,
} from '../../contracts';

/**
 * The M3 `out_of_process` authenticated-scraper provider (DESIGN-045 D-03/D-05/D-06/D-07/D-10 —
 * Tier-2(b), the first of its class). Peloton declares the FULL lifecycle against the same C1–C8
 * interface a `[]`-capability provider satisfies (the negation contrast, D-04): `auth`, `scrape`,
 * `tokenMint`, `assets`, `remediation`.
 *
 * The heavy legs (headless login, catalog scrape, bearer mint) run in a plugin-owned Python/Selenium
 * worker OUT OF PROCESS — the core NEVER imports Selenium. The core enqueues a discovery job (the
 * dispatcher, via `buildDiscoveryPayload`); the worker claims it, scrapes, and reports
 * `SubscriptionEntry[]` + a minted session back through the transport (`src/core/jobs.ts`). So the
 * in-process hooks below are the CORE-SIDE halves: `test()` is a credential/session-age PROBE (the
 * heavy login is the worker's), `authenticate()` records intent, `discover()` must never run in-core.
 */

/** The Peloton `session` state shape parked in provider state (namespace `peloton`, key `session`). */
export interface PelotonSessionState {
  mintedAt?: string;
  expiresAt?: string;
}

/**
 * The GLOBAL default classes-per-activity cap (the owner's watch-grain caps model): one default,
 * overridable per Source via `settings.maxClassesPerActivity`. A per-activity Source whose settings
 * OMIT the override tracks this default; a set value pins that activity.
 */
export const DEFAULT_MAX_CLASSES_PER_ACTIVITY = 25;

/**
 * The Source settings a per-activity Peloton Source carries (validated on add/edit). Since the
 * watch-grain split (migration 0002) a Peloton Source IS one activity — `source.ref` carries the
 * activity SLUG (`cycling`, `bike_bootcamp`, …) and there is NO `activities[]` array anymore.
 * Defaults mirror the estate's live scrape profile (dynamic scrolling, the donor's wait profile:
 * page_load_wait=10, login_wait=15, scroll_pause=3). The discovery payload builder AGGREGATES the
 * enabled activity Sources of a Library into one scrape job (`buildPelotonDiscoveryPayloads`), so
 * the worker still logs in once and walks every monitored activity.
 */
export const pelotonSettingsSchema = z.object({
  /**
   * Per-Source cap override. ABSENT (the normal state) means the Source tracks the global default
   * (`DEFAULT_MAX_CLASSES_PER_ACTIVITY`); present pins this activity's own cap.
   */
  maxClassesPerActivity: z.number().int().positive().optional(),
  dynamicScrolling: z.boolean().default(true),
  maxScrolls: z.number().int().positive().default(250),
  scrollPauseSec: z.number().positive().default(3),
  pageLoadWaitSec: z.number().positive().default(10),
  loginWaitSec: z.number().positive().default(15),
  /**
   * Optional filesystem root to scan for already-downloaded episodes (the DISK half of the donor's
   * merged episode data, D-06). When set, the payload builder walks
   * `{diskScanPath}/{Activity}/{Instructor}/S{season}E{episode} …/` leaf folders and merges the
   * per-(activity, duration) episode maxima into the subscription-derived numbering seed (max per
   * key wins). Undefined (default) skips the disk scan. In-cluster this is `/projections/peloton`:
   * the core mounts the media tree at `/projections`, while the downloader sees the same tree at
   * `/media/peloton`.
   */
  diskScanPath: z.string().min(1).optional(),
});
export type PelotonSettings = z.infer<typeof pelotonSettingsSchema>;

/**
 * The EFFECTIVE cap for a per-activity Source: its own override when set, else the global default.
 * The console's Cap column and the payload builder both read this — one resolution rule.
 */
export function effectivePelotonCap(settings: Pick<PelotonSettings, 'maxClassesPerActivity'>) {
  return settings.maxClassesPerActivity ?? DEFAULT_MAX_CLASSES_PER_ACTIVITY;
}

/** The credentials ESO injects into the provider context (C2 — the core injects, never hardcodes). */
export const PELOTON_SECRET_KEYS = ['PELOTON_USERNAME', 'PELOTON_PASSWORD'] as const;

/** Read a positive-integer seconds override from the environment, else the default. */
function envSec(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Bearer-freshness SLA (issue #23 / D-07/D-10) — the bearer is minted ONCE nightly (~22:00) and
 * carries ~48h real validity, so a healthy token is routinely most of a day old. The credential-age
 * alarm therefore signals a MISSED nightly mint, not a normal afternoon:
 *   - WARN at ~30h (a nightly mint was skipped), default `108000s`.
 *   - ERROR at ~52h (approaching the token's real expiry), default `187200s`.
 * Both are env-overridable (`PELOTON_CREDENTIAL_WARN_SEC` / `PELOTON_CREDENTIAL_ERROR_SEC`).
 */
export const PELOTON_CREDENTIAL_WARN_SEC = envSec('PELOTON_CREDENTIAL_WARN_SEC', 108000);
export const PELOTON_CREDENTIAL_ERROR_SEC = envSec('PELOTON_CREDENTIAL_ERROR_SEC', 187200);

/** The resolved bearer-freshness SLA pair (the credential-age alarm, metrics, run-summary read this). */
export const PELOTON_CREDENTIAL_SLA = {
  warnSec: PELOTON_CREDENTIAL_WARN_SEC,
  errorSec: PELOTON_CREDENTIAL_ERROR_SEC,
} as const;

/** The provider state namespace + the session key within it (C5 / D-08). */
export const PELOTON_STATE_NAMESPACE = 'peloton';
export const PELOTON_SESSION_KEY = 'session';

function credentialsPresent(secrets: Readonly<Record<string, string>>): boolean {
  return PELOTON_SECRET_KEYS.every((k) => typeof secrets[k] === 'string' && secrets[k].length > 0);
}

export const pelotonProvider: SourceProvider = {
  id: 'peloton',
  kind: 'peloton-scraper',
  runtime: 'out_of_process',
  capabilities: ['auth', 'scrape', 'tokenMint', 'assets', 'remediation'],
  mediaKinds: ['video'],
  // Entry-grain: the ledger grows one row per scraped class, so emission is bounded by the
  // donor-parity sliding window (PELOTON_EMIT_WINDOW_DAYS) — stale classes drop from the file, the
  // download-archive keeps them downloaded (core/emit-window.ts).
  emitWindow: true,
  settingsSchema: pelotonSettingsSchema,
  // Nightly scrape (the donor's 22:00 lineage) + the bearer-freshness SLA tuned to that cadence
  // (issue #23): warn at a missed nightly (~30h), error approaching real expiry (~52h) — D-07/D-15.
  scheduling: {
    mode: 'cron',
    cron: '0 22 * * *',
    credentialWarnSec: PELOTON_CREDENTIAL_WARN_SEC,
    credentialErrorSec: PELOTON_CREDENTIAL_ERROR_SEC,
  },
  stateNamespace: PELOTON_STATE_NAMESPACE,

  /**
   * C1 PROBE (D-04) — creds present in the injected context + the age of the last minted session.
   * The heavy reachability check (an actual login) is the worker's; the core probe reports whether
   * the credential lifecycle is HEALTHY. The credential-age THRESHOLDS (warn/error from the resolved
   * bearer-freshness SLA, issue #23) are applied core-side in `collectHealth` (D-10) so the alarm
   * policy lives in one place.
   */
  async test(ctx: ProviderContext) {
    const checkedAt = new Date().toISOString();
    if (!credentialsPresent(ctx.secrets)) {
      return {
        status: 'error' as const,
        message: `missing Peloton credentials (${PELOTON_SECRET_KEYS.join(', ')})`,
        checkedAt,
      };
    }
    const session = await ctx.state.get<PelotonSessionState>(PELOTON_SESSION_KEY);
    if (!session?.mintedAt) {
      return {
        status: 'warn' as const,
        message: 'credentials present; no bearer minted yet',
        checkedAt,
      };
    }
    const ageSec = Math.max(0, Math.floor((Date.now() - Date.parse(session.mintedAt)) / 1000));
    return {
      status: 'ok' as const,
      message: `credentials present; last bearer minted ${ageSec}s ago`,
      checkedAt,
      credentialAgeSec: ageSec,
    };
  },

  /**
   * C3 (D-06) — Peloton discovery runs OUT OF PROCESS. The dispatcher enqueues a job (with the full
   * payload from `buildDiscoveryPayload`) that a worker claims; the core NEVER scrapes inline. This
   * hook exists to satisfy the contract and is a hard guard: reaching it means a caller wrongly tried
   * to run the credentialed scrape in-core.
   */
  async discover(): Promise<SubscriptionEntry[]> {
    throw new Error(
      'peloton.discover() runs out_of_process — the dispatcher enqueues a job the worker claims; ' +
        'the core never scrapes inline (D-03)',
    );
  },

  /**
   * C2 (D-05) — auth is declared, but the credentialed login happens in the worker (out_of_process).
   * Core-side this is a NO-OP that records intent: the worker mints the session and reports it back
   * through the transport, where the core persists + delivers it (`src/core/report.ts`).
   */
  async authenticate(): Promise<SessionArtifacts> {
    return {};
  },

  /**
   * C6 (D-09) — a Peloton Fix is an auth-gated re-fetch needing a live session, so it dispatches to
   * the worker. Here the provider returns the QUEUED intent; the RemediationJob row + the worker
   * dispatch are wired in M5. Returning `queued` keeps the job row honest.
   */
  async remediate(entryKey: string, action: RemediationAction): Promise<RemediationResult> {
    return {
      entryKey,
      action,
      status: 'queued',
      message: 'peloton auth-gated re-fetch queued (worker dispatch wired in M5)',
    };
  },

  /**
   * C8 (D-11) — the seam exists for the poster-durability fold-in fork (Q-04), but v1 keeps the
   * app-side poster guard UNTOUCHED, so this returns no descriptors. Declaring `assets` + carrying
   * the hook is what makes the negation validation meaningful.
   */
  async describeAssets(): Promise<AssetDescriptor[]> {
    return [];
  },
};
