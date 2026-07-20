import { api } from '../api';
import { badge, el, emptyState, formatDate, pageHeader } from '../dom';
import type { HealthDto, SourceDto } from '../types';

/**
 * Health — the D-10 surface: overall status, per-source provider `test()` results, and the two
 * first-class alarms (credential-age, selector-drift) when a provider reports them. Rendered
 * honestly: the M1 in-core provider has no credentials to age and no selectors to drift, so those
 * columns simply stay empty until a provider that carries them (M3 Peloton) exists.
 */

function alarms(h: { credentialAgeSec?: number; selectorDriftHits?: number }): HTMLElement {
  const parts: string[] = [];
  if (h.credentialAgeSec !== undefined) parts.push(`credential age ${h.credentialAgeSec}s`);
  if (h.selectorDriftHits !== undefined) parts.push(`selector drift ×${h.selectorDriftHits}`);
  if (parts.length === 0) return el('span', { class: 'mono' }, '—');
  return el('span', { class: 'alarm' }, parts.join(' · '));
}

export async function renderHealth(root: HTMLElement, refresh: () => void): Promise<void> {
  // /health is the one open route (liveness for the cluster); sources give us display names.
  const [health, sources] = await Promise.all([
    api<HealthDto>('/health'),
    api<SourceDto[]>('/api/v1/sources'),
  ]);
  const sourceName = new Map(sources.map((s) => [s.id, s.displayName]));

  const refreshBtn = el(
    'button',
    { class: 'btn btn-ghost', type: 'button', onclick: () => refresh() },
    'Refresh',
  );
  root.append(pageHeader('Health', '/health', refreshBtn));

  root.append(
    el(
      'div',
      { class: 'health-banner' },
      badge(health.status),
      el('span', { class: 'service-name' }, health.service),
      el(
        'span',
        { class: 'section-note', style: 'margin: 0' },
        `${health.providers.length} provider${health.providers.length === 1 ? '' : 's'} · ${health.sources.length} source probe${health.sources.length === 1 ? '' : 's'}`,
      ),
    ),
  );

  root.append(el('h2', { class: 'section-title' }, 'Per-source probes'));
  root.append(
    el(
      'p',
      { class: 'section-note' },
      'Each row is the source provider’s ',
      el('code', {}, 'test()'),
      ' result (C1/C7). Credential-age and selector-drift alarms appear here when a provider reports them.',
    ),
  );

  if (health.sources.length === 0) {
    root.append(
      emptyState(
        'No sources to probe.',
        'Health reflects per-source provider test() results — add a source and this fills in.',
      ),
    );
    return;
  }

  const tbody = el('tbody', {});
  for (const h of health.sources) {
    tbody.append(
      el(
        'tr',
        {},
        el('td', {}, sourceName.get(h.sourceId) ?? h.sourceId),
        el('td', { class: 'mono' }, h.providerId),
        el('td', {}, badge(h.status)),
        el('td', { class: 'mono' }, h.message ?? '—'),
        el('td', {}, alarms(h)),
        el('td', {}, formatDate(h.checkedAt)),
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
            el('th', {}, 'Source'),
            el('th', {}, 'Provider'),
            el('th', {}, 'Status'),
            el('th', {}, 'Message'),
            el('th', {}, 'Alarms'),
            el('th', {}, 'Checked'),
          ),
        ),
        tbody,
      ),
    ),
  );
}
