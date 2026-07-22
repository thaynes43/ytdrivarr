import { api } from '../api';
import { el, humanCron, bearerSlaText, kindChip, relTime, statusDot } from '../dom';
import { toolbar } from '../toolbar';
import type { HealthDto, ProviderDto, SourceDto, SourceHealthDto } from '../types';

/**
 * Settings → Providers — WHAT IS INTEGRATED (the design record's integration grain): one card
 * per registry entry. Providers compile into the service — nothing is added or removed here;
 * watching more of a provider happens in Sources. Cards read/config/test: declared runtime,
 * capabilities (negated ones rendered hollow), scheduling, live worker/session state from
 * /health, and Test = re-running the health probes.
 */

const ALL_CAPABILITIES = ['auth', 'scrape', 'tokenMint', 'assets', 'remediation'] as const;

const PROVIDER_TITLES: Record<string, string> = {
  youtube: 'YouTube',
  peloton: 'Peloton',
  'in-core-url-list': 'URL List (reference)',
};

function schedulingLine(provider: ProviderDto): string {
  const s = provider.scheduling;
  if (!s) return '—';
  if (s.mode === 'cron') {
    return `Nightly scrape ${humanCron(s.cron ?? '')}${bearerSlaText(s)}`;
  }
  return `Event-driven: re-emit on Source edit${
    s.safetyCron ? ` · daily safety re-emit ${humanCron(s.safetyCron)}` : ''
  }`;
}

function worst(rows: SourceHealthDto[]): 'ok' | 'warn' | 'error' | 'unknown' {
  const rank = { ok: 0, unknown: 1, warn: 2, error: 3 } as const;
  let acc: 'ok' | 'warn' | 'error' | 'unknown' = rows.length > 0 ? 'ok' : 'unknown';
  for (const row of rows) if (rank[row.status] > rank[acc]) acc = row.status;
  return acc;
}

function card(
  provider: ProviderDto,
  sources: SourceDto[],
  healthRows: SourceHealthDto[],
): HTMLElement {
  const mine = sources.filter((s) => s.providerId === provider.id);
  const libraries = new Set(mine.map((s) => s.libraryId));
  const status = worst(healthRows);
  const statusMessage =
    healthRows.find((r) => r.status === status)?.message ??
    (mine.length === 0 ? 'no sources use this provider' : 'no probe yet');
  const checkedAt = healthRows[0]?.checkedAt;

  const node = el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'c-head' },
      el('h3', {}, PROVIDER_TITLES[provider.id] ?? provider.id),
      el(
        'span',
        { class: `chip rt${provider.runtime === 'out_of_process' ? ' oop' : ''}` },
        provider.runtime === 'out_of_process' ? 'out of process' : 'in core',
      ),
      statusDot(status, statusMessage),
    ),
    el(
      'div',
      { class: 'c-sub' },
      `id ${provider.id} · kind ${provider.kind} · state ns ${provider.stateNamespace}`,
    ),
    el(
      'div',
      { class: 'c-row' },
      el('span', { class: 'k' }, 'Media kinds'),
      el('span', {}, ...provider.mediaKinds.map((k) => el('span', {}, kindChip(k), ' '))),
    ),
    el(
      'div',
      { class: 'c-row' },
      el('span', { class: 'k' }, 'Capabilities'),
      el(
        'span',
        {},
        ...ALL_CAPABILITIES.map((cap) =>
          el('span', { class: `cap ${provider.capabilities.includes(cap) ? 'on' : 'off'}` }, cap),
        ),
      ),
    ),
    el(
      'div',
      { class: 'c-row' },
      el('span', { class: 'k' }, 'Scheduling'),
      el('span', {}, schedulingLine(provider)),
    ),
  );

  // Observed worker/session facts (out_of_process providers report them on /health rows).
  const observed = healthRows.find((r) => r.healthModel === 'observed');
  if (provider.runtime === 'out_of_process') {
    const workerSeen = observed?.workerLastSeenSec;
    node.append(
      el(
        'div',
        { class: 'c-row' },
        el('span', { class: 'k' }, 'Worker'),
        workerSeen !== undefined
          ? el(
              'span',
              {},
              statusDot(workerSeen < 300 ? 'ok' : 'warn'),
              ` last seen ${workerSeen}s ago`,
            )
          : el('span', { class: 'muted' }, 'no worker has claimed a job yet'),
      ),
    );
    const minted = observed?.bearerMintedAt;
    node.append(
      el(
        'div',
        { class: 'c-row' },
        el('span', { class: 'k' }, 'Session'),
        minted !== undefined
          ? el(
              'span',
              {},
              statusDot(observed?.status ?? 'unknown'),
              ` bearer minted ${relTime(minted)}`,
            )
          : el('span', { class: 'muted' }, 'no bearer minted yet'),
      ),
    );
  }

  node.append(
    el(
      'div',
      { class: 'c-row' },
      el('span', { class: 'k' }, 'In use by'),
      el(
        'span',
        {},
        mine.length === 0
          ? 'no sources'
          : `${mine.length} source${mine.length === 1 ? '' : 's'}` +
              (provider.id === 'peloton' ? ' (one per activity)' : '') +
              ` · ${libraries.size} librar${libraries.size === 1 ? 'y' : 'ies'}`,
      ),
    ),
    el(
      'div',
      { class: 'c-status' },
      statusDot(status),
      el('span', {}, statusMessage),
      checkedAt ? el('span', { class: 'muted end' }, `checked ${relTime(checkedAt)}`) : null,
    ),
  );
  return node;
}

export async function renderProviders(root: HTMLElement, refresh: () => void): Promise<void> {
  const [providers, sources, health] = await Promise.all([
    api<ProviderDto[]>('/api/v1/providers'),
    api<SourceDto[]>('/api/v1/sources'),
    api<HealthDto>('/health'),
  ]);

  root.append(
    toolbar({
      apiPath: '/api/v1/providers',
      actions: [
        {
          label: 'Test All',
          icon: 'testAll',
          onClick: async () => {
            // /health runs every provider's probe/observed evaluation server-side.
            await api<HealthDto>('/health');
            refresh();
          },
        },
      ],
    }),
  );

  const content = el('div', { class: 'content' });
  root.append(content);
  content.append(
    el('div', { class: 'section-h' }, 'Providers'),
    el(
      'p',
      { class: 'hint' },
      'The typed registry: one entry per integration. Providers compile into the service; Sources pick one and set what it watches.',
    ),
  );

  const cards = el('div', { class: 'cards' });
  for (const provider of providers) {
    const rows = health.sources.filter((s) => s.providerId === provider.id);
    cards.append(card(provider, sources, rows));
  }
  content.append(
    cards,
    el(
      'p',
      { class: 'hint', style: 'margin-top:18px' },
      'Providers cannot be added or removed here: the registry is compiled in. Watching more of a provider happens in Sources.',
    ),
  );
}
