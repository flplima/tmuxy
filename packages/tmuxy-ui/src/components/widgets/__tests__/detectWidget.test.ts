import { describe, it, expect } from 'vitest';
import { detectWidget, registerWidget } from '../index';
import type { PaneContent } from '../../../tmux/types';

// The registry is populated by `widgets/init.ts` at app start; two stand-ins
// are enough here — what is under test is the authorisation, not the widgets.
const stub = { component: () => null };
registerWidget('browser', stub);
registerWidget('tree', stub);

const lines = (...rows: string[]): PaneContent => rows.map((row) => [...row].map((c) => ({ c })));

const MARKER = '__TMUXY_WIDGET__:browser';

/**
 * SEC-18. The marker travels in pane OUTPUT — `cat` of a crafted file, a
 * commit message in `git log`, `curl` output, an ssh MOTD. Without an
 * out-of-band authorisation, any of those could replace the pane with an
 * iframe of an attacker's page: a phishing surface that looks like the
 * terminal it replaced.
 */
describe('detectWidget', () => {
  it('renders the widget a pane was actually tagged for', () => {
    const info = detectWidget(lines(MARKER, '__SRC__:https://example.com'), 'browser');
    expect(info?.widgetName).toBe('browser');
    expect(info?.contentLines).toEqual(['__SRC__:https://example.com']);
  });

  it('ignores a marker in the output of a pane that was never tagged', () => {
    expect(detectWidget(lines(MARKER, '__SRC__:https://evil.example'), null)).toBeNull();
    expect(detectWidget(lines(MARKER, '__SRC__:https://evil.example'), undefined)).toBeNull();
    expect(detectWidget(lines(MARKER, '__SRC__:https://evil.example'), '')).toBeNull();
  });

  it('will not let one widget be turned into another by what it prints', () => {
    // A pane legitimately running the tree widget cats a file naming `browser`.
    expect(detectWidget(lines(MARKER, '__SRC__:https://evil.example'), 'tree')).toBeNull();
  });

  it('finds the marker below a shell prompt, as it appears in practice', () => {
    const info = detectWidget(lines('$ tmuxy open example.com', MARKER, '__SRC__:x'), 'browser');
    expect(info?.widgetName).toBe('browser');
  });

  /**
   * The marker is ALWAYS required, and that is what keeps a stale tag — a
   * widget killed before its EXIT trap could unset it — from drawing a widget
   * over the live shell that replaced it.
   *
   * There was briefly an exception, for a pane whose widget kept printing and
   * scrolled its own marker away. Nothing does that any more: the server-side
   * browser is a full-screen pane PROGRAM (`browser/pane.rs`) and not a widget
   * at all, so the exception went with it and the rule is simple again.
   */
  describe('the tag and the marker must agree', () => {
    it('renders nothing when the marker is absent', () => {
      expect(detectWidget(lines('a live shell', '$ ls'), 'browser')).toBeNull();
      expect(detectWidget(lines(MARKER, 'x'), 'tree')).toBeNull();
    });

    /**
     * A pane tagged for `tree` cats a file naming `browser`. The marker names a
     * real widget and is still refused: a pane must not be turned into another
     * widget by something it prints.
     */
    it('never renders the widget the OUTPUT names, only the tagged one', () => {
      expect(detectWidget(lines(MARKER, 'x'), 'tree')).toBeNull();
      expect(detectWidget(lines(MARKER, 'x'), 'browser')?.widgetName).toBe('browser');
    });

    it('refuses a tag naming a widget that does not exist', () => {
      expect(detectWidget(lines(MARKER, 'x'), 'nosuchwidget')).toBeNull();
      // Including the old `widget:instance` form, which is now simply a name
      // no widget has.
      expect(detectWidget(lines(MARKER, 'x'), 'browser:live')).toBeNull();
    });

    /** Still nothing without a tag, marker or no marker. */
    it('renders nothing for an untagged pane however it scrolled', () => {
      expect(detectWidget(lines('whatever', 'output'), null)).toBeNull();
      expect(detectWidget(lines(MARKER), null)).toBeNull();
    });
  });
});
