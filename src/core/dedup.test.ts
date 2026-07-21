import { describe, expect, it } from 'vitest';
import {
  dedupEntries,
  dedupTitleCollisions,
  dropTitleCollisions,
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

function titled(
  key: string,
  chip: string,
  displayName: string,
  episode?: number,
): SubscriptionEntry {
  return {
    entryKey: key,
    displayName,
    downloadRef: `https://x/${key}`,
    preset: 'Plex TV Show by Date',
    chip,
    ...(episode !== undefined ? { overrides: { season_number: 30, episode_number: episode } } : {}),
  };
}

describe('dedupTitleCollisions (re-aired same-title classes, donor parity)', () => {
  it('binds a (chip, displayName) to the FIRST-PUBLISHED entry (lowest episode)', () => {
    // observed live 2026-07-21: a re-aired class (new class id, higher episode) silently
    // overwrote the donor binding in the emitted YAML map.
    const donor = titled('f947017e', 'Cycling (30 min)', 'Classic Rock Ride', 2164);
    const reAir = titled('b3c46831', 'Cycling (30 min)', 'Classic Rock Ride', 2191);
    expect(dedupTitleCollisions([donor, reAir])).toEqual([donor]);
    expect(dedupTitleCollisions([reAir, donor])).toEqual([donor]); // order-independent
  });

  it('keeps the first occurrence when numbering is absent, and distinct titles all pass', () => {
    const a = titled('a', 'Yoga (5 min)', 'Morning Flow');
    const b = titled('b', 'Yoga (5 min)', 'Morning Flow');
    const c = titled('c', 'Yoga (5 min)', 'Evening Flow');
    expect(dedupTitleCollisions([a, b, c])).toEqual([a, c]);
  });

  it('treats the same displayName under DIFFERENT chips as distinct', () => {
    const a = titled('a', 'Rowing (30 min)', 'Thunder 45', 1);
    const b = titled('b', 'Row Bootcamp (45 min)', 'Thunder 45', 2);
    expect(dedupTitleCollisions([a, b])).toHaveLength(2);
  });
});

describe('dropTitleCollisions (merge-side donor parity guard)', () => {
  it('drops incoming re-airs of an already-bound title, keeps updates and new titles', () => {
    const existing = [titled('f947017e', 'Cycling (30 min)', 'Classic Rock Ride', 2164)];
    const reAir = titled('b3c46831', 'Cycling (30 min)', 'Classic Rock Ride', 2191);
    const update = titled('f947017e', 'Cycling (30 min)', 'Classic Rock Ride', 2164);
    const fresh = titled('deadbeef', 'Cycling (30 min)', 'Brand New Ride', 2192);
    const result = dropTitleCollisions([reAir, update, fresh], existing);
    expect(result.dropped).toBe(1);
    expect(result.kept.map((e) => e.entryKey)).toEqual(['f947017e', 'deadbeef']);
  });

  it('collapses batch-internal duplicates to the first occurrence', () => {
    const a = titled('a', 'Yoga (5 min)', 'Morning Flow', 1);
    const b = titled('b', 'Yoga (5 min)', 'Morning Flow', 2);
    const result = dropTitleCollisions([a, b], []);
    expect(result.dropped).toBe(1);
    expect(result.kept).toEqual([a]);
  });
});
