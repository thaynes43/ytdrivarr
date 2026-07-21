import type { IconName } from './icons';
import { renderSources } from './views/sources';
import { renderAddSource } from './views/add-source';
import { renderImport } from './views/import';
import { renderActivity } from './views/activity';
import { renderProviders } from './views/providers';
import { renderLibraries } from './views/libraries';
import { renderGeneral } from './views/general';
import { renderSystem } from './views/system';

/**
 * The console's route table — the *arr sidebar sections (Sources / Activity / Settings / System)
 * with their expanding sub-navs, plus the M1-era hash aliases. Pure data + a pure resolver so the
 * navigation model is unit-testable without booting the shell.
 */

export type View = (root: HTMLElement, refresh: () => void) => Promise<void>;

export interface NavChild {
  hash: string;
  label: string;
  view: View;
}

export interface NavSection {
  hash: string;
  label: string;
  icon: IconName;
  view: View;
  /** hash prefix owning this section's active state (defaults to the section hash). */
  match?: string;
  children?: NavChild[];
}

export const NAV: NavSection[] = [
  {
    hash: '#/sources',
    label: 'Sources',
    icon: 'play',
    view: renderSources,
    children: [
      { hash: '#/sources/add', label: 'Add New', view: renderAddSource },
      { hash: '#/sources/import', label: 'Import', view: renderImport },
    ],
  },
  {
    hash: '#/activity',
    label: 'Activity',
    icon: 'clock',
    view: renderActivity,
    children: [{ hash: '#/activity', label: 'History', view: renderActivity }],
  },
  {
    hash: '#/settings/providers',
    label: 'Settings',
    icon: 'gear',
    match: '#/settings',
    view: renderProviders,
    children: [
      { hash: '#/settings/providers', label: 'Providers', view: renderProviders },
      { hash: '#/settings/libraries', label: 'Libraries', view: renderLibraries },
      { hash: '#/settings/general', label: 'General', view: renderGeneral },
    ],
  },
  {
    hash: '#/system',
    label: 'System',
    icon: 'monitor',
    view: renderSystem,
    children: [{ hash: '#/system', label: 'Status', view: renderSystem }],
  },
];

/** M1-era hashes keep working (stale bookmarks land on the renamed pages). */
export const ALIASES: Record<string, string> = {
  '#/runs': '#/activity',
  '#/health': '#/system',
  '#/providers': '#/settings/providers',
  '#/libraries': '#/settings/libraries',
};

export interface ResolvedRoute {
  section: NavSection;
  child: NavChild | undefined;
  view: View;
  hash: string;
}

/** Resolve a location hash to its section + view (pure). Unknown hashes land on Sources. */
export function resolveRoute(rawHash: string): ResolvedRoute {
  const hash = ALIASES[rawHash] ?? rawHash;
  for (const section of NAV) {
    const child = section.children?.find((c) => c.hash === hash);
    if (child) return { section, child, view: child.view, hash };
    if (hash === section.hash || (section.match !== undefined && hash.startsWith(section.match))) {
      return { section, child: undefined, view: section.view, hash };
    }
  }
  const fallback = NAV[0] as NavSection;
  return { section: fallback, child: undefined, view: fallback.view, hash: fallback.hash };
}
