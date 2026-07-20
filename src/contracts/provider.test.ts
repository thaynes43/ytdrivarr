import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateProvider, type SourceProvider } from './index';
import { inCoreUrlListProvider } from '../providers/in-core-url-list';
import { fakeFullProvider } from '../testing/fake-full-provider';

function baseTrivial(): SourceProvider {
  return {
    id: 'trivial',
    kind: 'url-list',
    runtime: 'in_core',
    capabilities: [],
    mediaKinds: ['video'],
    settingsSchema: z.object({}),
    scheduling: { mode: 'event_driven' },
    stateNamespace: 'trivial',
    async test() {
      return { status: 'ok', checkedAt: new Date().toISOString() };
    },
    async discover() {
      return [];
    },
  };
}

describe('validateProvider (C1 / D-04)', () => {
  it('accepts the trivial in-core provider and the full provider', () => {
    expect(() => validateProvider(inCoreUrlListProvider)).not.toThrow();
    expect(() => validateProvider(fakeFullProvider)).not.toThrow();
  });

  it('rejects a []-capability provider that carries an auth hook (negation, forward)', () => {
    const bad = baseTrivial();
    (bad as SourceProvider).authenticate = async () => ({ bearer: 'x' });
    expect(() => validateProvider(bad)).toThrow(/does not declare capability "auth"/);
  });

  it('rejects a provider that declares a capability but is missing its hook (negation, reverse)', () => {
    const bad = baseTrivial();
    (bad as unknown as { capabilities: string[] }).capabilities = ['remediation'];
    expect(() => validateProvider(bad)).toThrow(/declares "remediation" but is missing hook/);
  });

  it('rejects a scrape/tokenMint capability on an in_core runtime (must be out_of_process)', () => {
    const bad = baseTrivial();
    (bad as unknown as { capabilities: string[] }).capabilities = ['scrape'];
    expect(() => validateProvider(bad)).toThrow(/must be out_of_process/);
  });

  it('rejects a provider missing required fields', () => {
    const bad = baseTrivial();
    (bad as { stateNamespace: string }).stateNamespace = '';
    expect(() => validateProvider(bad)).toThrow(/stateNamespace/);
  });
});
