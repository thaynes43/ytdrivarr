/**
 * The inline two-step arm-then-confirm button for destructive actions — the estate UX doctrine
 * travels: no window.confirm, no dialogs for a single destructive verb. Both labels are rendered
 * stacked in the same grid cell so the button's width is RESERVED for the widest one — arming
 * deepens color, it never reflows the row. Arming disarms on an outside click or a timeout.
 */

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

  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = (): void => {
    button.removeAttribute('data-armed');
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    document.removeEventListener('click', onOutsideClick, true);
  };

  const onOutsideClick = (ev: MouseEvent): void => {
    if (ev.target instanceof Node && button.contains(ev.target)) return;
    disarm();
  };

  button.addEventListener('click', () => {
    if (button.disabled) return;
    if (button.getAttribute('data-armed') !== 'true') {
      button.setAttribute('data-armed', 'true');
      timer = setTimeout(disarm, disarmMs);
      document.addEventListener('click', onOutsideClick, true);
      return;
    }
    disarm();
    button.disabled = true;
    void Promise.resolve(onConfirm()).finally(() => {
      button.disabled = false;
    });
  });

  return button;
}
