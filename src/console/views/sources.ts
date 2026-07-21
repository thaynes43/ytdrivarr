import { api } from '../api';
import { createIconConfirm } from '../confirm-button';
import { el, emptyState, icon, kindChip, relTime, statusDot } from '../dom';
import { getSearch, onSearch } from '../search';
import { toolbar } from '../toolbar';
import type { HealthDto, LibraryDto, RunDto, SourceDto } from '../types';

/**
 * Sources — WHAT THE SERVICE IS WATCHING (the design record's watch grain): YouTube channels and
 * the per-activity Peloton Sources interleaved as PEER rows in one monitored list. Bookmark =
 * monitored (instant PATCH, recolor only — an unmonitored row's entries persist but leave the
 * next emit); Cap = the effective per-scrape cap (Peloton); Entries = persisted attribution;
 * Status = the per-source health dot. Row actions: an in-place editor expansion (the sanctioned
 * layout change) and the two-step armed remove inside a width-reserved slot.
 */

type SortKey = 'name' | 'provider' | 'library' | 'entries' | 'lastrun';
type FilterKey = 'all' | 'youtube' | 'peloton' | 'monitored' | 'unmonitored';

// Module-level so toolbar choices survive re-renders within a session.
let sortKey: SortKey = 'name';
let filterKey: FilterKey = 'all';

const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  provider: 'Provider',
  library: 'Library',
  entries: 'Entries',
  lastrun: 'Last run',
};

const FILTER_LABELS: Record<FilterKey, string> = {
  all: 'All',
  youtube: 'YouTube',
  peloton: 'Peloton',
  monitored: 'Monitored',
  unmonitored: 'Unmonitored',
};

export function applySearchSortFilter(
  sources: SourceDto[],
  opts: { search: string; sort: SortKey; filter: FilterKey; libraryName: (id: string) => string },
): SourceDto[] {
  const q = opts.search.trim().toLowerCase();
  let rows = sources.filter((s) => {
    if (opts.filter === 'youtube' && s.providerId !== 'youtube') return false;
    if (opts.filter === 'peloton' && s.providerId !== 'peloton') return false;
    if (opts.filter === 'monitored' && !s.enabled) return false;
    if (opts.filter === 'unmonitored' && s.enabled) return false;
    if (q === '') return true;
    const chip = typeof s.settings.chip === 'string' ? s.settings.chip : '';
    return `${s.displayName} ${s.ref} ${chip} ${s.providerId}`.toLowerCase().includes(q);
  });
  rows = [...rows].sort((a, b) => {
    switch (opts.sort) {
      case 'provider':
        return (
          a.providerId.localeCompare(b.providerId) || a.displayName.localeCompare(b.displayName)
        );
      case 'library':
        return (
          opts.libraryName(a.libraryId).localeCompare(opts.libraryName(b.libraryId)) ||
          a.displayName.localeCompare(b.displayName)
        );
      case 'entries':
        return (
          (b.entryCount ?? 0) - (a.entryCount ?? 0) || a.displayName.localeCompare(b.displayName)
        );
      case 'lastrun':
        return (
          (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? '') ||
          a.displayName.localeCompare(b.displayName)
        );
      default:
        return a.displayName.localeCompare(b.displayName);
    }
  });
  return rows;
}

/** The activities the latest finalized Peloton run flagged at/over cap (by display name). */
export function atCapActivities(runs: RunDto[]): Set<string> {
  const flagged = new Set<string>();
  const latest = runs.find(
    (r) => r.status !== 'running' && (r.summary?.changes?.activities?.length ?? 0) > 0,
  );
  for (const a of latest?.summary?.changes?.activities ?? []) {
    if (a.atCap || a.overCap) flagged.add(a.activity);
  }
  return flagged;
}

function chipOf(source: SourceDto): string {
  return typeof source.settings.chip === 'string' ? source.settings.chip : '';
}

function metaLine(source: SourceDto, libraryName: string, flaggedAtCap: boolean): string {
  const parts = [source.providerId];
  if (source.providerId === 'peloton') {
    if (source.effectiveCap != null) parts.push(`cap ${source.effectiveCap}`);
    parts.push(flaggedAtCap ? 'at cap' : `${source.entryCount ?? 0} entries`);
  } else {
    parts.push(libraryName);
    parts.push(chipOf(source) || source.mediaKind);
  }
  if (!source.enabled) parts.push('not monitored');
  return parts.join(' · ');
}

