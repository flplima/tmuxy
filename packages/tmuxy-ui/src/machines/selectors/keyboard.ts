/**
 * Who holds the keyboard, and what a key typed now acts on: the one place the
 * key target is worked out, for the machine and for the keyboard actor alike.
 */

import type { AppMachineContext } from '../types/context';
import type { KeyboardOwner } from '../types/domain';
import type { CopyModeState } from '../../domain/copyMode';
import type { KeyBindings } from '../../domain/wire';
import { realId, type PaneId } from '../../domain/ids';
import { pinPrefix } from '../../domain/commands';
import { paneAskFor, paneSendFor, type PaneAsk } from '../../domain/paneAsk';
import { visibleFloats } from './panesAndSidebars';

export const PANES_OWN_KEYBOARD: KeyboardOwner = { kind: 'panes' };

/**
 * The keyboard's owner once the floats on screen are `visible` (bottom-most
 * first). With `claim` the topmost takes it (a float came into view, or the
 * user switched to a tab that has one); a float that holds it and left the
 * screen hands it to the topmost one left, or back to the panes.
 */
export function ownerAfterFloats(
  owner: KeyboardOwner,
  visible: readonly PaneId[],
  claim: boolean,
): KeyboardOwner {
  const top = visible.length > 0 ? visible[visible.length - 1] : null;
  if (claim && top) return owner.kind === 'float' && owner.paneId === top ? owner : float(top);
  if (owner.kind === 'float' && !visible.includes(owner.paneId)) {
    return top ? float(top) : PANES_OWN_KEYBOARD;
  }
  return owner;
}

function float(paneId: PaneId): KeyboardOwner {
  return { kind: 'float', paneId };
}

/** The pane a float or the dock holds the keyboard for, or null (the panes, the tree). */
export function overlayPaneId(owner: KeyboardOwner): PaneId | null {
  return owner.kind === 'float' || owner.kind === 'right' ? owner.paneId : null;
}

/** The keyboard is somewhere other than the tiled panes. */
export function selectKeyboardElsewhere(context: AppMachineContext): boolean {
  return context.keyboardOwner.kind !== 'panes';
}

/** Whether `side`'s column holds the keyboard. */
export function selectSidebarHoldsKeyboard(
  context: AppMachineContext,
  side: 'left' | 'right',
): boolean {
  return context.keyboardOwner.kind === side;
}

/**
 * Whether `paneId` is the pane keys go to: the float or dock that holds the
 * keyboard, or, while the panes hold it, the active pane of the tab in front.
 * The one answer for every surface that takes keys of its own (a widget, a
 * preview), so none takes them while a float, the dock or the tree has them.
 */
export function selectPaneHoldsKeyboard(context: AppMachineContext, paneId: PaneId): boolean {
  const owner = context.keyboardOwner;
  if (owner.kind !== 'panes') return owner.kind !== 'left' && owner.paneId === paneId;
  const pane = context.panes.find((p) => p.tmuxId === paneId);
  return pane?.active === true && pane.windowId === context.activeWindowId;
}

/** The float holding the keyboard, if one does. */
export function selectFocusedFloat(context: AppMachineContext): PaneId | null {
  return context.keyboardOwner.kind === 'float' ? context.keyboardOwner.paneId : null;
}

/**
 * The pane keys are typed into: the float or dock that holds the keyboard,
 * else the active pane — or the session, while that pane is a placeholder
 * tmux has not named yet.
 */
export function selectKeyTarget(context: AppMachineContext): string {
  return (
    realId(overlayPaneId(context.keyboardOwner) ?? context.activePaneId) ?? context.sessionName
  );
}

/**
 * The panes the user can see in the active tab: its own, plus the floats drawn
 * over it (a float lives in a window of its own, so a window test alone would
 * miss one the user is looking straight at).
 */
export function selectOnScreenPaneIds(context: AppMachineContext): Set<PaneId> {
  const ids = new Set(
    visibleFloats(context.floatPanes, context.windows, context.activeWindowId).map((f) => f.paneId),
  );
  for (const pane of context.panes) {
    if (pane.windowId === context.activeWindowId) ids.add(pane.tmuxId);
  }
  return ids;
}

/** The panes on screen with a `tmuxy pane send` waiting for an answer. */
export function selectVisibleSendAsks(context: AppMachineContext): PaneId[] {
  const onScreen = selectOnScreenPaneIds(context);
  return context.panes
    .filter((pane) => onScreen.has(pane.tmuxId) && paneSendFor(pane) !== null)
    .map((pane) => pane.tmuxId);
}

