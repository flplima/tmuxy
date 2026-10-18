/**
 * Snapshot reader and modal / copy-mode / ask-overlay key interception for
 * keyboardActor.
 */

import type { AnyActorRef } from 'xstate';
import type { CopyModeState } from '../../../domain/copyMode';
import type { PaneId, WindowId } from '../../../domain/ids';
import { decodePaneAsk, type AskAnswer } from '../../../utils/paneAsk';
import { extractSelectedText } from '../../../utils/copyMode';
import { focusGuiWindow, newGuiWindow } from '../../../utils/guiWindows';
import { isTauri } from '../../../utils/platform';
import { isModifierOnlyKey, windowShortcut } from './keyFormatting';

/**
 * The slice of a pane this actor reads off the machine snapshot.
 */
export interface LivePane {
  tmuxId: PaneId;
  windowId: WindowId;
  active: boolean;
  paneAsk?: string | null;
}

export interface LiveKeyboardSnapshot {
  liveActivePaneId: PaneId | null;
  liveActiveWindowId: WindowId | null;
  liveCopyStates: Record<PaneId, CopyModeState> | undefined;
  liveAskSelections: Record<PaneId, AskAnswer>;
  livePanes: ReadonlyArray<LivePane>;
  keysViewOpen: boolean;
}

export function readLiveSnapshot(
  parent: AnyActorRef,
  fallbackActivePaneId: PaneId | null,
): LiveKeyboardSnapshot {
  let liveActivePaneId = fallbackActivePaneId;
  let liveActiveWindowId: WindowId | null = null;
  let liveCopyStates: Record<PaneId, CopyModeState> | undefined;
  let liveAskSelections: Record<PaneId, AskAnswer> = {};
  let livePanes: ReadonlyArray<LivePane> = [];
  let keysViewOpen = false;
  try {
    const snapshot = parent.getSnapshot() as {
      context?: {
        activePaneId?: PaneId;
        activeWindowId?: WindowId | null;
        copyModeStates?: Record<PaneId, CopyModeState>;
        askSelections?: Record<PaneId, AskAnswer>;
        panes?: ReadonlyArray<LivePane>;
        keysViewOpen?: boolean;
      };
    };
    const ctx = snapshot?.context;
    if (ctx?.activePaneId !== undefined) liveActivePaneId = ctx.activePaneId;
    if (ctx?.activeWindowId) liveActiveWindowId = ctx.activeWindowId;
    liveCopyStates = ctx?.copyModeStates;
    if (ctx?.panes) livePanes = ctx.panes;
    if (ctx?.askSelections) liveAskSelections = ctx.askSelections;
    keysViewOpen = ctx?.keysViewOpen === true;
  } catch (_) {
    /* keep the cached closure values */
  }
  return {
    liveActivePaneId,
    liveActiveWindowId,
    liveCopyStates,
    liveAskSelections,
    livePanes,
    keysViewOpen,
  };
}

/**
 * Handle font-size shortcuts, Tauri window shortcuts, modal keys view,
 * ask overlays, Cmd+A scrollback select-all, Cmd+C/Ctrl+C copy/SIGINT,
 * scroll-mode auto-exit, and client-side copy-mode keys.
 *
 * Returns `true` when the keydown has been completely handled and must not
 * proceed to prefix/table/root/send-keys dispatch.
 */
