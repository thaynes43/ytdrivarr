import { logger } from '../logger';
import type { ProviderContext, ProviderStateStore, SourceView } from '../contracts';

/** An in-memory ProviderStateStore for unit tests (no DB). */
export function inMemoryStateStore(): ProviderStateStore {
  const map = new Map<string, unknown>();
  return {
    get: async <T = unknown>(key: string) => map.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
  };
}

export function makeSourceView(overrides: Partial<SourceView> = {}): SourceView {
  return {
    id: 'src-1',
    libraryId: 'lib-1',
    providerId: 'in-core-url-list',
    kind: 'url-list',
    mediaKind: 'video',
    displayName: 'Test Channel',
    ref: 'https://www.youtube.com/@test',
    settings: {},
    enabled: true,
    ...overrides,
  };
}

export function fakeContext(
  opts: { source?: Partial<SourceView>; secrets?: Record<string, string> } = {},
): ProviderContext {
  return {
    source: makeSourceView(opts.source),
    secrets: opts.secrets ?? {},
    state: inMemoryStateStore(),
    logger,
  };
}
