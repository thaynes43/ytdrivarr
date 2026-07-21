// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ALIASES, NAV, resolveRoute } from './routes';
import { humanCron, relTime } from './dom';

/** The navigation model: sections, sub-navs, alias redirects, and the pure formatters. */

describe('resolveRoute', () => {
  it('maps each section hash to its section with no child selected', () => {
    for (const section of NAV) {
      const route = resolveRoute(section.hash);
      expect(route.section.label).toBe(section.label);
    }
  });

  it('maps child hashes to their child views under the owning section', () => {
    const add = resolveRoute('#/sources/add');
    expect(add.section.label).toBe('Sources');
    expect(add.child?.label).toBe('Add New');
    const libraries = resolveRoute('#/settings/libraries');
    expect(libraries.section.label).toBe('Settings');
    expect(libraries.child?.label).toBe('Libraries');
  });

  it('keeps every M1-era hash working via aliases (stale bookmarks)', () => {
    expect(resolveRoute('#/runs').hash).toBe('#/activity');
    expect(resolveRoute('#/health').hash).toBe('#/system');
    expect(resolveRoute('#/providers').child?.label).toBe('Providers');
    expect(resolveRoute('#/libraries').child?.label).toBe('Libraries');
    // every alias target actually resolves to a real route
    for (const target of Object.values(ALIASES)) {
      expect(resolveRoute(target).hash).toBe(target);
    }
  });

  it('lands unknown or empty hashes on Sources (the default page)', () => {
    expect(resolveRoute('').section.label).toBe('Sources');
    expect(resolveRoute('#/nonsense').section.label).toBe('Sources');
  });
});

describe('relTime', () => {
  const now = Date.parse('2026-07-21T12:00:00.000Z');
  it('renders the Sonarr-style ages', () => {
    expect(relTime('2026-07-21T11:59:40.000Z', now)).toBe('just now');
    expect(relTime('2026-07-21T11:45:00.000Z', now)).toBe('15m ago');
    expect(relTime('2026-07-21T03:00:00.000Z', now)).toBe('9h ago');
    expect(relTime('2026-07-19T11:00:00.000Z', now)).toBe('2d ago');
    expect(relTime(null, now)).toBe('—');
  });
});

describe('humanCron', () => {
  it('humanizes the simple daily shape and passes anything else through', () => {
    expect(humanCron('0 22 * * *')).toBe('22:00');
    expect(humanCron('30 4 * * *')).toBe('04:30');
    expect(humanCron('*/15 * * * *')).toBe('*/15 * * * *');
  });
});
