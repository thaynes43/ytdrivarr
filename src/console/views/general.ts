import { api } from '../api';
import { el } from '../dom';
import { toolbar } from '../toolbar';
import type { SystemStatusDto } from '../types';

/**
 * Settings → General — the access posture, stated honestly: on an `open` deployment the console
 * and API are keyless on the LAN-only ingress (Sonarr's "Disabled for Local Addresses"); API
 * keys, when configured, guard API clients. Key COUNT only — the service never returns key
 * values, so neither does this page.
 */

function kvRow(k: string, v: Node | string): HTMLElement {
  return el(
    'div',
    { class: 'kv-row' },
    el('span', { class: 'k' }, k),
    el('span', { class: 'v' }, v),
  );
}

export async function renderGeneral(root: HTMLElement, refresh: () => void): Promise<void> {
  const status = await api<SystemStatusDto>('/api/v1/system/status');

  root.append(
    toolbar({
      apiPath: '/api/v1/system/status',
      actions: [{ label: 'Refresh', icon: 'refresh', onClick: () => refresh() }],
    }),
  );
  const content = el('div', { class: 'content' });
  root.append(content);

  content.append(
    el('div', { class: 'section-h' }, 'Security'),
    el(
      'div',
      { class: 'kv-table' },
      kvRow(
        'Authentication',
        status.authMode === 'open'
          ? 'Open — keyless on the LAN-only ingress (like Sonarr with authentication disabled for local addresses)'
          : 'API key required on every /api/v1 request (X-Api-Key)',
      ),
      kvRow(
        'API Keys Configured',
        `${status.apiKeysConfigured}${status.authMode === 'open' ? ' (accepted but not required in open mode)' : ''}`,
      ),
      kvRow(
        'Key values',
        'Injected via environment (ESO) — the API never returns them, so neither does this console.',
      ),
    ),
    el('div', { class: 'section-h', style: 'margin-top:26px' }, 'Connections'),
    el(
      'div',
      { class: 'kv-table' },
      kvRow('Projection Root', status.projectionRoot ?? 'not set'),
      kvRow(
        'OpenAPI',
        el('a', { href: '/openapi.json', target: '_blank', rel: 'noreferrer' }, '/openapi.json'),
      ),
      kvRow('Health', el('a', { href: '/health', target: '_blank', rel: 'noreferrer' }, '/health')),
    ),
    el(
      'p',
      { class: 'hint', style: 'margin-top:14px' },
      'Behavioral settings live on Sources and Libraries (durable database state); the environment carries connection config only (DESIGN-045 D-01).',
    ),
  );
}
