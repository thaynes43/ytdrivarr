import { describe, expect, it } from 'vitest';
import {
  dedupEntries,
  numberFromOverrides,
  preservePublishedNumbering,
  type PublishedNumbering,
} from './dedup';
import type { SubscriptionEntry } from '../contracts';

function entry(key: string, overrides?: Record<string, unknown>): SubscriptionEntry {
  return {
    entryKey: key,
    displayName: key,
    downloadRef: `https://x/${key}`,
    preset: 'Plex TV Show by Date',
    ...(overrides ? { overrides } : {}),
  };
}

describe('dedupEntries (core-owned cross-source dedup, D-06)', () => {
  it('collapses entries sharing an entryKey, keeping the first', () => {
    const result = dedupEntries([entry('a'), entry('b'), entry('a')]);
    expect(result.map((e) => e.entryKey)).toEqual(['a', 'b']);
  });
});

describe('preservePublishedNumbering (immutable season/episode, D-06)', () => {
  it('re-stamps prior numbering so a re-discovery cannot renumber a published item', () => {
    const fresh = [entry('a', { season_number: 30, episode_number: 999 })];
    const published = new Map<string, PublishedNumbering>([['a', { season: 30, episode: 5 }]]);
    const result = preservePublishedNumbering(fresh, published);
    expect(result[0]?.overrides?.episode_number).toBe(5);
    expect(result[0]?.overrides?.season_number).toBe(30);
  });

  it('leaves entries untouched when nothing was previously published', () => {
    const fresh = [entry('a')];
    const result = preservePublishedNumbering(fresh, new Map());
    expect(result[0]?.overrides).toBeUndefined();
  });
});

describe('numberFromOverrides', () => {
  it('reads integer overrides and returns null otherwise', () => {
    expect(numberFromOverrides(entry('a', { season_number: 12 }), 'season_number')).toBe(12);
    expect(numberFromOverrides(entry('a'), 'episode_number')).toBeNull();
  });
});
