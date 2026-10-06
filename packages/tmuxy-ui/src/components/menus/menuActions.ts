/**
 * menuActions - Central dispatch for menu item actions
 *
 * Maps action IDs to send() calls on the app machine. An action that is a
 * tmux intent is an op (`MENU_OPS`), which is also what its menu item's
 * keybinding hint is looked up by — the item and its hint cannot disagree.
 */

import { restartApp } from '../../utils/restartApp';
import type { AppMachineEvent } from '../../machines/types';
import { type PaneId, isPlaceholderId } from '../../domain/ids';
import { renameSessionPrompt, renameWindowPrompt, TmuxOp } from '../../domain/commands';

const GITHUB_URL = 'https://github.com/flplima/tmuxy';
const GITHUB_BUG_REPORT_URL = 'https://github.com/flplima/tmuxy/issues/new?template=bug.yml';

type Send = (event: AppMachineEvent) => void;

/**
 * The menu actions that are one op each. Mark/unmark act on the pane the menu
 * was opened for (the caller focuses it first); swap/join take tmux's default
 * source, which is the marked pane whenever one exists.
 */
export const MENU_OPS = {
  'pane-split-below': TmuxOp.Split({ direction: 'horizontal' }),
  'pane-split-right': TmuxOp.Split({ direction: 'vertical' }),
  'pane-next': TmuxOp.CyclePane({ windowId: null }),
  'pane-previous': TmuxOp.LastPane(),
  'pane-swap-prev': TmuxOp.SwapAdjacent({ direction: 'U' }),
  'pane-swap-next': TmuxOp.SwapAdjacent({ direction: 'D' }),
  'pane-mark': TmuxOp.MarkPane({ marked: true }),
  'pane-unmark': TmuxOp.MarkPane({ marked: false }),
  'pane-swap-marked': TmuxOp.SwapMarked(),
  'pane-join-marked': TmuxOp.JoinMarked(),
  'pane-move-new-tab': TmuxOp.BreakPane({ paneId: null }),
  'pane-add-to-group': TmuxOp.GroupAdd({ pane: null }),
  'pane-copy-mode': TmuxOp.EnterCopyMode({ paneId: null }),
  'pane-paste': TmuxOp.PasteBuffer(),
  'pane-clear': TmuxOp.ClearPane(),
  'tab-next': TmuxOp.SelectWindow({ target: 'next' }),
  'tab-previous': TmuxOp.SelectWindow({ target: 'previous' }),
  'tab-last': TmuxOp.LastWindow(),
  'tab-rename': renameWindowPrompt(),
  'tab-close': TmuxOp.KillWindow({ windowId: null }),
  'session-rename': renameSessionPrompt(),
  'session-kill': TmuxOp.KillSession({ name: null }),
  // tmuxy's own config, NOT ~/.tmux.conf — sourcing the user's vanilla tmux
  // config would drag their default-server bindings/options into the
  // isolated tmuxy socket.
  'session-reload-config': TmuxOp.SourceConfig(),
  'view-zoom': TmuxOp.ZoomToggle({ paneId: null }),
  'view-layout-even-horizontal': TmuxOp.SelectLayout({ layout: 'even-horizontal' }),
  'view-layout-even-vertical': TmuxOp.SelectLayout({ layout: 'even-vertical' }),
  'view-layout-main-horizontal': TmuxOp.SelectLayout({ layout: 'main-horizontal' }),
  'view-layout-main-vertical': TmuxOp.SelectLayout({ layout: 'main-vertical' }),
  'view-layout-tiled': TmuxOp.SelectLayout({ layout: 'tiled' }),
} as const satisfies Record<string, TmuxOp>;

export type MenuOpId = keyof typeof MENU_OPS;

const isMenuOp = (actionId: string): actionId is MenuOpId => actionId in MENU_OPS;

/**
 * Resolve the pane a menu "Close Pane" should target when the menu isn't
 * anchored to a specific pane (the hamburger AppMenu and the Tauri native
 * menu): the focused float, else the real active pane, else undefined so the
 * caller falls back to tmux's server-active pane. Mirrors the focus-target
 * resolution every keyboardActor path uses (`focusedFloatPaneId ??
 * realPaneId(activePaneId)`), so close hits the pane the user sees as active.
 */
export function activeCloseTarget(
  activePaneId: PaneId | null,
  focusedFloatPaneId: PaneId | null,
): PaneId | undefined {
  const realActive = activePaneId && !isPlaceholderId(activePaneId) ? activePaneId : null;
  return focusedFloatPaneId ?? realActive ?? undefined;
}

/**
 * Execute a menu action by ID. `closeTargetPaneId` — when the caller knows the
 * pane a group-aware "Close Pane" should act on — routes pane-close through the
 * group-aware CLOSE_PANE path instead of a raw kill-pane that bypasses group
 * teardown (see activeCloseTarget).
 */
export function executeMenuAction(send: Send, actionId: string, closeTargetPaneId?: PaneId): void {
  if (isMenuOp(actionId)) {
    send({ type: 'DISPATCH_OP', op: MENU_OPS[actionId] });
    return;
  }
  switch (actionId) {
    case 'pane-close':
      // Group members and floats need the group-aware close script: closing a
      // group member has to swap a sibling into view (or tidy the stash window)
      // and degroup the survivor, which a raw kill-pane skips. Route through
      // CLOSE_PANE when we know which pane to close; otherwise fall back to
      // tmux's server-active pane.
      if (closeTargetPaneId) {
        send({ type: 'CLOSE_PANE', paneId: closeTargetPaneId });
      } else {
        send({ type: 'DISPATCH_OP', op: TmuxOp.KillPane({ paneId: null }) });
      }
      break;

    // Tab actions
    case 'tab-new':
      send({ type: 'CREATE_TAB' });
      break;
    case 'tab-overview':
      send({ type: 'TOGGLE_TAB_OVERVIEW' });
      break;
    case 'restart-app':
      restartApp();
      break;

    // Session actions
    case 'session-new': {
      // Create a fresh session AND switch to it so the action has a visible
      // effect — bare `new-session -d` created a detached session with no UI
      // feedback ("did nothing visible"). Mirrors the session picker's "new"
      // path: create, then switch. On web the switch reconnects with
      // ?session=<name> and the server's attach creates the session if the
      // create command hasn't landed yet; on Tauri the create must precede
      // switch-client, and XState delivers both events to the tmux actor in
      // order. The name mirrors the picker's `tmuxy_<n>` convention.
      const newSession = `tmuxy_${Date.now()}`;
      send({ type: 'DISPATCH_OP', op: TmuxOp.NewSession({ name: newSession }) });
      send({ type: 'SWITCH_SESSION', sessionName: newSession });
      break;
    }
    case 'session-detach':
      // Goes through DETACH_CLIENT, not a raw `detach-client`: the backend has
      // to know the detach was deliberate or its monitor treats the ended
      // connection as a flap and reattaches, dropping the user straight back
      // into the session they just left.
      send({ type: 'DETACH_CLIENT' });
      break;

    // Help actions
    case 'help-github':
      window.open(GITHUB_URL, '_blank');
      break;
    case 'help-report-bug':
      window.open(GITHUB_BUG_REPORT_URL, '_blank');
      break;
  }
}
