/** Small DOM helpers — the console is vanilla TS on purpose (a thin operator view, no framework). */

type Child = Node | string | null | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((ev: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === 'function') {
      node.addEventListener(name.replace(/^on/, ''), value);
    } else if (typeof value === 'boolean') {
      if (value) node.setAttribute(name, '');
    } else if (name === 'class') {
      node.className = value;
    } else {
      node.setAttribute(name, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

/** A status pill. Recolors by status class; never resizes on change. */
export function badge(status: string, label?: string): HTMLElement {
  return el('span', { class: `badge badge-${status}` }, label ?? status);
}

/** A mediaKind chip (video | music). */
export function kindChip(kind: string): HTMLElement {
  return el('span', { class: `chip chip-${kind}` }, kind);
}

/**
 * Every list links to its API counterpart for operator debugging (D-20: the console is a thin
 * view over the same REST API; when in doubt, curl the same surface).
 */
export function apiLink(path: string): HTMLElement {
  return el(
    'span',
    { class: 'api-link' },
    'API: ',
    el('a', { href: path, target: '_blank', rel: 'noreferrer' }, el('code', {}, path)),
    ' · ',
    el('a', { href: '/openapi.json', target: '_blank', rel: 'noreferrer' }, 'OpenAPI'),
  );
}

/** An honest empty state — never fake rows. */
export function emptyState(message: string, hint?: string): HTMLElement {
  return el(
    'div',
    { class: 'empty-state' },
    el('p', {}, message),
    hint ? el('p', { class: 'empty-hint' }, hint) : null,
  );
}

export function errorBanner(err: unknown): HTMLElement {
  const message = err instanceof Error ? err.message : String(err);
  return el('div', { class: 'error-banner' }, message);
}

export function pageHeader(
  title: string,
  apiPath: string,
  ...actions: (Node | null)[]
): HTMLElement {
  return el(
    'header',
    { class: 'page-header' },
    el('div', { class: 'page-title-row' }, el('h1', {}, title), ...actions),
    apiLink(apiPath),
  );
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return 'running';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
