import { describe, expect, it } from 'vitest';
import { assertValidRegistry, getProvider, listProviders, loadRegistry } from './registry';
import { inCoreUrlListProvider } from '../providers/in-core-url-list';
import type { SourceProvider } from '../contracts';

describe('the typed provider registry (D-04)', () => {
  it('loads the real registry without throwing', () => {
    expect(() => loadRegistry()).not.toThrow();
    expect(listProviders().map((p) => p.id)).toContain('in-core-url-list');
  });

  it('a failed provider load is a startup error, never a silent skip', () => {
    const broken = {
      ...inCoreUrlListProvider,
      capabilities: ['auth'],
    } as unknown as SourceProvider;
    expect(() => assertValidRegistry([broken])).toThrow(/auth/);
  });

  it('rejects duplicate provider ids', () => {
    expect(() => assertValidRegistry([inCoreUrlListProvider, inCoreUrlListProvider])).toThrow(
      /Duplicate/,
    );
  });

  it('getProvider throws for an unknown id', () => {
    expect(() => getProvider('does-not-exist')).toThrow(/Unknown provider/);
  });
});
