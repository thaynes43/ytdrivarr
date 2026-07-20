import { describe, expect, it, vi } from 'vitest';
import { dispatchDiscovery } from './dispatcher';
import { inCoreUrlListProvider } from '../providers/in-core-url-list';
import { fakeContext } from '../testing/context';

/**
 * Capability NEGATION (DESIGN-045 D-04): a `[]`-capability provider never triggers auth/scrape/asset
 * paths. Structurally, `validateProvider` forbids the trivial provider from even CARRYING those
 * hooks (proved in provider.test.ts); here we prove the runtime pipeline only ever calls discover().
 */
describe('capability negation — the []-provider', () => {
  it('has no auth / remediation / asset hooks at all', () => {
    expect(inCoreUrlListProvider.capabilities).toEqual([]);
    expect(inCoreUrlListProvider.authenticate).toBeUndefined();
    expect(inCoreUrlListProvider.remediate).toBeUndefined();
    expect(inCoreUrlListProvider.describeAssets).toBeUndefined();
  });

  it('dispatching discovery runs in_core and calls ONLY discover()', async () => {
    const discoverSpy = vi.spyOn(inCoreUrlListProvider, 'discover');
    const result = await dispatchDiscovery(
      inCoreUrlListProvider,
      fakeContext({ source: { ref: 'https://www.youtube.com/@negation' } }),
    );
    expect(result.mode).toBe('in_core');
    if (result.mode === 'in_core') {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.downloadRef).toBe('https://www.youtube.com/@negation');
    }
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    discoverSpy.mockRestore();
  });
});
