/**
 * IME composition, clipboard paste/copy, and hidden-input focus restoration
 * listeners for keyboardActor.
 */

import type { AnyActorRef } from 'xstate';
import {
  focusKeyboardInput,
  getMobileInput,
  isTouchDevice,
  setKeyboardInputTarget,
  setupMobileKeyboard,
} from '../../../utils/mobileKeyboard';
import { flashCopiedRange } from '../../../utils/copyFlash';
import { terminalTextOf } from '../../../utils/nativeSelection';
import { getLatches, pressKey } from '../../../utils/keyLatch';
import { noteFocus, PANE_SURFACE } from '../../../utils/chromeTab';
import { isModelPaneId, type PaneId } from '../../../domain/ids';
import { TmuxOp } from '../../../domain/commands';
import { isRealFormControl, realPaneId } from './keyFormatting';

export interface ImeClipboardDeps {
  parent: AnyActorRef;
  isEnabled: () => boolean;
  isLeftSidebarFocused: () => boolean;
  getSessionName: () => string;
  getActivePaneId: () => PaneId | null;
  getOverlayPaneId: () => PaneId | null;
  getKeyTarget: () => string;
}

export function setupImeClipboardAndFocusListeners(deps: ImeClipboardDeps) {
  let isComposing = false;
  let compositionTarget: string | null = null;
  let keyboardFocusEstablished = false;
  let pendingCopyText: string | null = null;

  const syncKeyboardInputTarget = () => {
    const currentPane = deps.getOverlayPaneId() ?? deps.getActivePaneId();
    setKeyboardInputTarget(currentPane);
    if (document.activeElement === getMobileInput()) {
      keyboardFocusEstablished = true;
      return;
    }
    const target = realPaneId(currentPane);
    if (
      !isTouchDevice() &&
      !keyboardFocusEstablished &&
      target !== null &&
      document.activeElement === document.body
    ) {
      focusKeyboardInput(target);
      keyboardFocusEstablished = true;
    }
  };

  const cleanupKeyboardInput = setupMobileKeyboard((text, paneId) => {
    if (!deps.isEnabled() || deps.isLeftSidebarFocused()) return;
    if (getLatches().ctrl !== 'off' || getLatches().alt !== 'off') {
      const [first, ...rest] = [...text];
      if (first) pressKey(first);
      text = rest.join('');
      if (!text) return;
    }
    const textTarget =
      paneId === null ? deps.getKeyTarget() : (realPaneId(paneId) ?? deps.getSessionName());
    deps.parent.send({ type: 'DISPATCH_OP', op: TmuxOp.SendText({ target: textTarget, text }) });
  });

  const handleCompositionStart = (event: CompositionEvent) => {
    if (isRealFormControl(event.target)) {
      isComposing = false;
      compositionTarget = null;
      return;
    }
    isComposing = true;
    compositionTarget = deps.getKeyTarget();
  };

  const handleCompositionEnd = (event: CompositionEvent) => {
    isComposing = false;
    if (isRealFormControl(event.target)) {
      compositionTarget = null;
      return;
    }
    const target = compositionTarget ?? deps.getKeyTarget();
    compositionTarget = null;
    if (!deps.isEnabled()) return;
    if (event.target === getMobileInput()) return;

    const composedText = event.data;
    if (!composedText) return;
    deps.parent.send({
      type: 'DISPATCH_OP',
      op: TmuxOp.SendText({ target, text: composedText }),
    });
  };

  const handlePaste = (event: ClipboardEvent) => {
    if (!deps.isEnabled()) return;
    if (isRealFormControl(event.target)) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;

    deps.parent.send({
      type: 'DISPATCH_OP',
      op: TmuxOp.PasteText({ target: deps.getKeyTarget(), text }),
    });
  };

  const handleCopy = (event: ClipboardEvent) => {
    if (pendingCopyText) {
      event.preventDefault();
      event.clipboardData?.setData('text/plain', pendingCopyText);
      pendingCopyText = null;
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const text = terminalTextOf(range);
    if (text === null) return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', text);
    flashCopiedRange(range);
  };

  const hasSelection = (): boolean => {
    const selection = window.getSelection();
    return !!selection && !selection.isCollapsed && selection.toString().length > 0;
  };

  const restoreKeyboardFocus = (byPointer: boolean) => {
    if (isTouchDevice() || hasSelection()) return;
    const active = document.activeElement as HTMLElement | null;
    if (byPointer && active?.matches?.('[role="tab"], [role="tablist"]')) {
      const paneId = realPaneId(deps.getActivePaneId());
      if (paneId === null) return;
      focusKeyboardInput(paneId);
      keyboardFocusEstablished = true;
      return;
    }
    const pane = active?.closest?.(
      byPointer ? '[data-pane-id][tabindex]' : PANE_SURFACE,
    ) as HTMLElement | null;
    if (!pane || pane !== active) return;
    const paneId = realPaneId(isModelPaneId(pane.dataset.paneId) ? pane.dataset.paneId : null);
    if (paneId === null) return;
    focusKeyboardInput(paneId);
    keyboardFocusEstablished = true;
  };

  let primaryPointerDown = false;
  const handlePointerDown = (event: PointerEvent) => {
    if (event.button === 0) primaryPointerDown = true;
  };
  const handlePointerCancel = () => {
    primaryPointerDown = false;
  };
  const handleFocusIn = (event: FocusEvent) => {
    noteFocus(event.target, primaryPointerDown);
    if (!primaryPointerDown) restoreKeyboardFocus(false);
  };
  const handlePointerUp = () => {
    primaryPointerDown = false;
    restoreKeyboardFocus(true);
  };

  window.addEventListener('pointerdown', handlePointerDown, true);
  window.addEventListener('pointercancel', handlePointerCancel);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('focusin', handleFocusIn);
  window.addEventListener('compositionstart', handleCompositionStart);
  window.addEventListener('compositionend', handleCompositionEnd);
  window.addEventListener('paste', handlePaste);
  window.addEventListener('copy', handleCopy);

  const cleanup = () => {
    cleanupKeyboardInput();
    window.removeEventListener('focusin', handleFocusIn);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointerdown', handlePointerDown, true);
    window.removeEventListener('pointercancel', handlePointerCancel);
    window.removeEventListener('compositionstart', handleCompositionStart);
    window.removeEventListener('compositionend', handleCompositionEnd);
    window.removeEventListener('paste', handlePaste);
    window.removeEventListener('copy', handleCopy);
  };

  return {
    isComposing: () => isComposing,
    setPendingCopyText: (text: string) => {
      pendingCopyText = text;
    },
    syncKeyboardInputTarget,
    cleanup,
  };
}
