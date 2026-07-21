import { api } from '../api';
import { el, emptyState, formatDuration, icon, relTime, statusDot, triggerChip } from '../dom';
import { toolbar } from '../toolbar';
import type { LibraryDto, RunDto, RunSummaryDto, SourceDto } from '../types';

/**
 * Activity → History — the runs ledger: every discovery/emit run, newest first, running rows
 * inline with the live dot. A row expands IN PLACE (the sanctioned expansion) into the owner's
 * Changes / Health / Issues summary (D-10) — the per-activity breakdown, credential health, and
 * the honest issue list — plus the raw log excerpt and the exact API counterpart.
 */

type StatusFilter = 'all' | 'ok' | 'warn' | 'error' | 'running';

let statusFilter: StatusFilter = 'all';

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: 'All',
  ok: 'Ok',
  warn: 'Warn',
  error: 'Error',
  running: 'Running',
};

export function runTitle(
  run: RunDto,
  names: {
    library: (id: string) => string | undefined;
    source: (id: string) => string | undefined;
  },
): string {
  if (run.scope === 'library') {
    const name = run.scopeRef ? names.library(run.scopeRef) : undefined;
    return `Discovery · ${name ? `${name} library` : 'library'}`;
  }
  if (run.scope === 'source') {
    const name = run.scopeRef ? names.source(run.scopeRef) : undefined;
    return `Discovery · ${name ?? 'source'}`;
  }
  return 'Discovery · All libraries';
}

export function countsLine(run: RunDto): string {
  if (run.status === 'running') {
    const queued = run.counts.queued ?? 0;
    return queued > 0 ? `running… ${queued} job${queued === 1 ? '' : 's'} queued` : 'running…';
  }
  const parts: string[] = [];
  const push = (key: string, label: string): void => {
    const v = run.counts[key];
    if (typeof v === 'number' && v > 0) parts.push(`${v} ${label}`);
  };
  push('added', 'added');
  push('discovered', 'discovered');
  push('unchanged', 'unchanged');
  push('deduped', 'deduped');
  push('titleCollisions', 'title collisions');
  push('emitted', 'emitted');
  if (parts.length === 0 && typeof run.counts.emitted === 'number') {
    parts.push(`${run.counts.emitted} emitted`);
  }
  return parts.length > 0 ? parts.slice(0, 3).join(' · ') : '-';
}

function metaLine(run: RunDto): string {
  if (run.status === 'running') return 'waiting on the worker report';
  if (run.status === 'error') {
    const first = (run.logExcerpt ?? '').split('\n').find((l) => l.trim() !== '');
    return first ? first.slice(0, 90) : 'run finalized error';
  }
  if (run.trigger === 'cron') return run.scope === 'all' ? 'scheduled discovery' : 'nightly scrape';
  if (run.trigger === 'edit') return 're-emit after Source edit';
  return 'operator run';
}

