/**
 * The page-scoped icon toolbar (the *arr idiom): action groups left, view controls right, the
 * page's exact API counterpart as a mono tag on the far right. Dropdown menus render as absolute
 * OVERLAYS under their button — opening one never reflows the toolbar or the page.
 */

import { el, icon } from './dom';
import type { IconName } from './icons';

export interface ToolbarAction {
  label: string;
  icon: IconName;
  onClick: (button: HTMLButtonElement) => void | Promise<void>;
  hideOnPhone?: boolean;
}

export interface MenuChoice {
  value: string;
  label: string;
}

export interface ToolbarMenu {
  label: string;
  icon: IconName;
  choices: MenuChoice[];
  selected: string;
  onSelect: (value: string) => void;
  hideOnPhone?: boolean;
}

function actionButton(action: ToolbarAction): HTMLButtonElement {
  const button = el(
    'button',
    { class: `tb-btn${action.hideOnPhone ? ' hide-m' : ''}`, type: 'button' },
    icon(action.icon),
    el('span', {}, action.label),
  );
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('busy');
    void Promise.resolve(action.onClick(button)).finally(() => {
      button.disabled = false;
      button.classList.remove('busy');
    });
  });
  return button;
}

function menuButton(menu: ToolbarMenu): HTMLElement {
  const caret = el('span', { class: 'caret' }, '▼');
  const button = el(
    'button',
    {
      class: `tb-btn${menu.hideOnPhone ? ' hide-m' : ''}`,
      type: 'button',
      'aria-haspopup': 'true',
      'aria-expanded': 'false',
    },
    icon(menu.icon),
    el('span', {}, menu.label, ' ', caret),
  );

  let panel: HTMLElement | null = null;
  const close = (): void => {
    panel?.remove();
    panel = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
  };
  const onOutside = (ev: MouseEvent): void => {
    if (ev.target instanceof Node && (button.contains(ev.target) || panel?.contains(ev.target))) {
      return;
    }
    close();
  };

  button.addEventListener('click', () => {
    if (panel) {
      close();
      return;
    }
    panel = el('div', { class: 'tb-menu', role: 'menu' });
    for (const choice of menu.choices) {
      const item = el(
        'button',
        {
          class: choice.value === menu.selected ? 'selected' : '',
          type: 'button',
          role: 'menuitem',
        },
        choice.label,
      );
      item.addEventListener('click', () => {
        close();
        menu.onSelect(choice.value);
      });
      panel.append(item);
    }
    // Anchor the overlay under this button, inside the relatively-positioned toolbar.
    const toolbar = button.closest('.toolbar');
    if (toolbar instanceof HTMLElement) {
      const left = button.getBoundingClientRect().left - toolbar.getBoundingClientRect().left;
      panel.style.left = `${Math.max(0, Math.min(left, toolbar.clientWidth - 190))}px`;
      toolbar.append(panel);
    } else {
      button.append(panel);
    }
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onOutside, true);
  });

  return button;
}

export function toolbar(opts: {
  actions: ToolbarAction[];
  menus?: ToolbarMenu[];
  apiPath: string;
}): HTMLElement {
  const bar = el('div', { class: 'toolbar' });
  const left = el('div', { class: 'tb-group' });
  for (const action of opts.actions) left.append(actionButton(action));
  bar.append(left, el('div', { class: 'tb-spacer' }));
  if (opts.menus && opts.menus.length > 0) {
    const right = el('div', { class: 'tb-group' });
    for (const menu of opts.menus) right.append(menuButton(menu));
    bar.append(right);
  }
  bar.append(
    el(
      'span',
      { class: 'tb-api' },
      el('b', {}, 'GET'),
      ' ',
      el('a', { href: opts.apiPath, target: '_blank', rel: 'noreferrer' }, opts.apiPath),
    ),
  );
  return bar;
}
