/**
 * Modal / copy-mode / ask-overlay key classification for keyboardActor: each
 * key becomes the event of the slice it belongs to, which decides what it
 * does. What stays here is what must happen inside the key's own event: the
 * `preventDefault`, and the copy a browser only allows from a user gesture.
 */

import type { AnyActorRef } from 'xstate';
import { extractSelectedText } from '../../../domain/copyMode';
import type { KeyContext } from '../../selectors/keyboard';
import { focusGuiWindow, newGuiWindow } from '../../../infra/guiWindows';
import { isTauri } from '../../../infra/platform';
import { isReplayedPreviewKey } from '../../../infra/dom/replayedKeys';
import { isModifierOnlyKey, windowShortcut } from './keyFormatting';

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
    keys: KeyContext;
    prefixActive: boolean;
    setPendingCopyText: (text: string) => void;
  },
): boolean {
  const { keys, prefixActive, setPendingCopyText } = state;

  const replayed = isReplayedPreviewKey(event);

  // Font size shortcuts (CmdOrCtrl + = / + / - / 0)
  if (!replayed && (event.ctrlKey || event.metaKey) && !event.altKey) {
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

  // Desktop app OS windows: Cmd+N and Cmd+1…9 on Mac, Ctrl+Shift+N and Ctrl+Shift+1…9 elsewhere.
  // Only from the user's real keyboard — never a synthetic or preview-replayed event.
  if (isTauri() && event.isTrusted !== false && !replayed && windowShortcut(event)) {
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
  if (keys.keysViewOpen && !event.ctrlKey && !event.metaKey && !event.altKey && !prefixActive) {
    event.preventDefault();
    if (event.key === 'Escape' || event.key === 'q') {
      parent.send({ type: 'TOGGLE_KEYS_VIEW' });
    }
    return true;
  }

  const activeCopyState = keys.copy;
  const scrollbackPane = keys.focusPaneId;
  const copyModeActive = activeCopyState?.mode === 'copy' && !activeCopyState.copiedAt;
  const scrollModePane = activeCopyState?.mode === 'scroll' ? scrollbackPane : null;

  // Cmd+Enter / Ctrl+Enter: allow every send pending on screen. Only from the
  // user's own keyboard: a chord a script dispatched (a preview page's
  // replayed key, say) is not the user saying yes to every pane.
  if (
    event.isTrusted !== false &&
    (event.metaKey || event.ctrlKey) &&
    event.key === 'Enter' &&
    !event.altKey &&
    keys.sendPendingOnScreen
  ) {
    event.preventDefault();
    parent.send({ type: 'ANSWER_VISIBLE_ASKS', answer: 'yes' });
    return true;
  }

  // A question on the pane holding the keyboard takes its plain keys (the ask
  // slice decides what each means). An offer only claims Enter and Escape: any
  // other key declines it and goes on to the pane as typed.
  const plainKey = !event.ctrlKey && !event.metaKey && !event.altKey;
  if (keys.ask && keys.focusPaneId && plainKey) {
    parent.send({ type: 'ASK_KEY', paneId: keys.focusPaneId, key: event.key });
    if (keys.ask.kind === 'send' || event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      return true;
    }
  }

  const nativeSelection = () => window.getSelection()?.toString() ?? '';

  // Cmd+A / Ctrl+Shift+A: select whole scrollback
  if (!replayed && scrollbackPane && windowShortcut(event) && event.code === 'KeyA') {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    parent.send({ type: 'SELECT_ALL_SCROLLBACK', paneId: scrollbackPane });
    return true;
  }

  // Copy scroll-view selection via Cmd+C / Ctrl+Shift+C
  if (
    !replayed &&
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
    if (keys.owner.kind === 'left') {
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
