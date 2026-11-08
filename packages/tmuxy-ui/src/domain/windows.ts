/**
 * What kind of window a window is (`@tmuxy-window-type`), and the questions
 * the client asks of a window list by kind: which tabs the strip shows, where
 * a sidebar column's window is, which tab a `select-window` lands on.
 */

import type { TmuxWindow } from './client';
import type { WindowId } from './ids';

type Kinded = Pick<TmuxWindow, 'windowType' | 'name'>;

/**
 * A tab the strip shows: tab-typed and named. `break-pane` lists the window
 * it makes before its name is set, and that unnamed window would flash in
 * the strip.
 */
export function isStripTab(window: Kinded): boolean {
  return window.windowType === 'tab' && window.name !== '';
}

export function stripTabs<W extends Kinded>(windows: ReadonlyArray<W>): W[] {
  return windows.filter(isStripTab);
}

export function isSidebarWindow(window: Pick<TmuxWindow, 'windowType'>): boolean {
  return window.windowType === 'sidebar-left' || window.windowType === 'sidebar-right';
}

/** The window behind a sidebar column, if it exists yet. */
export function sidebarWindow<W extends Pick<TmuxWindow, 'windowType'>>(
  windows: ReadonlyArray<W>,
  side: 'left' | 'right',
): W | undefined {
  return windows.find((w) => w.windowType === `sidebar-${side}`);
}

/**
 * The strip tab a `select-window` target lands on from `activeWindowId`:
 * next/previous step through the strip and wrap, a number is a tmux index,
 * an id is that window. Null when it names no strip tab or the current one.
 */
export function selectWindowTarget<W extends Kinded & Pick<TmuxWindow, 'id' | 'index'>>(
  target: WindowId | number | 'next' | 'previous',
  windows: ReadonlyArray<W>,
  activeWindowId: WindowId | null,
): W | null {
  if (!activeWindowId) return null;
  const tabs = stripTabs(windows);
  let window: W | undefined;
  if (target === 'next' || target === 'previous') {
    const current = tabs.findIndex((w) => w.id === activeWindowId);
    if (current === -1) return null;
    const step = target === 'next' ? 1 : -1;
    window = tabs[(current + step + tabs.length) % tabs.length];
  } else if (typeof target === 'number') {
    window = tabs.find((w) => w.index === target);
  } else {
    window = tabs.find((w) => w.id === target);
  }
  return window && window.id !== activeWindowId ? window : null;
}
