/**
 * What a test outside the app may read of it (`window.app.view()`): the E2E
 * suites and the stories. Everything else a test checks is on the screen or in
 * tmux, so the machine's context can change shape without breaking one.
 */

import type { AppMachineContext } from './types/context';
import type { CopyModeState } from '../domain/copyMode';
import type { WindowType } from '../domain/wire';
import type { PaneId, WindowId } from '../domain/ids';
import { selectOnScreenPaneIds } from './selectors/keyboard';

export interface AppTestView {
  activeTabId: WindowId | null;
  activePaneId: PaneId | null;
  /** The active tab's panes, and the floats drawn over it. */
  visiblePaneIds: PaneId[];
  /**
   * The prefix key (tmux's spelling, `C-a`) once the server's bindings have
   * arrived; null before, when a key after the prefix would find no binding.
   */
  prefixKey: string | null;
  /** The prefix key was pressed and the next key is looked up in its table. */
  prefixActive: boolean;
  /**
   * Who takes the keys typed: the panes (the active one), a float, the dock
   * (`right`) or the tree (`left`). `paneId` is the float's or the column's.
   */
  keyboardTarget: { kind: 'panes' | 'float' | 'left' | 'right'; paneId: PaneId | null };
  /** The active pane's scrollback: the wheel's scroll view or tmux's copy mode. */
  copyMode: Pick<
    CopyModeState,
    | 'mode'
    | 'cursorRow'
    | 'cursorCol'
    | 'scrollTop'
    | 'totalLines'
    | 'height'
    | 'width'
    | 'selectionMode'
    | 'selectionAnchor'
    | 'loading'
    | 'loadedRanges'
  > | null;
  /** Every window the client holds, and what it is (`@tmuxy-window-type`; null for a foreign one). */
  windows: { id: WindowId; kind: WindowType | null }[];
}

export function selectTestView(context: AppMachineContext): AppTestView {
  const owner = context.keyboardOwner;
  const copy = context.activePaneId ? context.copyModeStates[context.activePaneId] : undefined;
  return {
    activeTabId: context.activeWindowId,
    activePaneId: context.activePaneId,
    visiblePaneIds: [...selectOnScreenPaneIds(context)],
    prefixKey: context.keybindings?.prefix_bindings.length ? context.keybindings.prefix_key : null,
    prefixActive: context.prefixActive,
    keyboardTarget: { kind: owner.kind, paneId: owner.kind === 'panes' ? null : owner.paneId },
    copyMode: copy
      ? {
          mode: copy.mode,
          cursorRow: copy.cursorRow,
          cursorCol: copy.cursorCol,
          scrollTop: copy.scrollTop,
          totalLines: copy.totalLines,
          height: copy.height,
          width: copy.width,
          selectionMode: copy.selectionMode,
          selectionAnchor: copy.selectionAnchor,
          loading: copy.loading,
          loadedRanges: copy.loadedRanges,
        }
      : null,
    windows: context.windows.map((w) => ({ id: w.id, kind: w.windowType })),
  };
}
