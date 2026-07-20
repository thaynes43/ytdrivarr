// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfirmButton } from './confirm-button';

/**
 * The two-step arm-then-confirm doctrine: one click never destroys; the armed state deepens color
 * without moving the row (both labels are always in the DOM, stacked in one grid cell, so the
 * width is reserved for the widest); arming decays on an outside click or a timeout.
 */

describe('createConfirmButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  function make(onConfirm = vi.fn()) {
    const btn = createConfirmButton({
      label: 'Remove',
      armedLabel: 'Confirm remove',
      onConfirm,
    });
    document.body.append(btn);
    return { btn, onConfirm };
  }

  it('renders BOTH labels so the width is reserved for the widest (no reflow on arm)', () => {
    const { btn } = make();
    const labels = [...btn.querySelectorAll('.confirm-label')].map((n) => n.textContent);
    expect(labels).toEqual(['Remove', 'Confirm remove']);
  });

  it('does not confirm on the first click — it arms', () => {
    const { btn, onConfirm } = make();
    btn.click();
    expect(btn.getAttribute('data-armed')).toBe('true');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms on the second click', () => {
    const { btn, onConfirm } = make();
    btn.click();
    btn.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute('data-armed')).toBeNull();
  });

  it('disarms on an outside click without confirming', () => {
    const { btn, onConfirm } = make();
    btn.click();
    document.body.click();
    expect(btn.getAttribute('data-armed')).toBeNull();
    btn.click(); // arms again, does not fire
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disarms after the timeout', () => {
    const { btn, onConfirm } = make();
    btn.click();
    vi.advanceTimersByTime(4001);
    expect(btn.getAttribute('data-armed')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
