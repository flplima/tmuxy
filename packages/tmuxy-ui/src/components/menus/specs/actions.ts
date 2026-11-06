/**
 * What choosing an app menu item does, as a typed union, and the app's menu
 * commands in one table.
 *
 * An item that is a tmux intent carries its op, which is also what its key
 * hint is looked up by. An item that is one of the app's own verbs names a
 * `MenuCommandId`: its entry in `MENU_COMMANDS` says what it runs and which
 * binding its hint names, side by side, so the item and its hint cannot
 * disagree and a misspelt id does not compile.
 */

import { restartApp } from '../../../infra/guiWindows';
import type { AppMachineEvent } from '../../../machines/types/events';
import { type PaneId, isPlaceholderId } from '../../../domain/ids';
import { renameWindowPrompt, TmuxOp } from '../../../domain/commands';
import type { KeyBindings } from '../../../domain/wire';
import { clientKeyHint, keyHint } from '../../../domain/keyLabels';
import type { ClientKey } from '../../../domain/keyTables';
import { script } from '../../../domain/commandHelpers';
import type { MenuNode, MenuSpec } from '../../../domain/menus/spec';
import type { WindowStyleSlug } from '../../../domain/guiWindows';

type Send = (event: AppMachineEvent) => void;

/** Something the surface showing the menu does itself: a dialog, a field, a native call. */
export type MenuLocal =
  /** Rename the pane or tab the menu is about, in the field the surface owns. */
  | { verb: 'rename' }
  | { verb: 'confirm-kill-session' }
  | { verb: 'copy-app-state' }
  | { verb: 'copy-trace-path' }
  | { verb: 'quit' }
  | { verb: 'window-refresh' }
  | { verb: 'window-new' }
  | { verb: 'window-close' }
  | { verb: 'window-style'; slug: WindowStyleSlug }
  | { verb: 'window-focus'; index: number }
  | { verb: 'copy-selection' }
  | { verb: 'send-selection' }
  /** A plugin's selection action: the selection menu sends the text with it. */
  | { verb: 'plugin-selection'; plugin: string; action: string };

export type AppMenuAction =
  /** A tmux op, dispatched through the store. */
  | { kind: 'op'; op: TmuxOp }
  /** One of the app's own verbs (`MENU_COMMANDS`). */
  | { kind: 'command'; id: MenuCommandId }
  /** An event sent to the app machine as is. */
  | { kind: 'event'; event: AppMachineEvent }
  | { kind: 'local'; local: MenuLocal };

export type AppMenuNode = MenuNode<AppMenuAction>;
export type AppMenuSpec = MenuSpec<AppMenuAction>;

export const op = (op: TmuxOp): AppMenuAction => ({ kind: 'op', op });
export const command = (id: MenuCommandId): AppMenuAction => ({ kind: 'command', id });
export const event = (event: AppMachineEvent): AppMenuAction => ({ kind: 'event', event });
export const local = (local: MenuLocal): AppMenuAction => ({ kind: 'local', local });

interface MenuCommand {
  /** `target`: the pane a group-aware Close Pane acts on (see `activeCloseTarget`). */
  run: (send: Send, target?: PaneId) => void;
  /** What tmux binds the same thing to, for the item's key hint. */
  keyOp?: TmuxOp;
  /** The client's own key for it, when tmux has none. */
  clientKey?: ClientKey;
}

const sendEvent =
  (event: AppMachineEvent): MenuCommand['run'] =>
  (send) =>
    send(event);

export const MENU_COMMANDS = {
  'pane-close': {
    // Group members and floats need the group-aware close script: closing a
    // group member has to swap a sibling into view (or tidy the stash window)
    // and degroup the survivor, which a raw kill-pane skips. Route through
    // CLOSE_PANE when we know which pane to close; otherwise fall back to
    // tmux's server-active pane.
    run: (send, target) =>
      send(
        target
          ? { type: 'CLOSE_PANE', paneId: target }
          : { type: 'DISPATCH_OP', op: TmuxOp.KillPane({ paneId: null }) },
      ),
    keyOp: TmuxOp.KillPane({ paneId: null }),
  },
  'tab-new': { run: sendEvent({ type: 'CREATE_TAB' }), keyOp: TmuxOp.NewWindow() },
  'tab-overview': { run: sendEvent({ type: 'TOGGLE_TAB_OVERVIEW' }), clientKey: 'tab-overview' },
  // The item renames in the strip, where the name is; the binding (`prefix ,`)
  // still opens tmux's prompt, and the hint names the binding.
  'tab-rename': { run: sendEvent({ type: 'RENAME_ACTIVE_TAB' }), keyOp: renameWindowPrompt() },
  // The binding (`prefix p S`) runs the stack script, which reshapes the
  // rows as it flips the tag; the hint names it.
  'tab-stack-toggle': {
    run: sendEvent({ type: 'TOGGLE_STACKED_PANES' }),
    keyOp: TmuxOp.RawCommand({ command: script('stack', 'toggle', '#{window_id}') }),
  },
  'restart-app': { run: () => restartApp() },
  'session-new': { run: sendEvent({ type: 'NEW_SESSION' }) },
  // DETACH_CLIENT, not a raw `detach-client`: the backend has to know the
  // detach was deliberate or its monitor treats the ended connection as a
  // flap and reattaches, dropping the user straight back into the session
  // they just left.
  'session-detach': {
    run: sendEvent({ type: 'DETACH_CLIENT' }),
    keyOp: TmuxOp.RawCommand({ command: 'detach-client' }),
  },
} as const satisfies Record<string, MenuCommand>;

export type MenuCommandId = keyof typeof MENU_COMMANDS;

export function executeMenuCommand(send: Send, id: MenuCommandId, target?: PaneId): void {
  MENU_COMMANDS[id].run(send, target);
}

/** The key hint of a command: the binding its `keyOp` names, else the client's own key. */
export function commandHint(
  keybindings: KeyBindings | null,
  id: MenuCommandId,
): string | undefined {
  const entry: MenuCommand = MENU_COMMANDS[id];
  return (
    (entry.keyOp && keyHint(keybindings, entry.keyOp)) ??
    (entry.clientKey && clientKeyHint(keybindings, entry.clientKey))
  );
}

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
