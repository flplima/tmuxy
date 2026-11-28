import { describe, it, expect } from 'vitest';
import { paneWidgetOf } from '../registry';
import { pid } from '../../../test/wire';
import type { PaneContent } from '../../../domain/wireCells';
// The widgets panes draw, registered as App.tsx registers them.
import '../builtins';

// What is under test is the authorisation, not the widgets: `preview` and
// `tree` are the two this build draws.

const lines = (...rows: string[]): PaneContent => rows.map((row) => [...row].map((c) => ({ c })));

let paneNumber = 0;
/**
 * What a pane with this screen and this `@tmuxy-pane-widget` tag shows (a fresh
 * pane each time).
 */
const detectWidget = (content: PaneContent, paneWidget: string | null | undefined) => {
  const widget = paneWidgetOf({
    tmuxId: pid(`%${paneNumber++}`),
    content,
    paneWidget,
    height: content.length,
  });
  return widget && { widgetName: widget.name, contentLines: widget.lines };
};

const MARKER = '__TMUXY_WIDGET__:preview';

/**
 * The marker travels in pane OUTPUT — `cat` of a crafted file, a
 * commit message in `git log`, `curl` output, an ssh MOTD. Without an
 * out-of-band authorisation, any of those could replace the pane with app UI
 * the user never asked for, drawn where the terminal should be.
 */
describe('paneWidgetOf', () => {
  it('renders the widget a pane was actually tagged for', () => {
    const info = detectWidget(lines(MARKER, 'payload'), 'preview');
    expect(info?.widgetName).toBe('preview');
    expect(info?.contentLines).toEqual(['payload']);
  });

  it('ignores a marker in the output of a pane that was never tagged', () => {
    expect(detectWidget(lines(MARKER, 'payload'), null)).toBeNull();
    expect(detectWidget(lines(MARKER, 'payload'), undefined)).toBeNull();
    expect(detectWidget(lines(MARKER, 'payload'), '')).toBeNull();
  });

  it('finds the marker below a shell prompt, as it appears in practice', () => {
    const info = detectWidget(lines('$ tmuxy widget preview', MARKER), 'preview');
    expect(info?.widgetName).toBe('preview');
  });

  /**
   * The marker is ALWAYS required, and that is what keeps a stale tag — a
   * widget killed before its EXIT trap could unset it — from drawing a widget
   * over the live shell that replaced it.
   */
  describe('the tag and the marker must agree', () => {
    it('renders nothing when the marker is absent', () => {
      expect(detectWidget(lines('a live shell', '$ ls'), 'preview')).toBeNull();
    });

    /**
     * A pane tagged for `tree` cats a file naming `preview`. The marker names a
     * real widget and is still refused: a pane must not be turned into another
     * widget by something it prints.
     */
    it('never renders the widget the OUTPUT names, only the tagged one', () => {
      expect(detectWidget(lines(MARKER, 'x'), 'tree')).toBeNull();
      expect(detectWidget(lines(MARKER, 'x'), 'preview')?.widgetName).toBe('preview');
    });

    it('refuses a tag naming a widget that does not exist', () => {
      expect(detectWidget(lines(MARKER, 'x'), 'nosuchwidget')).toBeNull();
    });

    it('renders nothing for an untagged pane however it scrolled', () => {
      expect(detectWidget(lines('whatever', 'output'), null)).toBeNull();
      expect(detectWidget(lines(MARKER), null)).toBeNull();
    });
  });

  /**
   * A pane narrower than the marker gets it wrapped over several rows — the
   * tree in a 20-column sidebar, a narrow `tmuxy open` preview.
   */
  it('finds a marker the terminal wrapped over several rows', () => {
    const info = detectWidget(lines('__TMUXY_WIDGET__:pre', 'view      ', 'payload'), 'preview');
    expect(info).toEqual({ widgetName: 'preview', contentLines: ['payload'] });
  });

  it('does not join a row that ended short of its edge', () => {
    expect(detectWidget(lines('__TMUXY_WIDGET__:pre ', 'view'), 'preview')).toBeNull();
  });

  /** Content that is not captured yet keeps the last answer; a real screen replaces it. */
  it('holds its answer across a pane with no rows captured yet', () => {
    const tmuxId = pid('%900');
    const at = (content: PaneContent, paneWidget: string | null = 'preview') =>
      paneWidgetOf({ tmuxId, content, paneWidget, height: 24 })?.name ?? null;
    expect(at(lines(MARKER, 'x'))).toBe('preview');
    expect(at([])).toBe('preview');
    expect(at(lines('$ '))).toBeNull();
    expect(at(lines(MARKER, 'x'))).toBe('preview');
    expect(at([], null)).toBeNull();
  });

  /**
   * A stacked window's other rows collapse to one line: tmux pushes the
   * marker into the history and the screen holds the cursor's empty row.
   * The pane is still the widget — its tree row and header keep its name and
   * icon, and the widget stays mounted, so expanding it is not a reload.
   */
  it('holds its answer, lines included, while the pane is collapsed to one row', () => {
    const tmuxId = pid('%901');
    const at = (content: PaneContent, height: number, paneWidget: string | null = 'preview') =>
      paneWidgetOf({ tmuxId, content, paneWidget, height });
    const shown = at(lines(MARKER, 'file:a.md', 'rev:1'), 24);
    expect(shown?.name).toBe('preview');
    expect(at(lines(''), 1)).toEqual(shown);
    expect(at(lines(MARKER, 'file:a.md', 'rev:1'), 24)).toEqual(shown);
    // The latch holds only while the tag does: a pane whose widget ended is a
    // terminal, collapsed or not, and a tag set again holds none of the old
    // lines.
    expect(at(lines(''), 1, null)).toBeNull();
    expect(at(lines(''), 1)).toMatchObject({ name: 'preview', lines: [], pending: true });
  });

  /**
   * A page loaded with the stack already collapsed never saw the marker: the
   * tag names the widget for its header and tree row, and its body waits for
   * the marker, which expanding the pane brings back from the history.
   */
  it('names a pane first seen collapsed by its tag, and confirms it by the marker once expanded', () => {
    const tmuxId = pid('%902');
    const at = (content: PaneContent, height: number, paneWidget: string | null = 'preview') =>
      paneWidgetOf({ tmuxId, content, paneWidget, height });
    expect(at(lines(''), 1)).toMatchObject({ name: 'preview', lines: [], pending: true });
    const open = at(lines(MARKER, 'file:a.md', 'rev:1'), 24);
    expect(open?.name).toBe('preview');
    expect(open?.pending).toBeUndefined();
    expect(open?.lines).toEqual(['file:a.md', 'rev:1']);
    // Collapsed again, it is the confirmed widget that is held.
    expect(at(lines(''), 1)).toEqual(open);
  });

  it('draws a stale tag over a shell as the terminal once the pane is open', () => {
    const tmuxId = pid('%903');
    const at = (content: PaneContent, height: number) =>
      paneWidgetOf({ tmuxId, content, paneWidget: 'preview', height });
    expect(at(lines(''), 1)?.pending).toBe(true);
    expect(at(lines('$ ls', 'a.md'), 24)).toBeNull();
    // Collapsed after being seen as a shell, the tag names it again.
    expect(at(lines(''), 1)?.pending).toBe(true);
  });
});
