import { describe, expect, it } from 'vitest';
import { recomposeLibrary, type RecomposeSource } from './recompose';
import type { EmitLibrary } from './emitter';
import type { SubscriptionEntryRow } from '../db/schema';

const LIB: EmitLibrary = {
  presetName: 'Plex TV Show by Date',
  workingDirectory: '/media/lib',
  emitPolicy: { output_options: {} },
  libraryKind: 'video',
};

function row(entryKey: string, extra: Partial<SubscriptionEntryRow> = {}): SubscriptionEntryRow {
  return {
    id: entryKey,
    sourceId: 's',
    entryKey,
    displayName: entryKey,
    downloadRef: `https://example.com/${entryKey}`,
    preset: 'Plex TV Show by Date',
    chip: null,
    overrides: null,
    ytdlOptions: null,
    assets: null,
    seasonNumber: null,
    episodeNumber: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  } as SubscriptionEntryRow;
}

describe('recomposeLibrary', () => {
  it('excludes disabled sources from the emitted config (parameter rows only, no DB read)', () => {
    const sources: RecomposeSource[] = [
      { providerId: 'youtube', enabled: true, rows: [row('a', { displayName: 'Alpha' })] },
      { providerId: 'youtube', enabled: false, rows: [row('b', { displayName: 'Beta' })] },
    ];
    const out = recomposeLibrary(LIB, sources, 0);
    expect(out.emittedEntries.map((e) => e.entryKey)).toEqual(['a']);
    expect(out.emitted.subscriptionsYaml).toContain('Alpha');
    expect(out.emitted.subscriptionsYaml).not.toContain('Beta');
    expect(out.windowedOutCount).toBe(0);
    expect(out.dedupedCount).toBe(0);
  });

  it('drops stale windowed (Peloton) entries from the FILE while keeping fresh ones', () => {
    const old = new Date(Date.now() - 40 * 86_400_000); // 40d ago, beyond a 15d window
    const sources: RecomposeSource[] = [
      {
        providerId: 'peloton',
        enabled: true,
        rows: [
          row('fresh', { displayName: 'Fresh', chip: 'Cycling (30 min)' }),
          row('stale', { displayName: 'Stale', chip: 'Cycling (30 min)', createdAt: old }),
        ],
      },
    ];
    const out = recomposeLibrary(LIB, sources, 15);
    const keys = out.emittedEntries.map((e) => e.entryKey);
    expect(keys).toContain('fresh');
    expect(keys).not.toContain('stale');
    expect(out.windowedOutCount).toBe(1);
  });
});
