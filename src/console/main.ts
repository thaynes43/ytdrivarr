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
import { el, errorBanner, icon } from './dom';
import { getSearch, onSearch, setSearch } from './search';
import { NAV, resolveRoute } from './routes';

/**
 * The ytdrivarr operator console shell (DESIGN-045 D-20) — the *arr design language (design
 * record: docs/mockups/, PR #14): black header with brand + search, dark left sidebar with an
 * expanding sub-nav (Sources / Activity / Settings / System), and a page-scoped icon toolbar
 * rendered by each view. Hash-routed vanilla TS served by the service itself; a THIN VIEW over
 * the same REST API the app consumes. The route table lives in `routes.ts`.
 *
 * Auth posture (D-21): on an `open` (keyless LAN) deployment the console needs no credential and
 * boots straight to Sources — Sonarr's "Disabled for Local Addresses". On an api-key deployment
 * the key screen still guards entry, and any 401 returns to it.
 */

const app = document.getElementById('app');
if (!app) throw new Error('missing #app mount point');
const mount: HTMLElement = app;

let openMode = false;

// --- key entry (api-key deployments only) ------------------------------------------------------

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
          el('span', { class: 'mark' }, icon('play')),
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

// --- shell -------------------------------------------------------------------------------------

let mainEl: HTMLElement | null = null;
let navEl: HTMLElement | null = null;

function closeDrawer(): void {
  document.body.classList.remove('drawer-open');
}

function buildNav(): HTMLElement {
  const nav = el('nav', { class: 'side', 'aria-label': 'Main navigation' });
  const route = resolveRoute(window.location.hash);

  for (const section of NAV) {
    const sectionActive = section === route.section;
    const link = el(
      'a',
      { href: section.hash, onclick: () => closeDrawer() },
      el(
        'span',
        { class: `nav-item${sectionActive ? ' active' : ''}` },
        icon(section.icon),
        section.label,
      ),
    );
    nav.append(link);
    if (sectionActive && section.children && section.children.length > 0) {
      const sub = el('div', { class: 'nav-sub' });
      for (const child of section.children) {
        const childActive = route.child
          ? child.hash === route.child.hash
          : child.hash === route.hash;
        sub.append(
          el(
            'a',
            { href: child.hash, onclick: () => closeDrawer() },
            el('span', { class: `nav-item${childActive ? ' active' : ''}` }, child.label),
          ),
        );
      }
      nav.append(sub);
    }
  }

  const foot = el('div', { class: 'side-foot' });
  foot.append(
    el(
      'span',
      {},
      el('a', { href: '/openapi.json', target: '_blank', rel: 'noreferrer' }, 'OpenAPI'),
      ' · ',
      el('a', { href: '/health', target: '_blank', rel: 'noreferrer' }, 'health'),
    ),
  );
  if (!openMode) {
    const disconnect = el('button', { class: 'btn-link', type: 'button' }, 'disconnect');
    disconnect.addEventListener('click', () => {
      clearApiKey();
      renderKeyScreen();
    });
    foot.append(disconnect);
  }
  nav.append(foot);
  return nav;
}

function buildHeader(): HTMLElement {
  const burger = el(
    'button',
    { class: 'burger', type: 'button', 'aria-label': 'Menu' },
    icon('burger'),
  );
  burger.addEventListener('click', () => {
    document.body.classList.toggle('drawer-open');
  });

  const searchInput = el('input', {
    type: 'text',
    placeholder: 'Search',
    'aria-label': 'Search sources',
  });
  searchInput.value = getSearch();
  searchInput.addEventListener('input', () => {
    setSearch(searchInput.value);
    // Searching is a Sources concern — typing anywhere else lands you on the list it filters.
    if (!window.location.hash.startsWith('#/sources')) {
      window.location.hash = '#/sources';
    }
  });

  return el(
    'header',
    { class: 'hdr' },
    burger,
    el(
      'div',
      { class: 'brand' },
      el('span', { class: 'mark' }, icon('play')),
      el('span', { class: 'word' }, 'ytdriv', el('i', {}, 'arr')),
    ),
    el('div', { class: 'search' }, icon('search'), searchInput),
    el('div', { class: 'spacer' }),
    openMode ? el('span', { class: 'keyless' }, 'Keyless on LAN') : null,
  );
}

function renderShell(): void {
  mainEl = el('main', { class: 'main' });
  navEl = buildNav();

  const scrim = el('div', { class: 'drawer-scrim' });
  scrim.addEventListener('click', closeDrawer);

  mount.replaceChildren(buildHeader(), el('div', { class: 'shell' }, navEl, scrim, mainEl));

  void renderCurrentView();
}

async function renderCurrentView(): Promise<void> {
  if (!mainEl || !navEl) return;

  const freshNav = buildNav();
  navEl.replaceWith(freshNav);
  navEl = freshNav;

  const route = resolveRoute(window.location.hash);
  const root = el('div', {});
  root.append(el('div', { class: 'content' }, el('div', { class: 'loading' }, 'Loading…')));
  mainEl.replaceChildren(root);

  const fresh = el('div', {});
  try {
    await route.view(fresh, () => void renderCurrentView());
    mainEl.replaceChildren(fresh);
  } catch (err) {
    // a 401 already routed to key entry via the event; anything else is shown honestly
    if (openMode || getApiKey() !== null) {
      mainEl.replaceChildren(el('div', { class: 'content' }, errorBanner(err)));
    }
  }
}

// --- boot --------------------------------------------------------------------------------------

window.addEventListener('hashchange', () => {
  if (openMode || getApiKey() !== null) void renderCurrentView();
});

window.addEventListener(UNAUTHORIZED_EVENT, () => {
  renderKeyScreen('the API rejected the stored key — enter it again');
});

onSearch(() => {
  // Re-render only the Sources list on search input; the view itself reads getSearch().
  if (resolveRoute(window.location.hash).section.hash === '#/sources') {
    window.dispatchEvent(new CustomEvent('ytdrivarr:search-render'));
  }
});

async function boot(): Promise<void> {
  // Sonarr's "Disabled for Local Addresses" experience (owner ruling 2026-07-20): on a keyless
  // (open) LAN deployment the API answers unauthenticated, so skip the key gate entirely and go
  // straight to Sources. A stale localStorage key is irrelevant in open mode (the server ignores
  // it) — clear it here so it can never wedge the flow or a later api-key flip.
  try {
    openMode = await isOpenDeployment();
  } catch {
    openMode = false;
  }
  if (openMode) clearApiKey();

  if (chooseInitialScreen({ open: openMode, hasStoredKey: getApiKey() !== null }) === 'shell') {
    renderShell();
  } else {
    renderKeyScreen();
  }
}

void boot();