/** The monitored bookmark: instant PATCH; ONLY classes change (bm on/off, row muting). */
function monitorToggle(source: SourceDto, row: HTMLTableRowElement): HTMLElement {
  const button = el(
    'button',
    {
      class: `bm ${source.enabled ? 'on' : 'off'}`,
      type: 'button',
      role: 'switch',
      'aria-checked': String(source.enabled),
      title: source.enabled ? 'Monitored — click to unmonitor' : 'Unmonitored — click to monitor',
    },
    icon('bookmark'),
  );
  button.addEventListener('click', () => {
    if (button.disabled) return;
    const next = !(button.getAttribute('aria-checked') === 'true');
    button.disabled = true;
    void api<SourceDto>(`/api/v1/sources/${source.id}`, {
      method: 'PATCH',
      body: { enabled: next },
    })
      .then((updated) => {
        button.classList.toggle('on', updated.enabled);
        button.classList.toggle('off', !updated.enabled);
        button.setAttribute('aria-checked', String(updated.enabled));
        button.title = updated.enabled
          ? 'Monitored — click to unmonitor'
          : 'Unmonitored — click to monitor';
        row.classList.toggle('unmonitored', !updated.enabled);
      })
      .catch((err: unknown) => {
        // Honest failure: state stays as the server left it; the tooltip says why.
        button.title = `toggle failed: ${err instanceof Error ? err.message : String(err)}`;
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  return button;
}

function field(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  return el(
    'div',
    { class: 'field' },
    el('label', {}, labelText),
    input,
    hint ? el('span', { class: 'field-hint' }, hint) : null,
  );
}

function textInput(value = '', placeholder = ''): HTMLInputElement {
  const node = el('input', { type: 'text', placeholder });
  node.value = value;
  return node;
}

/**
 * Build the PATCH body for the in-row editor (pure, unit-tested). Peloton edits the effective
 * cap (blank = track the global default, i.e. the override key is REMOVED); YouTube edits
 * name/ref/chip.
 */
export function buildEditorPatch(
  source: Pick<SourceDto, 'providerId' | 'settings'>,
  values: { displayName?: string; ref?: string; chip?: string; cap?: string },
): Record<string, unknown> {
  if (source.providerId === 'peloton') {
    const settings: Record<string, unknown> = { ...source.settings };
    const trimmed = (values.cap ?? '').trim();
    if (trimmed === '') {
      delete settings.maxClassesPerActivity;
    } else {
      settings.maxClassesPerActivity = Number(trimmed);
    }
    return { settings };
  }
  const patch: Record<string, unknown> = {};
  if (values.displayName !== undefined) patch.displayName = values.displayName.trim();
  if (values.ref !== undefined) patch.ref = values.ref.trim();
  const settings: Record<string, unknown> = { ...source.settings };
  const chip = (values.chip ?? '').trim();
  if (chip === '') delete settings.chip;
  else settings.chip = chip;
  patch.settings = settings;
  return patch;
}

/** The in-row editor (the sanctioned in-place expansion), provider-aware. */
function editorRow(
  source: SourceDto,
  colSpan: number,
  onClose: () => void,
  refresh: () => void,
): HTMLTableRowElement {
  const errorLine = el('div', { class: 'form-error' });
  const saveBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Save');
  const cancelBtn = el(
    'button',
    { class: 'btn btn-ghost', type: 'button', onclick: onClose },
    'Cancel',
  );

  const grid = el('div', { class: 'editor-grid' });
  let collect: () => Record<string, unknown>;

  if (source.providerId === 'peloton') {
    const capInput = el('input', { type: 'number', min: '1', step: '1' });
    if (source.settings.maxClassesPerActivity !== undefined) {
      capInput.value = String(source.settings.maxClassesPerActivity);
    }
    capInput.placeholder = String(source.effectiveCap ?? 25);
    grid.append(
      field(
        'Classes per scrape (cap)',
        capInput,
        `blank tracks the global default (${source.effectiveCap != null && source.settings.maxClassesPerActivity === undefined ? source.effectiveCap : 25})`,
      ),
    );
    collect = () => buildEditorPatch(source, { cap: capInput.value });
  } else {
    const nameInput = textInput(source.displayName);
    const refInput = textInput(source.ref, 'https://www.youtube.com/@…');
    const chipInput = textInput(chipOf(source), 'Documentaries');
    grid.append(
      field('Display name', nameInput),
      field('Ref', refInput, 'channel / playlist URL or @handle'),
      field('Genre chip', chipInput, 'the = Genre group in the emitted file'),
    );
    collect = () =>
      buildEditorPatch(source, {
        displayName: nameInput.value,
        ref: refInput.value,
        chip: chipInput.value,
      });
  }

  saveBtn.addEventListener('click', () => {
    saveBtn.disabled = true;
    errorLine.textContent = '';
    void api(`/api/v1/sources/${source.id}`, { method: 'PATCH', body: collect() })
      .then(() => refresh())
      .catch((err: unknown) => {
        errorLine.textContent = err instanceof Error ? err.message : String(err);
        saveBtn.disabled = false;
      });
  });

  return el(
    'tr',
    { class: 'editor-row' },
    el(
      'td',
      { colspan: String(colSpan) },
      grid,
      el('div', { class: 'editor-actions' }, saveBtn, cancelBtn, errorLine),
    ),
  );
}

export async function renderSources(root: HTMLElement, refresh: () => void): Promise<void> {
  const [sources, libraries, health, runs] = await Promise.all([
    api<SourceDto[]>('/api/v1/sources'),
    api<LibraryDto[]>('/api/v1/libraries'),
    api<HealthDto>('/health'),
    api<RunDto[]>('/api/v1/runs?limit=25'),
  ]);

  const libraryName = new Map(libraries.map((l) => [l.id, l.name]));
  const healthBySource = new Map(health.sources.map((s) => [s.sourceId, s]));
  const flagged = atCapActivities(runs);

  const bar = toolbar({
    apiPath: '/api/v1/sources',
    actions: [
      {
        label: 'Run Discovery',
        icon: 'refresh',
        onClick: async () => {
          await api('/api/v1/runs', { method: 'POST', body: { scope: 'all', trigger: 'api' } });
          refresh();
        },
      },
      {
        label: 'Import',
        icon: 'download',
        hideOnPhone: true,
        onClick: () => {
          window.location.hash = '#/sources/import';
        },
      },
    ],
    menus: [
      {
        label: 'Sort',
        icon: 'sort',
        choices: (Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({
          value: k,
          label: SORT_LABELS[k],
        })),
        selected: sortKey,
        onSelect: (value) => {
          sortKey = value as SortKey;
          refresh();
        },
      },
      {
        label: 'Filter',
        icon: 'filter',
        choices: (Object.keys(FILTER_LABELS) as FilterKey[]).map((k) => ({
          value: k,
          label: FILTER_LABELS[k],
        })),
        selected: filterKey,
        onSelect: (value) => {
          filterKey = value as FilterKey;
          refresh();
        },
      },
    ],
  });

  const content = el('div', { class: 'content' });
  root.append(bar, content);

  const renderTable = (): void => {
    content.replaceChildren();

    if (sources.length === 0) {
      content.append(
        emptyState(
          'No sources yet.',
          'Add a YouTube channel under Sources → Add New, or import an existing subscriptions.yaml.',
        ),
      );
      return;
    }

    const visible = applySearchSortFilter(sources, {
      search: getSearch(),
      sort: sortKey,
      filter: filterKey,
      libraryName: (id) => libraryName.get(id) ?? id,
    });

    const colCount = 11;
    const thead = el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { class: 'm-bm', style: 'width:36px' }),
        el('th', {}, 'Source'),
        el('th', { class: 'hide-m' }, 'Provider'),
        el('th', { class: 'hide-m' }, 'Library'),
        el('th', { class: 'hide-m' }, 'Kind'),
        el('th', { class: 'hide-m' }, 'Chip'),
        el('th', { class: 'num hide-m' }, 'Cap'),
        el('th', { class: 'num' }, 'Entries'),
        el('th', { class: 'hide-m' }, 'Last Run'),
        el('th', { class: 'st' }, 'Status'),
        el('th', { class: 'hide-m', style: 'width:150px' }),
      ),
    );

    const tbody = el('tbody', {});
    for (const source of visible) {
      const row = el('tr', { class: source.enabled ? '' : 'unmonitored' });
      const rowHealth = healthBySource.get(source.id);
      const isAtCap = source.providerId === 'peloton' && flagged.has(source.displayName);

      let editor: HTMLTableRowElement | null = null;
      const closeEditor = (): void => {
        editor?.remove();
        editor = null;
        wrench.classList.remove('active');
      };
      const wrench = el(
        'button',
        { class: 'icon-btn', type: 'button', title: 'Edit source', 'aria-label': 'Edit source' },
        icon('wrench'),
      );
      wrench.addEventListener('click', () => {
        if (editor) {
          closeEditor();
          return;
        }
        editor = editorRow(source, colCount, closeEditor, refresh);
        row.after(editor);
        wrench.classList.add('active');
      });

      const remove = createIconConfirm({
        title: 'Remove source',
        armedLabel: 'Sure? Remove',
        onConfirm: async () => {
          await api(`/api/v1/sources/${source.id}`, { method: 'DELETE' });
          refresh();
        },
      });

      row.append(
        el('td', { class: 'm-bm' }, monitorToggle(source, row)),
        el(
          'td',
          { class: 'cell-main' },
          el('a', { href: `#/sources` }, source.displayName),
          el(
            'div',
            { class: 'm-meta' },
            metaLine(source, libraryName.get(source.libraryId) ?? '', isAtCap),
          ),
        ),
        el('td', { class: 'muted hide-m' }, source.providerId),
        el('td', { class: 'hide-m' }, libraryName.get(source.libraryId) ?? '—'),
        el(
          'td',
          { class: 'muted hide-m' },
          source.mediaKind === 'music' ? kindChip('music') : 'video',
        ),
        el(
          'td',
          { class: source.providerId === 'peloton' ? 'muted hide-m' : 'hide-m' },
          chipOf(source) || '-',
        ),
        el(
          'td',
          { class: `num hide-m${source.effectiveCap == null ? ' muted' : ''}` },
          source.effectiveCap == null ? '-' : String(source.effectiveCap),
        ),
        el(
          'td',
          { class: 'num' },
          String(source.entryCount ?? 0),
          isAtCap ? el('span', { class: 'pill-atcap' }, 'AT CAP') : null,
        ),
        el('td', { class: 'muted hide-m' }, relTime(source.lastRunAt ?? null)),
        el(
          'td',
          { class: 'st' },
          statusDot(rowHealth?.status ?? 'unknown', rowHealth?.message ?? 'no probe yet'),
        ),
        el('td', { class: 'hide-m' }, el('div', { class: 'row-actions' }, wrench, remove)),
      );
      tbody.append(row);
    }

    const youtubeCount = sources.filter((s) => s.providerId === 'youtube').length;
    const pelotonCount = sources.filter((s) => s.providerId === 'peloton').length;
    const footLeft =
      `Total: ${sources.length} sources · ${youtubeCount} YouTube · ${pelotonCount} Peloton` +
      (visible.length !== sources.length ? ` · showing ${visible.length}` : '');

    content.append(
      el('table', { class: 'arr' }, thead, tbody),
      el(
        'div',
        { class: 't-foot' },
        el('span', {}, footLeft),
        el(
          'span',
          {},
          `Sort: ${SORT_LABELS[sortKey]} · Filter: ${FILTER_LABELS[filterKey]}` +
            (getSearch().trim() !== '' ? ` · Search: "${getSearch().trim()}"` : ''),
        ),
      ),
    );

    if (visible.length === 0) {
      content.append(
        emptyState(
          'No sources match the current search/filter.',
          'Clear the search box or set Filter: All.',
        ),
      );
    }
  };

  renderTable();
  // Live search re-filter (no refetch); the listener dies with this view's DOM.
  const stop = onSearch(() => {
    if (!root.isConnected && content.childElementCount === 0) return;
    renderTable();
  });
  window.addEventListener('hashchange', () => stop(), { once: true });
}
