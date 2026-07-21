/**
 * The inline two-step arm-then-confirm controls for destructive actions — the estate UX doctrine
 * travels: no window.confirm, no dialogs for a single destructive verb. Both states render
 * STACKED in the same grid cell so the control's width is RESERVED for the widest one — arming
 * deepens color, it never reflows the row. Arming disarms on an outside click or a timeout.
 *
 * Two shapes share the arm/disarm mechanics:
 *   - `createConfirmButton` — a labeled button (form panels): label ↔ armed label in place.
 *   - `createIconConfirm`   — the *arr table-row idiom: a trash icon that arms into a
 *     `Sure? Remove` slab inside a width-reserved slot.
 */

import { el, icon } from './dom';
import type { IconName } from './icons';

interface ArmController {
  arm(): void;
  disarm(): void;
  isArmed(): boolean;
}

/** Shared arm/disarm state machine: outside-click and timeout both disarm. */
function armable(host: HTMLElement, disarmMs: number): ArmController {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onOutsideClick = (ev: MouseEvent): void => {
    if (ev.target instanceof Node && host.contains(ev.target)) return;
    disarm();
  };

  function disarm(): void {
    host.removeAttribute('data-armed');
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    document.removeEventListener('click', onOutsideClick, true);
  }

  function arm(): void {
    host.setAttribute('data-armed', 'true');
    timer = setTimeout(disarm, disarmMs);
    document.addEventListener('click', onOutsideClick, true);
  }

  return { arm, disarm, isArmed: () => host.getAttribute('data-armed') === 'true' };
}

export interface ConfirmButtonOptions {
  label: string;
  armedLabel: string;
  onConfirm: () => void | Promise<void>;
  disarmMs?: number;
}

export function createConfirmButton(opts: ConfirmButtonOptions): HTMLButtonElement {
  const { label, armedLabel, onConfirm, disarmMs = 4000 } = opts;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-danger confirm-btn';

  const idle = document.createElement('span');
  idle.className = 'confirm-label confirm-idle';
  idle.textContent = label;
  const armed = document.createElement('span');
  armed.className = 'confirm-label confirm-armed';
  armed.textContent = armedLabel;
  button.append(idle, armed);

  const control = armable(button, disarmMs);

  button.addEventListener('click', () => {
    if (button.disabled) return;
    if (!control.isArmed()) {
      control.arm();
      return;
    }
    control.disarm();
    button.disabled = true;
    void Promise.resolve(onConfirm()).finally(() => {
      button.disabled = false;
    });
  });

  return button;
}

export interface IconConfirmOptions {
  /** the idle icon (default trash). */
  icon?: IconName;
  /** accessible name for the idle icon button. */
  title: string;
  armedLabel: string;
  onConfirm: () => void | Promise<void>;
  disarmMs?: number;
}

/**
 * The table-row two-step: idle = a muted icon button; armed = a deep-red slab with the armed
 * label. Both render stacked in one `.confirm-slot` grid cell, so the slot is as wide as the
 * armed slab from the start — arming recolors, never moves the row.
 */
export function createIconConfirm(opts: IconConfirmOptions): HTMLElement {
  const { title, armedLabel, onConfirm, disarmMs = 4000 } = opts;

  const slot = el('span', { class: 'confirm-slot' });
  const idle = el(
    'button',
    { class: 'icon-btn confirm-idle', type: 'button', title, 'aria-label': title },
    icon(opts.icon ?? 'trash'),
  );
  const armed = el('button', { class: 'confirm-armed', type: 'button' }, armedLabel);
  slot.append(idle, armed);

  const control = armable(slot, disarmMs);

  idle.addEventListener('click', () => {
    if (!control.isArmed()) control.arm();
  });
  armed.addEventListener('click', () => {
    if (!control.isArmed()) return;
    control.disarm();
    armed.disabled = true;
    void Promise.resolve(onConfirm()).finally(() => {
      armed.disabled = false;
    });
  });

  return slot;
}
