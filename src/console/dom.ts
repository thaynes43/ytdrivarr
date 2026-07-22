/** Small DOM helpers — the console is vanilla TS on purpose (a thin operator view, no framework). */

import { ICONS, type IconName } from './icons';

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

/** An inline SVG icon from the shared path set (fill = currentColor; the CSS sizes it). */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

/** The *arr status dot. Recolors by status class; fixed size, never moves a neighbor. */
export function statusDot(status: string, title?: string): HTMLElement {
  const node = el('span', { class: `dot ${status}` });
  if (title) node.title = title;
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', title ?? status);
  return node;
}

/** A mediaKind chip (video | music). */
export function kindChip(kind: string): HTMLElement {
  return el('span', { class: `chip kind-${kind}` }, kind);
}

/** A run-trigger chip (cron | api | edit). */
export function triggerChip(trigger: string): HTMLElement {
  return el('span', { class: `chip trigger ${trigger}` }, trigger);
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

/** Sonarr-style relative age (`9h ago`, `2d ago`); sub-minute rounds to `just now`. */
export function relTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const sec = Math.floor((now - t) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Humanize the simple daily `M H * * *` cron shape to `HH:MM`; anything else passes through. */
export function humanCron(expr: string): string {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expr.trim());
  if (!match) return expr;
  return `${String(match[2]).padStart(2, '0')}:${String(match[1]).padStart(2, '0')}`;
}

/**
 * Render a cron provider's bearer-freshness SLA as ` · bearer SLA warn 30h / error 52h` (issue #23),
 * mirroring the `resolveCredentialSla` fallback: prefer the explicit warn/error pair, else derive from
 * the deprecated `credentialRefreshSec` (warn = it, error = 2×). Empty when no SLA is declared.
 */
export function bearerSlaText(scheduling: {
  credentialRefreshSec?: number;
  credentialWarnSec?: number;
  credentialErrorSec?: number;
}): string {
  const warnSec = scheduling.credentialWarnSec ?? scheduling.credentialRefreshSec;
  if (warnSec === undefined || warnSec <= 0) return '';
  const errorSec = scheduling.credentialErrorSec ?? warnSec * 2;
  return ` · bearer SLA warn ${Math.round(warnSec / 3600)}h / error ${Math.round(errorSec / 3600)}h`;
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
