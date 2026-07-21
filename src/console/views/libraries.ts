import { api } from '../api';
import { el, emptyState, kindChip } from '../dom';
import { toolbar } from '../toolbar';
import type { LibraryDto, SourceDto } from '../types';

/**
 * Settings → Libraries — the emit units (DESIGN-045 D-02): one config.yaml + subscriptions.yaml
 * tuple per library, projected to `projectionPath` for the downloader CronJobs. The honest read:
 * the list plus per-library source counts; library CRUD stays an API/app concern.
 */

export async function renderLibraries(root: HTMLElement, refresh: () => void): Promise<void> {
  const [libraries, sources] = await Promise.all([
    api<LibraryDto[]>('/api/v1/libraries'),
    api<SourceDto[]>('/api/v1/sources'),
  ]);

  root.append(
    toolbar({
      apiPath: '/api/v1/libraries',
      actions: [{ label: 'Refresh', icon: 'refresh', onClick: () => refresh() }],
    }),
  );
  const content = el('div', { class: 'content' });
  root.append(content);
  content.append(el('div', { class: 'section-h' }, 'Libraries'));

  if (libraries.length === 0) {
    content.append(
      emptyState('No libraries yet.', 'POST /api/v1/libraries creates one (see /openapi.json).'),
    );
    return;
  }

  const counts = new Map<string, number>();
  for (const source of sources) {
    counts.set(source.libraryId, (counts.get(source.libraryId) ?? 0) + 1);
  }

  const tbody = el('tbody', {});
  for (const lib of libraries) {
    tbody.append(
      el(
        'tr',
        {},
        el(
          'td',
          { class: 'cell-main' },
          el('a', { href: '#/settings/libraries' }, lib.name),
          el('div', { class: 'm-meta' }, `${lib.libraryKind} · ${lib.presetName}`),
        ),
        el('td', { class: 'hide-m' }, kindChip(lib.libraryKind)),
        el('td', { class: 'muted hide-m' }, lib.presetName),
        el('td', { class: 'muted' }, lib.mediaRoot),
        el('td', { class: 'muted hide-m' }, lib.projectionPath),
        el('td', { class: 'num' }, String(counts.get(lib.id) ?? 0)),
      ),
    );
  }

  content.append(
    el(
      'table',
      { class: 'arr' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, 'Library'),
          el('th', { class: 'hide-m' }, 'Kind'),
          el('th', { class: 'hide-m' }, 'Preset'),
          el('th', {}, 'Media Root'),
          el('th', { class: 'hide-m' }, 'Projection'),
          el('th', { class: 'num' }, 'Sources'),
        ),
      ),
      tbody,
    ),
    el(
      'div',
      { class: 't-foot' },
      el('span', {}, `Total: ${libraries.length} libraries`),
      el('span', {}, ''),
    ),
  );
}
