import './styles.css';
import {
  chooseInitialScreen,
  clearApiKey,
  getApiKey,
  isOpenDeployment,
  setApiKey,
  UNAUTHORIZED_EVENT,
  verifyKey,
} from './api';
import { el, errorBanner } from './dom';
import { renderSources } from './views/sources';
import { renderLibraries } from './views/libraries';
import { renderRuns } from './views/runs';
import { renderHealth } from './views/health';
import { renderProviders } from './views/providers';

/**
 * The ytdrivarr operator console shell (DESIGN-045 D-20, M1): a hash-routed vanilla-TS SPA served
 * by the service itself. It is a THIN VIEW over the same REST API the app consumes — one X-Api-Key
 * guards both (D-21), entered once and kept in localStorage (LAN-only by design). A 401 anywhere
 * returns to key entry.
 */

type View = (root: HTMLElement, refresh: () => void) => Promise<void>;

const ROUTES: { hash: string; label: string; view: View }[] = [
  { hash: '#/sources', label: 'Sources', view: renderSources },
  { hash: '#/libraries', label: 'Libraries', view: (root) => renderLibraries(root) },
  { hash: '#/runs', label: 'Runs', view: renderRuns },
  { hash: '#/health', label: 'Health', view: renderHealth },
  { hash: '#/providers', label: 'Providers', view: (root) => renderProviders(root) },
];

const app = document.getElementById('app');
if (!app) throw new Error('missing #app mount point');
const mount: HTMLElement = app;

function currentRoute(): { hash: string; label: string; view: View } {
  const found = ROUTES.find((r) => r.hash === window.location.hash);
  return found ?? ROUTES[0]!;
}

// --- key entry ---------------------------------------------------------------------------------

function renderKeyScreen(message?: string): void {
  const keyInput = el('input', {
    type: 'password',
    placeholder: 'X-Api-Key',
    autocomplete: 'off',
    'aria-label': 'API key',
  });
  const errorLine = el('div', { class: 'key-error' }, message ?? '');
  const connectBtn = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Connect');

  const form = el(
    'form',
    {
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        const key = keyInput.value.trim();
        if (!key) {
          errorLine.textContent = 'enter the service API key';
          return;
        }
        connectBtn.disabled = true;
        errorLine.textContent = '';
        void verifyKey(key)
          .then((ok) => {
            if (ok) {
              setApiKey(key);
              renderShell();
            } else {
              errorLine.textContent = 'key rejected (401 from /api/v1/providers)';
            }
          })
          .catch(() => {
            errorLine.textContent = 'could not reach the API';
          })
          .finally(() => {
            connectBtn.disabled = false;
          });
      },
    },
    keyInput,
    errorLine,
    connectBtn,
  );

  mount.replaceChildren(
    el(
      'div',
      { class: 'key-screen' },
      el(
        'div',
        { class: 'key-card' },
        el(
          'div',
          { class: 'wordmark' },
          el('span', { class: 'mark' }, '▶'),
          el('span', {}, 'ytdrivarr'),
        ),
        el(
          'p',
          {},
          'Operator console. Enter the service API key (the same single ',
          el('code', {}, 'X-Api-Key'),
          ' that guards the REST API — no accounts, no roles).',
        ),
        form,
        el(
          'div',
          { class: 'key-foot' },
          el('a', { href: '/health', target: '_blank', rel: 'noreferrer' }, '/health'),
          ' · ',
          el('a', { href: '/openapi.json', target: '_blank', rel: 'noreferrer' }, '/openapi.json'),
        ),
      ),
    ),
  );
  keyInput.focus();
}

// --- authed shell ------------------------------------------------------------------------------

let contentEl: HTMLElement | null = null;
let navEl: HTMLElement | null = null;

function renderShell(): void {
  navEl = el('nav', { class: 'nav' });
  for (const route of ROUTES) {
    navEl.append(el('a', { href: route.hash }, route.label));
  }

  const disconnect = el('button', { class: 'btn-link', type: 'button' }, 'disconnect');
  disconnect.addEventListener('click', () => {
    clearApiKey();
    renderKeyScreen();
  });

  contentEl = el('main', { class: 'content' });

  mount.replaceChildren(
    el(
      'div',
      { class: 'shell' },
      el(
        'aside',
        { class: 'sidebar' },
        el(
          'div',
          { class: 'wordmark' },
          el('span', { class: 'mark' }, '▶'),
          el('span', {}, 'ytdrivarr'),
        ),
        navEl,
        el(
          'div',
          { class: 'sidebar-foot' },
          el(
            'span',
            {},
            el('a', { href: '/openapi.json', target: '_blank', rel: 'noreferrer' }, 'OpenAPI'),
            ' · ',
            el('a', { href: '/health', target: '_blank', rel: 'noreferrer' }, 'health'),
          ),
          disconnect,
        ),
      ),
      contentEl,
    ),
  );

  void renderCurrentView();
}

async function renderCurrentView(): Promise<void> {
  if (!contentEl || !navEl) return;
  const route = currentRoute();

  for (const link of navEl.querySelectorAll('a')) {
    link.classList.toggle('active', link.getAttribute('href') === route.hash);
  }

  const root = el('div', {});
  root.append(el('div', { class: 'loading' }, 'Loading…'));
  contentEl.replaceChildren(root);

  const fresh = el('div', {});
  try {
    await route.view(fresh, () => void renderCurrentView());
    contentEl.replaceChildren(fresh);
  } catch (err) {
    // a 401 already routed to key entry via the event; anything else is shown honestly
    if (getApiKey() !== null) {
      contentEl.replaceChildren(errorBanner(err));
    }
  }
}

// --- boot --------------------------------------------------------------------------------------

window.addEventListener('hashchange', () => {
  if (getApiKey() !== null) void renderCurrentView();
});

window.addEventListener(UNAUTHORIZED_EVENT, () => {
  renderKeyScreen('the API rejected the stored key — enter it again');
});

async function boot(): Promise<void> {
  // Sonarr's "Disabled for Local Addresses" experience (owner ruling 2026-07-20): on a keyless
  // (open) LAN deployment the API answers unauthenticated, so skip the key gate entirely and go
  // straight to Sources. A stale localStorage key is irrelevant in open mode (the server ignores
  // it) — clear it here so it can never wedge the flow or a later api-key flip.
  let open = false;
  try {
    open = await isOpenDeployment();
  } catch {
    open = false;
  }
  if (open) clearApiKey();

  if (chooseInitialScreen({ open, hasStoredKey: getApiKey() !== null }) === 'shell') {
    renderShell();
  } else {
    renderKeyScreen();
  }
}

void boot();
