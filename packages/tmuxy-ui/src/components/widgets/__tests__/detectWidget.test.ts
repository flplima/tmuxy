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
   * `browser:live` — which widget, and which instance of it. The instance
   * rides the authorisation rather than pane output because output scrolls
   * away, and because a session name is exactly as sensitive as the tag it
   * belongs to.
   */
  describe('instances', () => {
    it('splits the instance off the tag and still authorises the widget', () => {
      const info = detectWidget(lines(MARKER, 'tmuxy browser [live]'), 'browser:live');
      expect(info?.widgetName).toBe('browser');
      expect(info?.instance).toBe('live');
    });

    it('reports no instance for a plain tag', () => {
      expect(detectWidget(lines(MARKER, '__SRC__:x'), 'browser')?.instance).toBe('');
    });

    /**
     * A pane tagged for `tree` cats a file naming `browser`. The marker is
     * refused, and `tree` is what the pane is for — so with an instance it
     * renders `tree`, never the widget the output asked for.
     */
    it('never renders the widget the OUTPUT names, only the tagged one', () => {
      const info = detectWidget(lines(MARKER, 'x'), 'tree:whatever');
      expect(info?.widgetName).toBe('tree');
      expect(info?.instance).toBe('whatever');
    });

    /**
     * Without an instance the marker is required, which is what keeps a stale
     * tag — a widget killed before its EXIT trap could unset it — from drawing
     * a widget over the live shell that replaced it.
     */
    it('renders nothing for a plain tag whose marker is absent', () => {
      expect(detectWidget(lines('a live shell', '$ ls'), 'browser')).toBeNull();
      expect(detectWidget(lines(MARKER, 'x'), 'tree')).toBeNull();
    });

    it('refuses a tag naming a widget that does not exist', () => {
      expect(detectWidget(lines(MARKER, 'x'), 'nosuchwidget')).toBeNull();
      expect(detectWidget(lines(MARKER, 'x'), 'nosuchwidget:live')).toBeNull();
    });

    /**
     * A pane whose widget keeps PRINTING scrolls its own marker out of the
     * visible region — the browser session's REPL does exactly this. Without
     * the tag alone being enough, such a pane silently stops being a widget
     * the moment it fills the screen, which no symptom would explain.
     *
     * This branch is STRICTER than the marker one, not looser: there, output
     * chooses among registered widgets (constrained to the tagged name); here
     * output chooses nothing at all.
     */
    it('keeps rendering a tagged pane whose marker has scrolled away', () => {
      const scrolled = lines(
        'tmuxy browser [live] — `help` for verbs',
        '> goto example.com',
        'https://example.com/',
        '> title',
        'Example Domain',
      );
      const info = detectWidget(scrolled, 'browser:live');
      expect(info?.widgetName).toBe('browser');
      expect(info?.instance).toBe('live');
      // Every line is content: there is no marker to measure from.
      expect(info?.contentLines).toHaveLength(5);
    });

    /** Still nothing without a tag, marker or no marker. */
    it('renders nothing for an untagged pane however it scrolled', () => {
      expect(detectWidget(lines('whatever', 'output'), null)).toBeNull();
      expect(detectWidget(lines(MARKER), null)).toBeNull();
    });
  });
});
