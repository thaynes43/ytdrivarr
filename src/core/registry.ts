import { validateProvider, type SourceProvider } from '../contracts';
import { inCoreUrlListProvider } from '../providers/in-core-url-list';
import { youtubeProvider } from '../providers/youtube';

/**
 * The TYPED provider registry (DESIGN-045 D-04) — a COMPILE-TIME map, not the donor's string-import
 * DI. A provider that fails validation is a STARTUP ERROR (`loadRegistry` throws), never a silent
 * skip. New providers (M2 YouTube, M3 Peloton) are added here as another map entry.
 *
 * `in-core-url-list` stays as the trivial `[]`-capability reference provider (the negation proof);
 * `youtube` is the M2 real Tier-1 provider supporting BOTH preset families (video + music).
 */
export const PROVIDERS = {
  [inCoreUrlListProvider.id]: inCoreUrlListProvider,
  [youtubeProvider.id]: youtubeProvider,
} satisfies Record<string, SourceProvider>;

export type ProviderId = keyof typeof PROVIDERS;

/** Validate a set of providers as a registry: each satisfies C1–C8, ids are unique. Throws on any
 * violation — this is what makes a failed provider load a startup error (D-04). */
export function assertValidRegistry(providers: Iterable<SourceProvider>): void {
  const seen = new Set<string>();
  for (const provider of providers) {
    validateProvider(provider);
    if (seen.has(provider.id)) {
      throw new Error(`Duplicate provider id "${provider.id}" in the registry`);
    }
    seen.add(provider.id);
  }
}

/** Called on boot; a throw here aborts startup (a broken provider must never silently disappear). */
export function loadRegistry(): void {
  assertValidRegistry(Object.values(PROVIDERS));
}

export function getProvider(id: string): SourceProvider {
  const provider = (PROVIDERS as Record<string, SourceProvider>)[id];
  if (!provider) {
    throw new Error(`Unknown provider "${id}" — not in the typed registry`);
  }
  return provider;
}

export function listProviders(): SourceProvider[] {
  return Object.values(PROVIDERS);
}
