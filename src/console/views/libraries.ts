import { api } from '../api';
import { el, emptyState, kindChip, pageHeader } from '../dom';
import type { LibraryDto } from '../types';

/**
 * Libraries — the emit units (DESIGN-045 D-02): one config.yaml + subscriptions.yaml tuple per
 * library, projected to `projectionPath` for the downloader CronJobs. M1 console scope is the
 * honest read: the list; library CRUD stays an API/app concern.
 */
export async function renderLibraries(root: HTMLElement): Promise<void> {
  const libraries = await api<LibraryDto[]>('/api/v1/libraries');

  root.append(pageHeader('Libraries', '/api/v1/libraries'));
  root.append(
    el(
      'p',
      { class: 'section-note' },
      'Each library is an emit unit: sources render into its config.yaml + subscriptions.yaml at ',
      el('code', {}, 'projectionPath'),
      ' on the downloader volume (D-14). Create/edit via the API.',
    ),
  );

  if (libraries.length === 0) {
    root.append(
      emptyState('No libraries yet.', 'POST /api/v1/libraries creates one — see /openapi.json.'),
    );
    return;
  }

  const tbody = el('tbody', {});
  for (const lib of libraries) {
    tbody.append(
      el(
        'tr',
        {},
        el('td', {}, lib.name),
        el('td', {}, kindChip(lib.libraryKind)),
        el('td', {}, lib.player),
        el('td', { class: 'mono' }, lib.mediaRoot),
        el('td', { class: 'mono' }, lib.projectionPath),
        el('td', {}, lib.presetName),
      ),
    );
  }

  root.append(
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Name'),
            el('th', {}, 'Kind'),
            el('th', {}, 'Player'),
            el('th', {}, 'Media root'),
            el('th', {}, 'Projection path'),
            el('th', {}, 'Preset'),
          ),
        ),
        tbody,
      ),
    ),
  );
}
