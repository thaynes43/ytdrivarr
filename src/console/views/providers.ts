import { api } from '../api';
import { el, emptyState, kindChip, pageHeader } from '../dom';
import type { ProviderDto } from '../types';

/**
 * Providers — the typed registry (DESIGN-045 D-04): id, kind, runtime, declared capabilities,
 * media kinds, state namespace. Rendered honestly: M1 ships exactly one in-core provider; the
 * per-provider settings + Test button arrive with the providers that need them (M3).
 */

const CAPABILITY_LABELS = ['auth', 'scrape', 'tokenMint', 'assets', 'remediation'] as const;

export async function renderProviders(root: HTMLElement): Promise<void> {
  const providers = await api<ProviderDto[]>('/api/v1/providers');

  root.append(pageHeader('Providers', '/api/v1/providers'));
  root.append(
    el(
      'p',
      { class: 'section-note' },
      'The compile-time provider registry (D-04). A provider declares the subset of C1–C8 it implements; ',
      'everything it omits is negated — the core never invokes that path. Per-provider settings and a ',
      el('code', {}, 'test()'),
      ' button land with the first provider that carries credentials (M3).',
    ),
  );

  if (providers.length === 0) {
    root.append(
      emptyState(
        'No providers registered.',
        'An empty registry is a startup error — if you see this, check the service logs.',
      ),
    );
    return;
  }

  const grid = el('div', { class: 'card-grid' });
  for (const p of providers) {
    const caps = el('div', { class: 'cap-list' });
    if (p.capabilities.length === 0) {
      caps.append(el('span', { class: 'chip' }, 'none — trivial by design (capability negation)'));
    } else {
      for (const cap of CAPABILITY_LABELS) {
        if ((p.capabilities as readonly string[]).includes(cap)) {
          caps.append(el('span', { class: 'chip' }, cap));
        }
      }
    }

    const kinds = el('div', { class: 'cap-list' });
    for (const mk of p.mediaKinds) kinds.append(kindChip(mk));

    grid.append(
      el(
        'div',
        { class: 'card' },
        el('h3', {}, el('code', {}, p.id), el('span', { class: 'chip' }, p.runtime)),
        el(
          'dl',
          {},
          el('dt', {}, 'kind'),
          el('dd', { class: 'mono' }, p.kind),
          el('dt', {}, 'capabilities'),
          el('dd', {}, caps),
          el('dt', {}, 'media kinds'),
          el('dd', {}, kinds),
          el('dt', {}, 'state namespace'),
          el('dd', { class: 'mono' }, p.stateNamespace),
        ),
      ),
    );
  }
  root.append(grid);
}
