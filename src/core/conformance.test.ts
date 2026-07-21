import { describe, expect, it } from 'vitest';
import {
  healthResultSchema,
  subscriptionEntrySchema,
  validateProvider,
  type SourceProvider,
} from '../contracts';
import { inCoreUrlListProvider } from '../providers/in-core-url-list';
import { youtubeProvider } from '../providers/youtube';
import { fakeFullProvider } from '../testing/fake-full-provider';
import { fakeContext } from '../testing/context';

/**
 * Provider-contract CONFORMANCE (the DESIGN-045 test strategy): trivial, real, and full providers
 * must ALL satisfy C1–C8 against the same interface. Running the identical suite over all three is
 * the seam's compatibility promise — the M2 `youtube` provider (real, mid-spread) sits between the
 * trivial `[]`-capability reference and the full authenticated-scraper stub.
 */
const providers: SourceProvider[] = [inCoreUrlListProvider, youtubeProvider, fakeFullProvider];

describe.each(providers)('conformance: $id', (provider) => {
  it('passes registry validation (C1)', () => {
    expect(() => validateProvider(provider)).not.toThrow();
  });

  it('test() returns a valid HealthResult (C1/C7)', async () => {
    const result = await provider.test(fakeContext());
    expect(() => healthResultSchema.parse(result)).not.toThrow();
  });

  it('discover() returns valid SubscriptionEntry[] (C3)', async () => {
    const entries = await provider.discover(fakeContext());
    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) {
      expect(() => subscriptionEntrySchema.parse(entry)).not.toThrow();
    }
  });

  it('declared capabilities each have their hook (C1 both directions)', () => {
    const hookFor: Record<string, keyof SourceProvider> = {
      auth: 'authenticate',
      remediation: 'remediate',
      assets: 'describeAssets',
    };
    for (const [cap, hook] of Object.entries(hookFor)) {
      const declared = provider.capabilities.includes(cap as never);
      const present = typeof provider[hook] === 'function';
      expect(present).toBe(declared);
    }
  });

  it('exposes a settingsSchema and a scheduling declaration (C4)', () => {
    expect(provider.settingsSchema).toBeDefined();
    expect(['event_driven', 'cron']).toContain(provider.scheduling.mode);
  });
});
