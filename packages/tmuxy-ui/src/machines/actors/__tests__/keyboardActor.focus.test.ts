/**
 * The page gets the focus with no pane asked for it — a reload, a switch back
 * to the tab, a return to the window — and the browser restores whatever
 * element it last had. Typing must reach the active pane from there without
 * a click on it; a real form control keeps what is typed into it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pid } from '../../../test/wire';
import { pressKey, sendCommands, spawnKeyboardActor } from './keyboardHarness';
import * as mobileKeyboard from '../../../infra/dom/mobileKeyboard';

const { getMobileInput } = mobileKeyboard;

/** The browser giving the page its focus back, with `element` restored. */
function pageGetsFocusWith(element: HTMLElement) {
  element.focus();
  window.dispatchEvent(new Event('focus'));
}

describe('keyboardActor — the page gets the focus with no pane clicked', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  let chrome: HTMLButtonElement;
  let field: HTMLInputElement;

  beforeEach(() => {
    // jsdom has no `matchMedia` and answers to `ontouchstart`; this is a
    // desktop, where the hidden input holds the keyboard. A phone keeps it
    // down until the ⌨ key.
    vi.spyOn(mobileKeyboard, 'touchIsPrimary').mockReturnValue(false);
    chrome = document.createElement('button');
    field = document.createElement('input');
    document.body.append(chrome, field);
    handle = spawnKeyboardActor(pid('%3'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    chrome.remove();
    field.remove();
  });

  it('takes the keyboard from a chrome control the browser restored, and a key reaches the pane', () => {
    pageGetsFocusWith(chrome);
    expect(document.activeElement).toBe(getMobileInput());
    pressKey({ key: 'Enter' });
    expect(sendCommands(handle.events)).toEqual(['send-keys -t %3 Enter']);
  });

  it('takes the keyboard from the body, where a restore lands after a re-render', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(getMobileInput());
  });

  it('leaves a real form control alone, and what is typed there stays there', () => {
    pageGetsFocusWith(field);
    expect(document.activeElement).toBe(field);
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }),
    );
    expect(sendCommands(handle.events)).toEqual([]);
  });

  // The palette's box holds the keyboard while it is open. With the focus
  // knocked off it, handing the keyboard to a pane's input would put what
  // is typed next, a composition above all, into the pane behind it.
  it('leaves the keyboard where it is while the command palette is open', () => {
    handle.set({ palette: 'all' });
    pageGetsFocusWith(chrome);
    expect(document.activeElement).toBe(chrome);

    handle.set({ palette: null });
    pageGetsFocusWith(chrome);
    expect(document.activeElement).toBe(getMobileInput());
  });

  it('reclaims on the tab becoming visible too', () => {
    pageGetsFocusWith(chrome);
    chrome.focus();
    expect(document.activeElement).toBe(chrome);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.activeElement).toBe(getMobileInput());
  });

  it('takes it on a desktop whose screen also takes touch, and leaves it on a phone', () => {
    // Touch points (jsdom has `ontouchstart`) with the mouse as the primary
    // pointer: a touchscreen laptop. Only a coarse primary pointer is a phone.
    vi.mocked(mobileKeyboard.touchIsPrimary).mockRestore();
    for (const [coarse, takes] of [
      [false, true],
      [true, false],
    ] as const) {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(pointer: coarse)' && coarse,
      }));
      expect('ontouchstart' in window).toBe(true);
      pageGetsFocusWith(chrome);
      expect(document.activeElement === getMobileInput()).toBe(takes);
    }
    vi.unstubAllGlobals();
  });
});
