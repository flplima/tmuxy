/**
 * A sidebar's chrome window is created by one atomic tmux command list. The
 * list must not depend on the client's copy of the window INDICES: those go
 * stale for a beat after a window closes (`renumber-windows` shifts the rest),
 * and a guessed index tmux already used made `break-pane` fail after
 * `split-window` had run — an orphan pane in the tab, a column stuck on
 * "starting…". Sidebars are therefore targeted by their fixed, unique name.
 */
import { describe, expect, it } from 'vitest';
import { breakOutTaggedWindow, SIDEBAR_WINDOW_NAME } from '../groupsAndFloats';
import type { TmuxWindow } from '../../../types';

const tab = (id: string, index: number): TmuxWindow => ({
  id,
  index,
  name: 'felipe',
  active: index === 1,
  windowType: 'tab',
  floatParent: null,
  floatWidth: null,
  floatHeight: null,
  floatDrawer: null,
  floatBg: null,
  floatNoheader: false,
  sidebarCols: null,
  sidebarHidden: false,
  zoomed: false,
});

describe('breakOutTaggedWindow', () => {
  it('targets a sidebar by its fixed name, never by a guessed index', () => {
    // Stale indices on purpose: the client still thinks 3 is used and 2 is free
    // when tmux has already renumbered. A name target does not care.
    const windows = [tab('@0', 1), tab('@9', 3), tab('@16', 6)];
    const cmd = breakOutTaggedWindow(windows, {
      command: "'tmuxy widget tree'",
      name: SIDEBAR_WINDOW_NAME.left,
      windowType: 'sidebar-left',
    });
    expect(cmd).toBe(
      [
        "split-window 'tmuxy widget tree'",
        'break-pane -d -n __sidebar-left',
        'set-option -w -t :__sidebar-left @tmuxy-window-type sidebar-left',
      ].join(' \\; '),
    );
    expect(cmd).not.toMatch(/-t :\d/);
  });

  it('starts the dock with the default shell when no command is given', () => {
    const cmd = breakOutTaggedWindow([tab('@0', 1)], {
      name: SIDEBAR_WINDOW_NAME.right,
      windowType: 'sidebar-right',
    });
    expect(cmd.startsWith('split-window \\; break-pane -d -n __sidebar-right')).toBe(true);
  });

  it('splits the pane the user is in, so the column is not born in another tab', () => {
    // Nothing in this list switches windows first, so an untargeted split runs
    // wherever tmux's current pane happens to be — which is how the tree came
    // up as a bare pane in the first tab.
    const cmd = breakOutTaggedWindow([tab('@0', 1), tab('@9', 3)], {
      command: "'tmuxy widget tree'",
      name: SIDEBAR_WINDOW_NAME.left,
      windowType: 'sidebar-left',
      splitFrom: '%31',
    });
    expect(cmd.startsWith("split-window -t %31 'tmuxy widget tree'")).toBe(true);
    // The break must stay bare: its -t is a destination, not a target.
    expect(cmd).toContain('break-pane -d -n __sidebar-left');
    expect(cmd).not.toContain('break-pane -t');
  });

  it('falls back to the current pane when the id is a client-side placeholder', () => {
    // tmux has never heard of a placeholder, so naming one would fail the split.
    const cmd = breakOutTaggedWindow([tab('@0', 1)], {
      command: "'tmuxy widget tree'",
      name: SIDEBAR_WINDOW_NAME.left,
      windowType: 'sidebar-left',
      splitFrom: '__placeholder_pane_1',
    });
    expect(cmd.startsWith("split-window 'tmuxy widget tree'")).toBe(true);
  });

  it('still names a free index up front for a float, which has no fixed name', () => {
    const windows = [tab('@0', 1), tab('@2', 2), tab('@9', 4)];
    const cmd = breakOutTaggedWindow(windows, {
      command: '"tmuxy session switch --float"',
      name: 'session',
      windowType: 'float',
    });
    expect(cmd).toContain('break-pane -d -n session -t :3');
    expect(cmd).toContain('set-option -w -t :3 @tmuxy-window-type float');
  });
});
