/**
 * What choosing an app menu item does. An app verb's `MENU_COMMANDS` entry holds
 * both what it runs and the binding its key hint names, so the two cannot
 * disagree.
 */

import { restartApp } from '../../../infra/guiWindows';
import type { AppMachineEvent } from '../../../machines/types/events';
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
  | { kind: 'op'; op: TmuxOp }
  | { kind: 'command'; id: MenuCommandId }
  | { kind: 'event'; event: AppMachineEvent }
  | { kind: 'local'; local: MenuLocal };

export type AppMenuNode = MenuNode<AppMenuAction>;
export type AppMenuSpec = MenuSpec<AppMenuAction>;

export const op = (op: TmuxOp): AppMenuAction => ({ kind: 'op', op });
export const command = (id: MenuCommandId): AppMenuAction => ({ kind: 'command', id });
export const event = (event: AppMachineEvent): AppMenuAction => ({ kind: 'event', event });
export const local = (local: MenuLocal): AppMenuAction => ({ kind: 'local', local });

interface MenuCommand {
  run: (send: Send) => void;
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
  'tab-new': { run: sendEvent({ type: 'CREATE_TAB' }), keyOp: TmuxOp.NewWindow() },
  'tab-overview': { run: sendEvent({ type: 'TOGGLE_TAB_OVERVIEW' }), clientKey: 'tab-overview' },
  'view-activity': { run: sendEvent({ type: 'TOGGLE_ACTIVITY' }), clientKey: 'activity' },
  'view-activity-most-urgent': {
    run: sendEvent({ type: 'ACTIVITY_GO_MOST_URGENT' }),
    clientKey: 'activity-most-urgent',
  },
  // The item renames in the strip, where the name is; the binding (`prefix ,`)
  // still opens tmux's prompt, and the hint names the binding.
  'tab-rename': { run: sendEvent({ type: 'RENAME_ACTIVE_TAB' }), keyOp: renameWindowPrompt() },
  // The binding (`prefix p S`) runs the stack script; the hint names it.
  'tab-stack-toggle': {
    run: sendEvent({ type: 'TOGGLE_STACKED_PANES' }),
    keyOp: TmuxOp.RawCommand({ command: script('stack', 'toggle', '#{window_id}') }),
  },
  'restart-app': { run: () => restartApp() },
  'session-new': { run: sendEvent({ type: 'NEW_SESSION' }) },
  // DETACH_CLIENT, not a raw `detach-client`: the backend must know the detach
  // was deliberate, or its monitor treats the ended connection as a flap and
  // reattaches.
  'session-detach': {
    run: sendEvent({ type: 'DETACH_CLIENT' }),
    keyOp: TmuxOp.RawCommand({ command: 'detach-client' }),
  },
} as const satisfies Record<string, MenuCommand>;

export type MenuCommandId = keyof typeof MENU_COMMANDS;

export function executeMenuCommand(send: Send, id: MenuCommandId): void {
  MENU_COMMANDS[id].run(send);
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
