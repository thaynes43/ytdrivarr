import { api } from '../api';
import { el, humanCron, bearerSlaText, icon, relTime } from '../dom';
import { toolbar } from '../toolbar';
import type { HealthDto, ProviderDto, SourceHealthDto, SystemStatusDto } from '../types';

/**
 * System → Status — the Sonarr System→Status idiom: health CALLOUTS first (distinct warn/error
 * messages aggregated across sources, with an honest all-clear when there are none), then the
 * provider registry table, then About (real runtime facts from /api/v1/system/status) and
 * More Info links.
 */

export interface HealthCallout {
  status: 'warn' | 'error';
  message: string;
  count: number;
}

/** Distinct warn/error messages across per-source health rows, worst first. */
export function aggregateCallouts(rows: SourceHealthDto[]): HealthCallout[] {
  const map = new Map<string, HealthCallout>();
  for (const row of rows) {
    if (row.status !== 'warn' && row.status !== 'error') continue;
    const message = row.message ?? `${row.providerId} ${row.status}`;
    const key = `${row.status}:${message}`;
    const existing = map.get(key);
    if (existing) existing.count += 1;
    else map.set(key, { status: row.status, message, count: 1 });
  }
  return [...map.values()].sort((a, b) =>
    a.status === b.status ? 0 : a.status === 'error' ? -1 : 1,
  );
}

function sevIcon(status: 'ok' | 'warn' | 'error'): HTMLElement {
  const name = status === 'ok' ? 'okCircle' : status === 'warn' ? 'warnTriangle' : 'errorCircle';
  return el('span', { class: `sev ${status}` }, icon(name));
}

function kvRow(k: string, v: Node | string): HTMLElement {
  return el(
    'div',
    { class: 'kv-row' },
    el('span', { class: 'k' }, k),
    el('span', { class: 'v' }, v),
  );
}

function schedulingText(provider: ProviderDto): string {
  const s = provider.scheduling;
  if (!s) return '—';
  if (s.mode === 'cron') {
    return `cron ${humanCron(s.cron ?? '')}${bearerSlaText(s)}`;
  }
  return `event-driven${s.safetyCron ? ` · safety ${humanCron(s.safetyCron)}` : ''}`;
}

export async function renderSystem(root: HTMLElement, refresh: () => void): Promise<void> {
  const [health, status] = await Promise.all([
    api<HealthDto>('/health'),
    api<SystemStatusDto>('/api/v1/system/status'),
  ]);

  root.append(
    toolbar({
      apiPath: '/health',
      actions: [{ label: 'Refresh', icon: 'refresh', onClick: () => refresh() }],
    }),
  );
  const content = el('div', { class: 'content' });
  root.append(content);

  // --- Health callouts ------------------------------------------------------------------------
  content.append(el('div', { class: 'section-h' }, 'Health'));
  const callouts = aggregateCallouts(health.sources);
  if (callouts.length === 0) {
    content.append(
      el(
        'div',
        { class: 'health-row' },
        sevIcon('ok'),
        el(
          'span',
          { class: 'msg' },
          el('b', {}, 'All health probes pass.'),
          ` ${health.sources.length} source probe${health.sources.length === 1 ? '' : 's'} evaluated.`,
        ),
      ),
    );
  } else {
    for (const callout of callouts) {
      content.append(
        el(
          'div',
          { class: 'health-row' },
          sevIcon(callout.status),
          el(
            'span',
            { class: 'msg' },
            el('b', {}, callout.message),
            callout.count > 1 ? ` ${callout.count} sources carry this ${callout.status}.` : '',
          ),
          el(
            'a',
            { class: 'lnk', href: '/health', target: '_blank', rel: 'noreferrer' },
            'More Info',
          ),
        ),
      );
    }
  }
  const warnCount = callouts.filter((c) => c.status === 'warn').reduce((n, c) => n + c.count, 0);
  const errorCount = callouts.filter((c) => c.status === 'error').reduce((n, c) => n + c.count, 0);
  const checkedAt = health.sources[0]?.checkedAt;
  content.append(
    el(
      'p',
      { class: 'hint', style: 'margin-top:8px' },
      `${warnCount} warning${warnCount === 1 ? '' : 's'} · ${errorCount} error${errorCount === 1 ? '' : 's'} · probes run per source` +
        (checkedAt ? ` · last evaluated ${relTime(checkedAt)}.` : '.'),
    ),
  );

  // --- Providers ------------------------------------------------------------------------------
  content.append(el('div', { class: 'section-h' }, 'Providers'));
  const tbody = el('tbody', {});
  for (const provider of health.providers) {
    tbody.append(
      el(
        'tr',
        {},
        el(
          'td',
          { class: 'cell-main' },
          el('a', { href: '#/settings/providers' }, provider.id),
          el('div', { class: 'm-meta' }, `${provider.runtime} · ${schedulingText(provider)}`),
        ),
        el(
          'td',
          { class: 'hide-m' },
          el(
            'span',
            { class: `chip rt${provider.runtime === 'out_of_process' ? ' oop' : ''}` },
            provider.runtime === 'out_of_process' ? 'out of process' : 'in core',
          ),
        ),
        el(
          'td',
          { class: 'muted' },
          provider.capabilities.length > 0
            ? provider.capabilities.join(', ')
            : 'none (trivial by design)',
        ),
        el('td', { class: 'muted hide-m' }, provider.mediaKinds.join(', ')),
        el('td', { class: 'muted hide-m' }, schedulingText(provider)),
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
          el('th', {}, 'Provider'),
          el('th', { class: 'hide-m' }, 'Runtime'),
          el('th', {}, 'Capabilities'),
          el('th', { class: 'hide-m' }, 'Media Kinds'),
          el('th', { class: 'hide-m' }, 'Scheduling'),
        ),
      ),
      tbody,
    ),
  );

  // --- About ----------------------------------------------------------------------------------
  const uptime = ((): string => {
    const s = status.uptimeSec;
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  })();

  content.append(
    el('div', { class: 'section-h', style: 'margin-top:26px' }, 'About'),
    el(
      'div',
      { class: 'kv-table' },
      kvRow('Version', status.version),
      kvRow('Runtime', `Node.js ${status.nodeVersion}`),
      kvRow(
        'Database',
        status.database.reachable
          ? `PostgreSQL · migrations applied: ${status.database.migrations ?? 'unknown'}`
          : 'unreachable',
      ),
      kvRow('Projection Root', status.projectionRoot ?? 'not set'),
      kvRow(
        'Console Access',
        status.authMode === 'open'
          ? 'Keyless on LAN. API keys guard API clients only (see Settings → General).'
          : 'API key required (X-Api-Key).',
      ),
      kvRow('API Keys Configured', String(status.apiKeysConfigured)),
      kvRow('Uptime', uptime),
    ),
    el('div', { class: 'section-h', style: 'margin-top:26px' }, 'More Info'),
    el(
      'div',
      { class: 'kv-table' },
      kvRow(
        'Source',
        el(
          'a',
          { href: 'https://github.com/thaynes43/ytdrivarr', target: '_blank', rel: 'noreferrer' },
          'github.com/thaynes43/ytdrivarr',
        ),
      ),
      kvRow(
        'OpenAPI',
        el('a', { href: '/openapi.json', target: '_blank', rel: 'noreferrer' }, '/openapi.json'),
      ),
    ),
  );
}