export function handleModalOrCopyKeyDown(
  event: KeyboardEvent,
  parent: AnyActorRef,
  state: {
    snap: LiveKeyboardSnapshot;
    overlayPaneId: PaneId | null;
    leftSidebarFocused: boolean;
    prefixActive: boolean;
    setPendingCopyText: (text: string) => void;
  },
): boolean {
  const { snap, overlayPaneId, leftSidebarFocused, prefixActive, setPendingCopyText } = state;

  // Font size shortcuts (CmdOrCtrl + = / + / - / 0)
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (event.key === '=' || event.key === '+') {
      event.preventDefault();
      parent.send({ type: 'INCREASE_FONT_SIZE' });
      return true;
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      parent.send({ type: 'DECREASE_FONT_SIZE' });
      return true;
    }
    if (event.key === '0' && event.metaKey) {
      event.preventDefault();
      parent.send({ type: 'RESET_FONT_SIZE' });
      return true;
    }
  }

  // Desktop app OS windows: Cmd+N and Cmd+1…9 on Mac, Ctrl+Shift+N and Ctrl+Shift+1…9 elsewhere
  if (isTauri() && windowShortcut(event)) {
    const digit = /^Digit([1-9])$/.exec(event.code);
    if (digit) {
      event.preventDefault();
      focusGuiWindow(Number(digit[1]));
      return true;
    }
    if (event.code === 'KeyN') {
      event.preventDefault();
      newGuiWindow();
      return true;
    }
  }

  // Modal keys view (`prefix ?`)
  if (snap.keysViewOpen && !event.ctrlKey && !event.metaKey && !event.altKey && !prefixActive) {
    event.preventDefault();
    if (event.key === 'Escape' || event.key === 'q') {
      parent.send({ type: 'TOGGLE_KEYS_VIEW' });
    }
    return true;
  }

  let activeCopyState: CopyModeState | undefined;
  let scrollbackPane: PaneId | null = null;
  if (!leftSidebarFocused) {
    scrollbackPane = overlayPaneId ?? snap.liveActivePaneId;
    activeCopyState = scrollbackPane ? snap.liveCopyStates?.[scrollbackPane] : undefined;
  }
  const copyModeActive = activeCopyState?.mode === 'copy' && !activeCopyState.copiedAt;
  const scrollModePane = activeCopyState?.mode === 'scroll' ? scrollbackPane : null;

  const askSelection = (paneId: PaneId): AskAnswer => snap.liveAskSelections[paneId] ?? 'yes';

  // Cmd+Enter / Ctrl+Enter: allow every send pending in the active tab
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.altKey) {
    const anyPending = snap.livePanes.some(
      (pane) =>
        pane.windowId === snap.liveActiveWindowId && decodePaneAsk(pane.paneAsk)?.kind === 'send',
    );
    if (anyPending) {
      event.preventDefault();
      parent.send({ type: 'ANSWER_VISIBLE_ASKS', answer: 'yes' });
      return true;
    }
  }

  const askPaneId = leftSidebarFocused ? null : (overlayPaneId ?? snap.liveActivePaneId);
  const pendingAsk = askPaneId
    ? decodePaneAsk(snap.livePanes.find((pane) => pane.tmuxId === askPaneId)?.paneAsk)
    : null;
  const plainKey = !event.ctrlKey && !event.metaKey && !event.altKey;

  if (askPaneId && pendingAsk?.kind === 'offer' && plainKey) {
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      parent.send({
        type: 'ANSWER_ASK',
        paneId: askPaneId,
        answer: event.key === 'Enter' ? 'yes' : 'no',
      });
      return true;
    }
    parent.send({ type: 'ANSWER_ASK', paneId: askPaneId, answer: 'no' });
  }

  if (askPaneId && pendingAsk?.kind === 'send' && plainKey) {
    const move = (to: AskAnswer) => {
      event.preventDefault();
      parent.send({ type: 'MOVE_ASK_SELECTION', paneId: askPaneId, to });
    };
    const answer = (choice: AskAnswer) => {
      event.preventDefault();
      parent.send({ type: 'ANSWER_ASK', paneId: askPaneId, answer: choice });
    };
    switch (event.key) {
      case 'ArrowUp':
      case '1':
        move('yes');
        return true;
      case 'ArrowDown':
      case '2':
        move('no');
        return true;
      case 'Escape':
        answer('no');
        return true;
      case 'Enter':
        answer(askSelection(askPaneId));
        return true;
      default:
        event.preventDefault();
        return true;
    }
  }

  const nativeSelection = () => window.getSelection()?.toString() ?? '';

  // Cmd+A / Ctrl+Shift+A: select whole scrollback
  if (scrollbackPane && windowShortcut(event) && event.code === 'KeyA') {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    parent.send({ type: 'SELECT_ALL_SCROLLBACK', paneId: scrollbackPane });
    return true;
  }

  // Copy scroll-view selection via Cmd+C / Ctrl+Shift+C
  if (
    windowShortcut(event) &&
    event.code === 'KeyC' &&
    !copyModeActive &&
    activeCopyState?.selectionMode &&
    activeCopyState.selectionAnchor
  ) {
    event.preventDefault();
    setPendingCopyText(extractSelectedText(activeCopyState));
    document.execCommand('copy');
    parent.send({ type: 'COPY_SELECTION' });
    return true;
  }

  // Cmd+C / Ctrl+C: copy selection or send SIGINT
  if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
    if (leftSidebarFocused) {
      event.preventDefault();
      return true;
    }
    if (copyModeActive) {
      if (activeCopyState?.selectionMode && activeCopyState?.selectionAnchor) {
        setPendingCopyText(extractSelectedText(activeCopyState));
      }
    } else if (event.metaKey && nativeSelection()) {
      event.preventDefault();
      document.execCommand('copy');
      return true;
    } else {
      event.preventDefault();
    }
    parent.send({ type: 'COPY_SELECTION' });
    return true;
  }

  // Close scroll view on first real keystroke
  if (scrollModePane && !isModifierOnlyKey(event.key)) {
    parent.send({ type: 'EXIT_SCROLL_MODE', paneId: scrollModePane });
    if (event.key === 'Escape') {
      event.preventDefault();
      return true;
    }
  }

  // Client-side copy mode key interception
  if (copyModeActive) {
    event.preventDefault();
    if (event.key === 'y' || event.key === 'Enter') {
      if (activeCopyState?.selectionMode && activeCopyState?.selectionAnchor) {
        setPendingCopyText(extractSelectedText(activeCopyState));
        document.execCommand('copy');
      }
    }
    parent.send({
      type: 'COPY_MODE_KEY',
      key: event.key,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    });
    return true;
  }

  return false;
}
