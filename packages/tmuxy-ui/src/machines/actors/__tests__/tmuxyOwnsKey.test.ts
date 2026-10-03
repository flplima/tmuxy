/**
 * Which keys tmuxy keeps, and which reach a server-side page.
 *
 * This is the precedence rule for a browser-session pane, and it is asked from
 * an awkward place. The widget's key handler runs in the CAPTURE phase, ahead
 * of the keyboard actor's bubble-phase listener, so a widget that simply
 * forwarded every key would swallow the tmux prefix — and a pane whose prefix
 * does not work is a pane you cannot leave. Instead the widget asks this and
 * declines what tmuxy owns, which produces the same precedence from the other
 * side.
 *
 * So the tests that matter are the ones about NOT forwarding. A key wrongly
 * sent to the page is a key tmuxy did not act on.
 */

import { describe, expect, it } from 'vitest';
import { tmuxyOwnsKey } from '../keyboardActor';

/** A keydown as the browser delivers it. */
function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    ...init,
  } as KeyboardEventInit);
}

const noPrefix = { prefixKey: '', prefixActive: false };
const ctrlA = { prefixKey: 'C-a', prefixActive: false };

describe('tmuxyOwnsKey', () => {
  describe('the prefix is never forwarded', () => {
    it('keeps the configured prefix chord', () => {
      expect(tmuxyOwnsKey(key({ key: 'a', ctrlKey: true }), ctrlA)).toBe(true);
    });

    /**
     * The prefix is configurable, and this must follow it rather than knowing
     * about `C-a` — which is why the question is asked through the same
     * formatter the actor uses to name a key for tmux.
     */
    it('follows a prefix that is not the default', () => {
      expect(
        tmuxyOwnsKey(key({ key: 'b', ctrlKey: true }), { prefixKey: 'C-b', prefixActive: false }),
      ).toBe(true);
      // And then C-a is just a key the page may have.
      expect(
        tmuxyOwnsKey(key({ key: 'a', ctrlKey: true }), { prefixKey: 'C-b', prefixActive: false }),
      ).toBe(false);
    });

    /**
     * The key AFTER the prefix is the half that names the binding. Forwarding
     * it would run the page's shortcut and tmuxy's at once.
     */
    it('keeps every key while prefix mode is live', () => {
      for (const k of ['c', 'n', '[', 'z', 'ArrowLeft', 'Enter']) {
        expect(tmuxyOwnsKey(key({ key: k }), { prefixKey: 'C-a', prefixActive: true })).toBe(true);
      }
    });
  });

  describe("the app's own shortcuts", () => {
    it('keeps the window and selection chords', () => {
      // bare Cmd on a Mac, Ctrl+Shift elsewhere — `windowShortcut`.
      expect(tmuxyOwnsKey(key({ key: 'n', metaKey: true }), noPrefix)).toBe(true);
      expect(tmuxyOwnsKey(key({ key: 'N', ctrlKey: true, shiftKey: true }), noPrefix)).toBe(true);
    });

    /** Root-table pane and tab bindings wear Alt. */
    it('keeps an Alt chord, which is a root binding', () => {
      expect(tmuxyOwnsKey(key({ key: 'h', altKey: true }), noPrefix)).toBe(true);
    });
  });

  describe('everything else goes to the page', () => {
    it('forwards ordinary typing', () => {
      for (const k of ['a', 'Z', '1', ' ', '/', 'é']) {
        expect(tmuxyOwnsKey(key({ key: k }), ctrlA)).toBe(false);
      }
    });

    it('forwards the keys a page navigates and edits with', () => {
      for (const k of ['Enter', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'Home', 'Escape']) {
        expect(tmuxyOwnsKey(key({ key: k }), ctrlA)).toBe(false);
      }
    });

    /**
     * A Ctrl chord that is not the prefix belongs to the page — Ctrl+F to find,
     * Ctrl+Enter to submit. (Ctrl+C is claimed earlier, by the pane, to close
     * the widget; that is `WidgetPane`'s rule and not this one's.)
     */
    it('forwards a Ctrl chord that is not the prefix', () => {
      expect(tmuxyOwnsKey(key({ key: 'f', ctrlKey: true }), ctrlA)).toBe(false);
      expect(tmuxyOwnsKey(key({ key: 'Enter', ctrlKey: true }), ctrlA)).toBe(false);
    });

    /** Shift+key is text, not a chord. */
    it('forwards a shifted character', () => {
      expect(tmuxyOwnsKey(key({ key: 'A', shiftKey: true }), ctrlA)).toBe(false);
    });
  });

  /**
   * With no prefix configured yet — the keybindings arrive on their own event
   * after connect — nothing should be mistaken for it. An empty prefix must
   * not match an empty formatted key.
   */
  it('claims nothing as a prefix before the keybindings have arrived', () => {
    expect(tmuxyOwnsKey(key({ key: 'a', ctrlKey: true }), noPrefix)).toBe(false);
    expect(tmuxyOwnsKey(key({ key: 'Shift', shiftKey: true }), noPrefix)).toBe(false);
  });
});