function summarySection(run: RunDto): HTMLElement {
  const summary: RunSummaryDto = run.summary ?? {};
  const c = summary.changes ?? {};
  const h = summary.health ?? {};
  const issues = summary.issues ?? [];

  const changes = el('div', { class: 'xp' }, el('h4', {}, 'Changes'));
  changes.append(
    el(
      'div',
      { class: 'kv' },
      'Subscriptions ',
      el('b', {}, `+${c.subscriptionsAdded ?? 0} added`),
      ` · ${c.subscriptionsRemoved ?? 0} removed · ${c.subscriptionsUnchanged ?? 0} unchanged · ${c.deduped ?? 0} deduped · `,
      el('b', {}, `${c.entriesEmitted ?? 0} emitted`),
    ),
  );
  const activities = c.activities ?? [];
  if (activities.length > 0) {
    const tbody = el('tbody', {});
    for (const a of activities) {
      tbody.append(
        el(
          'tr',
          {},
          el('td', {}, a.activity),
          el('td', {}, String(a.existing)),
          el('td', {}, String(a.added)),
          el('td', {}, String(a.total)),
          el('td', {}, a.cap !== undefined ? String(a.cap) : '-'),
          el(
            'td',
            { class: a.overCap ? 'flag' : a.atCap ? 'flag' : 'tick' },
            a.overCap ? 'over cap' : a.atCap ? 'at cap' : 'ok',
          ),
        ),
      );
    }
    changes.append(
      el(
        'table',
        { class: 'mini' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Activity'),
            el('th', {}, 'Existing'),
            el('th', {}, 'Added'),
            el('th', {}, 'Total'),
            el('th', {}, 'Cap'),
            el('th', {}),
          ),
        ),
        tbody,
      ),
    );
  }

  const health = el('div', { class: 'xp' }, el('h4', {}, 'Health'));
  const boolText = (v: boolean | null | undefined): string =>
    v === true ? 'ok' : v === false ? 'FAILED' : 'n/a';
  health.append(
    el(
      'div',
      { class: 'kv' },
      'Login ',
      el('b', { class: h.loginOk === false ? 'flag' : 'tick' }, boolText(h.loginOk)),
      ' · auth ',
      el('b', { class: h.authOk === false ? 'flag' : 'tick' }, boolText(h.authOk)),
    ),
  );
  health.append(
    el(
      'div',
      { class: 'kv' },
      'Bearer minted ',
      el('b', {}, h.bearerMintedAt ? relTime(h.bearerMintedAt) : 'never'),
      h.credentialAgeStatus !== undefined ? ` · credential age ${h.credentialAgeStatus}` : '',
    ),
  );
  health.append(
    el(
      'div',
      { class: 'kv' },
      'Scrolls performed ',
      el('b', {}, h.scrollsPerformed != null ? String(h.scrollsPerformed) : 'n/a'),
      ` · selector-drift hits `,
      el('b', {}, String(h.selectorDriftHits ?? 0)),
    ),
  );

  health.append(el('h4', { class: 'xp-later' }, 'Issues'));
  if (issues.length === 0) {
    health.append(el('div', { class: 'kv muted' }, 'None.'));
  } else {
    for (const issue of issues) health.append(el('div', { class: 'kv flag' }, issue));
  }

  const links = el('div', { class: 'kv', style: 'margin-top:16px' });
  if (run.logExcerpt) {
    const logToggle = el('button', { class: 'btn-link', type: 'button' }, 'Log excerpt');
    const pre = el('pre', { class: 'log-excerpt' }, run.logExcerpt);
    pre.style.display = 'none';
    logToggle.addEventListener('click', () => {
      pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
    });
    links.append(logToggle, ' · ');
    health.append(links, pre);
  } else {
    health.append(links);
  }
  links.append(
    el(
      'a',
      { href: `/api/v1/runs/${run.id}`, target: '_blank', rel: 'noreferrer' },
      `GET /api/v1/runs/${run.id.slice(0, 8)}…`,
    ),
  );

  return el('div', { class: 'xp-grid' }, changes, health);
}

