import { describe, it, expect } from 'vitest';
import { detectWidget, registerWidget } from '../registry';
import type { PaneContent } from '../../../domain/wire';

// The registry is populated by `widgets/init.ts` at app start; two stand-ins
// are enough here — what is under test is the authorisation, not the widgets.
const stub = { component: () => null };
registerWidget('session', stub);
registerWidget('tree', stub);

const lines = (...rows: string[]): PaneContent => rows.map((row) => [...row].map((c) => ({ c })));

const MARKER = '__TMUXY_WIDGET__:session';

/**
 * SEC-18. The marker travels in pane OUTPUT — `cat` of a crafted file, a
 * commit message in `git log`, `curl` output, an ssh MOTD. Without an
 * out-of-band authorisation, any of those could replace the pane with app UI
 * the user never asked for, drawn where the terminal should be.
 */
describe('detectWidget', () => {
  it('renders the widget a pane was actually tagged for', () => {
    const info = detectWidget(lines(MARKER, 'payload'), 'session');
    expect(info?.widgetName).toBe('session');
    expect(info?.contentLines).toEqual(['payload']);
  });

  it('ignores a marker in the output of a pane that was never tagged', () => {
    expect(detectWidget(lines(MARKER, 'payload'), null)).toBeNull();
    expect(detectWidget(lines(MARKER, 'payload'), undefined)).toBeNull();
    expect(detectWidget(lines(MARKER, 'payload'), '')).toBeNull();
  });

  it('finds the marker below a shell prompt, as it appears in practice', () => {
    const info = detectWidget(lines('$ tmuxy widget session', MARKER), 'session');
    expect(info?.widgetName).toBe('session');
  });

  /**
   * The marker is ALWAYS required, and that is what keeps a stale tag — a
   * widget killed before its EXIT trap could unset it — from drawing a widget
   * over the live shell that replaced it.
   */
  describe('the tag and the marker must agree', () => {
    it('renders nothing when the marker is absent', () => {
      expect(detectWidget(lines('a live shell', '$ ls'), 'session')).toBeNull();
    });

    /**
     * A pane tagged for `tree` cats a file naming `session`. The marker names a
     * real widget and is still refused: a pane must not be turned into another
     * widget by something it prints.
     */
    it('never renders the widget the OUTPUT names, only the tagged one', () => {
      expect(detectWidget(lines(MARKER, 'x'), 'tree')).toBeNull();
      expect(detectWidget(lines(MARKER, 'x'), 'session')?.widgetName).toBe('session');
    });

    it('refuses a tag naming a widget that does not exist', () => {
      expect(detectWidget(lines(MARKER, 'x'), 'nosuchwidget')).toBeNull();
    });

    /** Still nothing without a tag, marker or no marker. */
    it('renders nothing for an untagged pane however it scrolled', () => {
      expect(detectWidget(lines('whatever', 'output'), null)).toBeNull();
      expect(detectWidget(lines(MARKER), null)).toBeNull();
    });
  });
});
