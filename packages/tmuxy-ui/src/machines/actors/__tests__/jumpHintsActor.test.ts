import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createActor } from 'xstate';
import { createJumpHintsActor, JUMP_HINT_DELAY_MS } from '../jumpHintsActor';

const down = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
const up = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, ...init }));
const shown = () => ({
  tabs: document.body.classList.contains('jump-hints-tabs'),
  panes: document.body.classList.contains('jump-hints-panes'),
});

describe('jumpHintsActor', () => {
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    const actor = createActor(createJumpHintsActor()).start();
    stop = () => actor.stop();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('ctrl held alone shows the tab numbers after a moment, and letting go hides them', () => {
    down({ key: 'Control', ctrlKey: true });
    expect(shown().tabs).toBe(false);
    vi.advanceTimersByTime(JUMP_HINT_DELAY_MS);
    expect(shown()).toEqual({ tabs: true, panes: false });

    up({ key: 'Control' });
    expect(shown()).toEqual({ tabs: false, panes: false });
  });

  it('alt under ctrl switches to the pane numbers, and back when alt is let go', () => {
    down({ key: 'Control', ctrlKey: true });
    down({ key: 'Alt', ctrlKey: true, altKey: true });
    vi.advanceTimersByTime(JUMP_HINT_DELAY_MS);
    expect(shown()).toEqual({ tabs: false, panes: true });

    up({ key: 'Alt', ctrlKey: true });
    expect(shown()).toEqual({ tabs: true, panes: false });
  });

  it('a shortcut under ctrl never shows them: ctrl+c, or a jump made before they appeared', () => {
    for (const key of [
      { key: 'c', code: 'KeyC' },
      { key: '2', code: 'Digit2' },
    ]) {
      down({ key: 'Control', ctrlKey: true });
      down({ ...key, ctrlKey: true });
      vi.advanceTimersByTime(JUMP_HINT_DELAY_MS * 3);
      expect(shown().tabs, key.key).toBe(false);
      // ...not even if ctrl stays down: only a fresh hold shows them.
      up({ ...key, ctrlKey: true });
      vi.advanceTimersByTime(JUMP_HINT_DELAY_MS * 3);
      expect(shown().tabs, key.key).toBe(false);
      up({ key: 'Control' });
    }
  });

  it('jumps made while they are up keep them up; another key hides them', () => {
    down({ key: 'Control', ctrlKey: true });
    vi.advanceTimersByTime(JUMP_HINT_DELAY_MS);
    down({ key: '3', code: 'Digit3', ctrlKey: true });
    down({ key: '1', code: 'Digit1', ctrlKey: true });
    expect(shown().tabs).toBe(true);

    down({ key: 'w', code: 'KeyW', ctrlKey: true });
    expect(shown().tabs).toBe(false);
  });

  it('leaving the window with ctrl down hides them: its keyup never arrives', () => {
    down({ key: 'Control', ctrlKey: true });
    vi.advanceTimersByTime(JUMP_HINT_DELAY_MS);
    window.dispatchEvent(new Event('blur'));
    expect(shown().tabs).toBe(false);
  });

  it('a chord with shift or cmd is not a jump chord', () => {
    down({ key: 'Shift', ctrlKey: true, shiftKey: true });
    down({ key: 'Meta', metaKey: true });
    vi.advanceTimersByTime(JUMP_HINT_DELAY_MS * 2);
    expect(shown()).toEqual({ tabs: false, panes: false });
  });
});