export async function renderActivity(root: HTMLElement, refresh: () => void): Promise<void> {
  const [runs, libraries, sources] = await Promise.all([
    api<RunDto[]>('/api/v1/runs?limit=50'),
    api<LibraryDto[]>('/api/v1/libraries'),
    api<SourceDto[]>('/api/v1/sources'),
  ]);
  const libraryName = new Map(libraries.map((l) => [l.id, l.name]));
  const sourceName = new Map(sources.map((s) => [s.id, s.displayName]));
  const sourceProvider = new Map(sources.map((s) => [s.id, s.providerId]));

  root.append(
    toolbar({
      apiPath: '/api/v1/runs',
      actions: [
        {
          label: 'Run Discovery',
          icon: 'refresh',
          onClick: async () => {
            await api('/api/v1/runs', { method: 'POST', body: { scope: 'all', trigger: 'api' } });
            refresh();
          },
        },
        { label: 'Refresh', icon: 'refresh', hideOnPhone: true, onClick: () => refresh() },
      ],
      menus: [
        {
          label: 'Filter',
          icon: 'filter',
          choices: (Object.keys(FILTER_LABELS) as StatusFilter[]).map((k) => ({
            value: k,
            label: FILTER_LABELS[k],
          })),
          selected: statusFilter,
          onSelect: (value) => {
            statusFilter = value as StatusFilter;
            refresh();
          },
        },
      ],
    }),
  );
  const content = el('div', { class: 'content' });
  root.append(content);

  const visible = runs.filter((r) => statusFilter === 'all' || r.status === statusFilter);

  if (runs.length === 0) {
    content.append(
      emptyState(
        'No runs recorded yet.',
        'Run Discovery starts one; the nightly cron records here too.',
      ),
    );
    return;
  }

  const colCount = 8;
  const thead = el(
    'thead',
    {},
    el(
      'tr',
      {},
      el('th', { class: 'st', style: 'width:34px' }),
      el('th', {}, 'Run'),
      el('th', { class: 'hide-m' }, 'Provider'),
      el('th', { class: 'm-trig' }, 'Trigger'),
      el('th', { class: 'hide-m' }, 'Counts'),
      el('th', { class: 'm-start' }, 'Started'),
      el('th', { class: 'num hide-m' }, 'Duration'),
      el('th', { class: 'm-caret', style: 'width:34px' }),
    ),
  );

  const tbody = el('tbody', {});
  for (const run of visible) {
    const provider =
      run.providerId ??
      (run.scope === 'source' && run.scopeRef ? sourceProvider.get(run.scopeRef) : undefined);
    const row = el('tr', {});
    let expanders: HTMLTableRowElement[] = [];

    const caret = el(
      'button',
      { class: 'icon-btn', type: 'button', title: 'Run summary', 'aria-expanded': 'false' },
      icon('caretDown'),
    );
    const toggle = (): void => {
      if (expanders.length > 0) {
        for (const node of expanders) node.remove();
        expanders = [];
        caret.setAttribute('aria-expanded', 'false');
        caret.classList.remove('active');
        return;
      }
      // Twin expander rows (the mockup idiom): with table-layout fixed on the phone, a colspan
      // wider than the VISIBLE columns would resurrect the hidden ones as ghost width — so the
      // desktop twin spans all columns and the phone twin spans the visible five.
      const desktop = el(
        'tr',
        { class: 'expander hide-m' },
        el('td', { colspan: String(colCount) }, summarySection(run)),
      );
      const phone = el(
        'tr',
        { class: 'expander m-only' },
        el('td', { colspan: '5' }, summarySection(run)),
      );
      row.after(desktop, phone);
      expanders = [desktop, phone];
      caret.setAttribute('aria-expanded', 'true');
      caret.classList.add('active');
    };
    caret.addEventListener('click', toggle);

    row.append(
      el('td', { class: 'st' }, statusDot(run.status, run.status)),
      el(
        'td',
        { class: 'cell-main' },
        el(
          'a',
          { href: '#/activity' },
          runTitle(run, {
            library: (id) => libraryName.get(id),
            source: (id) => sourceName.get(id),
          }),
        ),
        el('div', { class: 'm-meta' }, metaLine(run)),
      ),
      el('td', { class: 'muted hide-m' }, provider ?? '—'),
      el('td', { class: 'm-trig' }, triggerChip(run.trigger)),
      el('td', { class: 'muted hide-m' }, countsLine(run)),
      el('td', { class: 'muted m-start' }, relTime(run.startedAt)),
      el('td', { class: 'num muted hide-m' }, formatDuration(run.startedAt, run.finishedAt)),
      el('td', { class: 'muted m-caret', style: 'text-align:center' }, caret),
    );
    tbody.append(row);
  }

  content.append(
    el('table', { class: 'arr' }, thead, tbody),
    el(
      'div',
      { class: 't-foot' },
      el(
        'span',
        {},
        `Total records: ${runs.length}${visible.length !== runs.length ? ` · showing ${visible.length}` : ''}`,
      ),
      el('span', {}, `Filter: ${FILTER_LABELS[statusFilter]}`),
    ),
  );

  if (visible.length === 0) {
    content.append(
      emptyState(
        `No ${FILTER_LABELS[statusFilter].toLowerCase()} runs in the last ${runs.length}.`,
      ),
    );
  }
}
