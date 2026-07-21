import { api } from '../api';
import { badge, el, emptyState, formatDate, formatDuration, pageHeader } from '../dom';
import type { RunDto } from '../types';

/**
 * Runs — discovery/emit history (DESIGN-045 D-02 T-219): trigger, scope, status, counts,
 * started/finished, log excerpt. The trigger button drives the same POST /api/v1/runs the app and
 * the scheduler use — the console adds no capability the API lacks.
 */

function countsSummary(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${v} ${k}`).join(' · ');
}

export async function renderRuns(root: HTMLElement, refresh: () => void): Promise<void> {
  const runs = await api<RunDto[]>('/api/v1/runs?limit=50');

  const triggerBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Run discovery');
  triggerBtn.addEventListener('click', () => {
    triggerBtn.disabled = true;
    void api('/api/v1/runs', { method: 'POST', body: { scope: 'all', trigger: 'api' } })
      .then(() => refresh())
      .catch(() => {
        triggerBtn.disabled = false;
      });
  });
  const refreshBtn = el(
    'button',
    { class: 'btn btn-ghost', type: 'button', onclick: () => refresh() },
    'Refresh',
  );

  root.append(pageHeader('Runs', '/api/v1/runs', refreshBtn, triggerBtn));

  if (runs.length === 0) {
    root.append(
      emptyState(
        'No runs yet.',
        'Trigger one above (scope: all) or POST /api/v1/runs — edits and provider crons record runs here too.',
      ),
    );
    return;
  }

  const tbody = el('tbody', {});
  for (const run of runs) {
    const scope = run.scopeRef ? `${run.scope}:${run.scopeRef}` : run.scope;
    const row = el(
      'tr',
      {},
      el('td', {}, formatDate(run.startedAt)),
      el('td', {}, badge(run.status)),
      el('td', {}, run.trigger),
      el('td', { class: 'mono' }, scope),
      el('td', {}, el('span', { class: 'counts' }, countsSummary(run.counts))),
      el('td', {}, formatDuration(run.startedAt, run.finishedAt)),
    );

    // A "Detail" cell holds the summary + log expanders — both the SAME in-place expansion idiom
    // (the doctrine's sanctioned exception): clicking toggles a sibling row open/closed, nothing
    // reflows around it. The owner's daily-review summary (D-10) is the first expander.
    const detailCell = el('td', {});
    const detailRows: HTMLElement[] = [];

    if (run.summaryMarkdown) {
      const summaryRow = el('tr', { class: 'editor-row' });
      const summaryBtn = el('button', { class: 'btn-link', type: 'button' }, 'summary');
      summaryBtn.addEventListener('click', () => {
        if (summaryRow.firstChild) {
          summaryRow.replaceChildren();
          return;
        }
        summaryRow.replaceChildren(
          el(
            'td',
            { colspan: '7' },
            el('pre', { class: 'log-excerpt' }, run.summaryMarkdown ?? ''),
          ),
        );
      });
      detailCell.append(summaryBtn);
      detailRows.push(summaryRow);
    }

    if (run.logExcerpt) {
      const excerptRow = el('tr', { class: 'editor-row' });
      const logBtn = el('button', { class: 'btn-link', type: 'button' }, 'log');
      logBtn.addEventListener('click', () => {
        if (excerptRow.firstChild) {
          excerptRow.replaceChildren();
          return;
        }
        excerptRow.replaceChildren(
          el('td', { colspan: '7' }, el('pre', { class: 'log-excerpt' }, run.logExcerpt ?? '')),
        );
      });
      if (detailCell.firstChild) detailCell.append(' · ');
      detailCell.append(logBtn);
      detailRows.push(excerptRow);
    }

    if (!detailCell.firstChild) detailCell.append(el('span', { class: 'mono' }, '—'));
    row.append(detailCell);
    tbody.append(row, ...detailRows);
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
            el('th', {}, 'Started'),
            el('th', {}, 'Status'),
            el('th', {}, 'Trigger'),
            el('th', {}, 'Scope'),
            el('th', {}, 'Counts'),
            el('th', {}, 'Duration'),
            el('th', {}, 'Detail'),
          ),
        ),
        tbody,
      ),
    ),
  );
}
