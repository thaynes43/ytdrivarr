// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { applySearchSortFilter, atCapActivities, buildEditorPatch } from './sources';
import { aggregateCallouts } from './system';
import { countsLine, runTitle } from './activity';
import type { RunDto, SourceDto, SourceHealthDto } from '../types';

/** The Sources/Activity/System pure view logic (filtering, patch shapes, callout aggregation). */

function src(over: Partial<SourceDto>): SourceDto {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    libraryId: over.libraryId ?? 'lib1',
    providerId: over.providerId ?? 'youtube',
    kind: 'youtube-url-list',
    mediaKind: 'video',
    displayName: over.displayName ?? 'Channel',
    ref: over.ref ?? 'https://www.youtube.com/@x',
    settings: over.settings ?? {},
    enabled: over.enabled ?? true,
    createdBy: 'test',
    capsContext: {},
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

const libraryName = (): string => 'YouTube';

describe('applySearchSortFilter', () => {
  const rows = [
    src({ displayName: 'Cycling', providerId: 'peloton', ref: 'cycling', entryCount: 99 }),
    src({ displayName: 'Defunctland', settings: { chip: 'Documentaries' }, entryCount: 1 }),
    src({ displayName: 'Alex Meyers', settings: { chip: 'Animation' }, entryCount: 1 }),
    src({ displayName: 'Yesterworld', enabled: false, entryCount: 1 }),
  ];

  it('sorts by name by default and interleaves providers as peers', () => {
    const out = applySearchSortFilter(rows, {
      search: '',
      sort: 'name',
      filter: 'all',
      libraryName,
    });
    expect(out.map((s) => s.displayName)).toEqual([
      'Alex Meyers',
      'Cycling',
      'Defunctland',
      'Yesterworld',
    ]);
  });

  it('filters by provider and by monitored state', () => {
    expect(
      applySearchSortFilter(rows, { search: '', sort: 'name', filter: 'peloton', libraryName }).map(
        (s) => s.displayName,
      ),
    ).toEqual(['Cycling']);
    expect(
      applySearchSortFilter(rows, {
        search: '',
        sort: 'name',
        filter: 'unmonitored',
        libraryName,
      }).map((s) => s.displayName),
    ).toEqual(['Yesterworld']);
  });

  it('searches name, ref, chip and provider', () => {
    expect(
      applySearchSortFilter(rows, {
        search: 'docum',
        sort: 'name',
        filter: 'all',
        libraryName,
      }).map((s) => s.displayName),
    ).toEqual(['Defunctland']);
    expect(
      applySearchSortFilter(rows, {
        search: 'peloton',
        sort: 'name',
        filter: 'all',
        libraryName,
      }).map((s) => s.displayName),
    ).toEqual(['Cycling']);
  });

  it('sorts by entries descending when asked', () => {
    const out = applySearchSortFilter(rows, {
      search: '',
      sort: 'entries',
      filter: 'all',
      libraryName,
    });
    expect(out[0]?.displayName).toBe('Cycling');
  });
});

describe('buildEditorPatch', () => {
  it('peloton: a cap value becomes the per-source override inside merged settings', () => {
    const patch = buildEditorPatch(
      { providerId: 'peloton', settings: { maxScrolls: 250 } },
      { cap: '40' },
    );
    expect(patch).toEqual({ settings: { maxScrolls: 250, maxClassesPerActivity: 40 } });
  });

  it('peloton: a BLANK cap removes the override so the row tracks the global default', () => {
    const patch = buildEditorPatch(
      { providerId: 'peloton', settings: { maxClassesPerActivity: 40, maxScrolls: 250 } },
      { cap: '' },
    );
    expect(patch).toEqual({ settings: { maxScrolls: 250 } });
  });

  it('youtube: name/ref/chip patch; an empty chip is removed from settings', () => {
    const patch = buildEditorPatch(
      { providerId: 'youtube', settings: { chip: 'Old' } },
      { displayName: ' New Name ', ref: ' https://www.youtube.com/@new ', chip: '' },
    );
    expect(patch).toEqual({
      displayName: 'New Name',
      ref: 'https://www.youtube.com/@new',
      settings: {},
    });
  });
});

function run(over: Partial<RunDto>): RunDto {
  return {
    id: over.id ?? 'r1',
    scope: over.scope ?? 'all',
    scopeRef: over.scopeRef ?? null,
    trigger: over.trigger ?? 'api',
    providerId: over.providerId ?? null,
    status: over.status ?? 'ok',
    counts: over.counts ?? {},
    telemetry: {},
    summary: over.summary ?? null,
    summaryMarkdown: null,
    logExcerpt: over.logExcerpt ?? null,
    startedAt: '2026-07-21T09:00:00.000Z',
    finishedAt: over.status === 'running' ? null : '2026-07-21T09:01:00.000Z',
    ...over,
  };
}

describe('atCapActivities', () => {
  it('reads the LATEST finalized run with a per-activity breakdown and flags at/over-cap rows', () => {
    const runs = [
      run({ id: 'newer-running', status: 'running' }),
      run({
        id: 'latest-summary',
        summary: {
          changes: {
            activities: [
              { activity: 'Cycling', existing: 74, added: 25, total: 99, cap: 25, atCap: true },
              { activity: 'Cardio', existing: 36, added: 3, total: 39, cap: 25, atCap: false },
            ],
          },
        },
      }),
      run({
        id: 'older',
        summary: {
          changes: {
            activities: [{ activity: 'Yoga', existing: 1, added: 1, total: 2, atCap: true }],
          },
        },
      }),
    ];
    const flagged = atCapActivities(runs);
    expect(flagged.has('Cycling')).toBe(true);
    expect(flagged.has('Cardio')).toBe(false);
    expect(flagged.has('Yoga')).toBe(false); // only the LATEST breakdown counts
  });
});

describe('runTitle + countsLine', () => {
  it('titles by scope with resolved names', () => {
    const names = { library: () => 'Peloton', source: () => 'Cycling' };
    expect(runTitle(run({ scope: 'all' }), names)).toBe('Discovery · All libraries');
    expect(runTitle(run({ scope: 'library', scopeRef: 'x' }), names)).toBe(
      'Discovery · Peloton library',
    );
    expect(runTitle(run({ scope: 'source', scopeRef: 'y' }), names)).toBe('Discovery · Cycling');
  });

  it('summarizes counts honestly, including the running state', () => {
    expect(countsLine(run({ status: 'running', counts: { queued: 1 } }))).toBe(
      'running… 1 job queued',
    );
    expect(countsLine(run({ counts: { added: 6, deduped: 3, emitted: 247 } }))).toBe(
      '6 added · 3 deduped · 247 emitted',
    );
    expect(countsLine(run({ counts: {} }))).toBe('-');
  });
});

describe('aggregateCallouts', () => {
  function h(over: Partial<SourceHealthDto>): SourceHealthDto {
    return {
      sourceId: Math.random().toString(36).slice(2),
      providerId: over.providerId ?? 'peloton',
      status: over.status ?? 'warn',
      checkedAt: '2026-07-21T09:00:00.000Z',
      ...over,
    };
  }

  it('groups identical warn/error messages with a count, errors first, ok rows ignored', () => {
    const callouts = aggregateCallouts([
      h({ status: 'warn', message: 'bearer past SLA' }),
      h({ status: 'warn', message: 'bearer past SLA' }),
      h({ status: 'error', message: 'login failed' }),
      h({ status: 'ok', message: 'fine' }),
    ]);
    expect(callouts).toHaveLength(2);
    expect(callouts[0]).toMatchObject({ status: 'error', message: 'login failed', count: 1 });
    expect(callouts[1]).toMatchObject({ status: 'warn', message: 'bearer past SLA', count: 2 });
  });

  it('returns nothing when every probe passes (the all-clear renders elsewhere)', () => {
    expect(aggregateCallouts([h({ status: 'ok' })])).toEqual([]);
  });
});
