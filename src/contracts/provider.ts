import { z } from 'zod';
import type { Capability, Runtime } from './capabilities';
import type { MediaKind } from './media-kind';
import type { HealthResult } from './health';
import type { SchedulingDeclaration } from './scheduling';
import type { SubscriptionEntry } from './subscription-entry';
import type { AssetDescriptor } from './assets';
import type { ProviderContext, SessionArtifacts } from './context';

export const remediationActionSchema = z.enum(['redownload', 'replace']);
export type RemediationAction = z.infer<typeof remediationActionSchema>;

export interface RemediationResult {
  entryKey: string;
  action: RemediationAction;
  status: 'ok' | 'error' | 'queued';
  message?: string;
}

/**
 * The *arr-style provider extension point (T-216 / DESIGN-045 D-04…D-11 — the C1–C8 contract).
 * A provider implements the SUBSET it declares (C1). The capability-gated hooks below are present
 * IFF the matching capability is declared — `validateProvider()` enforces both directions, so a
 * `[]`-capability provider CANNOT carry an auth/remediation/assets hook, and the pipeline can
 * never invoke a path the provider didn't declare (the negation guarantee).
 */
export interface SourceProvider {
  // --- C1: capability declaration -------------------------------------------------------------
  readonly id: string;
  readonly kind: string;
  readonly runtime: Runtime;
  readonly capabilities: readonly Capability[];
  /** which media-kind preset families this provider can produce entries for (D-12). */
  readonly mediaKinds: readonly MediaKind[];
  readonly settingsSchema: z.ZodType;
  /** C4 — the discovery cadence declaration. */
  readonly scheduling: SchedulingDeclaration;
  /** C5 — the provider's durable state namespace. */
  readonly stateNamespace: string;

  /** C1 — reachability/credential probe surfaced by GET /health and the app's status read. */
  test(ctx: ProviderContext): Promise<HealthResult>;

  /** C3 — produce subscription entries; the CORE owns YAML assembly/dedup/persistence. */
  discover(ctx: ProviderContext): Promise<SubscriptionEntry[]>;

  // --- capability-gated hooks (present IFF the matching capability is declared) ----------------

  /** C2 — auth/session + secret lifecycle. Present IFF `auth` is declared. */
  authenticate?(ctx: ProviderContext): Promise<SessionArtifacts>;

  /** C6 — per-item remediation / the Fix leg. Present IFF `remediation` is declared. */
  remediate?(
    entryKey: string,
    action: RemediationAction,
    ctx: ProviderContext,
  ): Promise<RemediationResult>;

  /** C7 — richer per-source telemetry beyond `test()`. Optional for any provider. */
  health?(ctx: ProviderContext): Promise<HealthResult>;

  /** C8 — optional asset descriptors. Present IFF `assets` is declared. */
  describeAssets?(ctx: ProviderContext): Promise<AssetDescriptor[]>;
}

/** Maps each capability to the hook that MUST exist when it is declared (and must NOT when absent). */
const CAPABILITY_HOOKS: Partial<Record<Capability, keyof SourceProvider>> = {
  auth: 'authenticate',
  remediation: 'remediate',
  assets: 'describeAssets',
};

/**
 * Registry-load validation (D-04): a provider that fails this is a STARTUP ERROR, never a silent
 * skip (the anti-pattern of the donor's string-import DI). Enforces the capability↔hook contract
 * in BOTH directions — this is the structural spine of capability negation.
 */
export function validateProvider(provider: SourceProvider): void {
  const fail = (msg: string): never => {
    throw new Error(`Invalid provider "${provider.id || '<unknown>'}": ${msg}`);
  };

  if (!provider.id) fail('missing id');
  if (!provider.kind) fail('missing kind');
  if (!provider.stateNamespace) fail('missing stateNamespace (C5)');
  if (provider.mediaKinds.length === 0) fail('must declare at least one mediaKind');
  if (typeof provider.test !== 'function') fail('must implement test() (C1)');
  if (typeof provider.discover !== 'function') fail('must implement discover() (C3)');

  const declared = new Set<Capability>(provider.capabilities);

  // Both directions: declared ⇒ hook present; not-declared ⇒ hook absent.
  for (const [cap, hook] of Object.entries(CAPABILITY_HOOKS) as [
    Capability,
    keyof SourceProvider,
  ][]) {
    const hasHook = typeof provider[hook] === 'function';
    if (declared.has(cap) && !hasHook) {
      fail(`declares "${cap}" but is missing hook ${String(hook)}()`);
    }
    if (!declared.has(cap) && hasHook) {
      fail(
        `implements ${String(hook)}() but does not declare capability "${cap}" (negation violation)`,
      );
    }
  }

  // `scrape`/`tokenMint` are worker-side legs — they only make sense out of process (D-03).
  const workerCaps: Capability[] = ['scrape', 'tokenMint'];
  for (const cap of workerCaps) {
    if (declared.has(cap) && provider.runtime !== 'out_of_process') {
      fail(`declares "${cap}" but runtime is "${provider.runtime}" (must be out_of_process)`);
    }
  }
}
