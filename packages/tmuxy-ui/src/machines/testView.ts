/**
 * What a test may read of the app (`window.app`, set by `AppContext.tsx`).
 *
 * The E2E suites are JavaScript outside the app's types: they read only
 * `view()`, and everything else they check is on the screen or in tmux, so the
 * machine's context can change shape without breaking one. The stories run in
 * the app's own TypeScript and reach the machine through this typed handle
 * (`stories/storyApp.ts`), so a renamed field breaks them at compile time.
 */

import type { AppMachineActor } from './app/appMachine';
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
  /**
   * The plugin actions the menus offer, as `plugin:action`: a selection-only
   * one is in no menu until there is a selection, so the screen cannot say.
   */
  pluginActions: string[];
  /** Every window the client holds, and what it is (`@tmuxy-window-type`; null for a foreign one). */
  windows: { id: WindowId; kind: WindowType | null }[];
}

/** `window.app`: the app's actor, and what a test asks of it. */
export type AppHandle = AppMachineActor & {
  /** Nothing queued, in flight or awaiting tmux's verdict. */
  settled: () => boolean;
  /** tmux has done everything sent so far, and the screen shows it. */
  caughtUp: () => Promise<void>;
  view: () => AppTestView;
};

declare global {
  interface Window {
    app?: AppHandle;
  }
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
    pluginActions: context.plugins.flatMap((p) => p.actions.map((a) => `${p.name}:${a.id}`)),
  };
}