/**
 * What a binding runs in: `select-window`/`select-pane` pinned to what the
 * user sees, since tmux's own current window and pane can lag an optimistic
 * switch. A float or the dock pins its own pane; a placeholder window is one
 * tmux has not named yet, so it cannot be a target, and left unpinned the
 * binding runs in tmux's current window, which a just-created window is.
 */
function bindingPin(context: AppMachineContext): string {
  const overlay = overlayPaneId(context.keyboardOwner);
  if (overlay) return pinPrefix(null, realId(overlay));
  let pane = realId(context.activePaneId);
  const liveWindow = realId(context.activeWindowId);
  const windowId = liveWindow ?? context.panes.find((p) => p.tmuxId === pane)?.windowId ?? null;
  if (!windowId) return pinPrefix(null, pane);
  const inWindow = (id: PaneId | null) =>
    id !== null && context.panes.some((p) => p.tmuxId === id && p.windowId === windowId);
  if (!inWindow(pane)) {
    pane = realId(context.panes.find((p) => p.windowId === windowId && p.active)?.tmuxId ?? null);
  }
  return pinPrefix(windowId, pane);
}

/**
 * Everything the keyboard actor needs to classify a key: the machine's view
 * of the keyboard, as one value. The actor never reads the machine's context;
 * it is handed this (machines/contextView.ts).
 */
export interface KeyContext {
  /** The app has the focus: keys are the app's at all. */
  readonly enabled: boolean;
  readonly owner: KeyboardOwner;
  readonly sessionName: string;
  readonly activePaneId: PaneId | null;
  /** Where typed keys go (selectKeyTarget). */
  readonly target: string;
  /** The `select-window`/`select-pane` prefix a binding runs under. */
  readonly bindingPin: string;
  readonly keybindings: KeyBindings | null;
  readonly keysViewOpen: boolean;
  /** The command palette is open: its own field takes the keys. */
  readonly paletteOpen: boolean;
  /** The pane a scroll view, copy mode or a question applies to; null while the tree holds the keyboard. */
  readonly focusPaneId: PaneId | null;
  /** That pane's client-side copy-mode or scroll-view record. */
  readonly copy: CopyModeState | undefined;
  /** That pane's pending question. */
  readonly ask: PaneAsk | null;
  /** Some pane on screen has a send waiting for an answer (Cmd+Enter allows them all). */
  readonly sendPendingOnScreen: boolean;
}

/**
 * The pane a key's copy-mode, scroll-view or question handling applies to:
 * the float or dock holding the keyboard, else the active pane; none while
 * the tree holds it.
 */
export function selectKeyFocusPane(context: AppMachineContext): PaneId | null {
  const owner = context.keyboardOwner;
  return owner.kind === 'left' ? null : (overlayPaneId(owner) ?? context.activePaneId);
}

export function selectKeyContext(context: AppMachineContext): KeyContext {
  const owner = context.keyboardOwner;
  const focusPaneId = selectKeyFocusPane(context);
  return {
    enabled: context.appFocused,
    owner,
    sessionName: context.sessionName,
    activePaneId: context.activePaneId,
    target: selectKeyTarget(context),
    bindingPin: bindingPin(context),
    keybindings: context.keybindings,
    keysViewOpen: context.keysViewOpen,
    paletteOpen: context.palette !== null,
    focusPaneId,
    copy: focusPaneId ? context.copyModeStates[focusPaneId] : undefined,
    ask: focusPaneId ? paneAskFor(context.panes.find((p) => p.tmuxId === focusPaneId)) : null,
    sendPendingOnScreen: selectVisibleSendAsks(context).length > 0,
  };
}

/**
 * The surface the keyboard follows on the page: the hidden input's pane, and
 * the `data-keyboard-target` mark a test can wait on. Two key contexts with
 * the same of these need no re-aim.
 */
export function sameKeyboardSurface(a: KeyContext, b: KeyContext): boolean {
  return (
    a.enabled === b.enabled &&
    a.owner.kind === b.owner.kind &&
    overlayPaneId(a.owner) === overlayPaneId(b.owner) &&
    a.activePaneId === b.activePaneId &&
    a.sessionName === b.sessionName
  );
}
