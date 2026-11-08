/**
 * Copy on select, as the Claude Code TUI does it: the mouse release that
 * ends a selection over terminal text puts that text on the clipboard at
 * once and says in the snackbar how many characters went — the notice is the
 * sign, the selection does not blink. The selection stays on screen; the next
 * key clears it (keyboardActor) and is processed as typed. A release that leaves the same text selected — a click
 * inside it, a drag that ends where it began — copies nothing twice.
 */

import type { AnyActorRef } from 'xstate';
import {
  focusKeyboardInput,
  getMobileInput,
  touchIsPrimary,
  setKeyboardInputTarget,
  setupMobileKeyboard,
} from '../../../infra/dom/mobileKeyboard';
import { flashCopiedRange } from '../../../infra/dom/copyFlash';
import { terminalSelection, terminalTextOf } from '../../../infra/dom/nativeSelection';
import { getLatches, pressKey } from '../../../infra/dom/keyLatch';
import { noteFocus } from '../../../infra/dom/chromeTab';
import { PANE_SURFACE } from '../../../infra/dom/terminalDom';
import { writeClipboard } from '../../../infra/clipboard';
import { isModelPaneId, realId, type PaneId } from '../../../domain/ids';
import { TmuxOp } from '../../../domain/commands';
import { withoutControls } from '../../../domain/commandHelpers';
import { isRealFormControl } from './keyFormatting';
import type { ContextView } from '../../contextView';
import { overlayPaneId, type KeyContext } from '../../selectors/keyboard';

/** The pane the hidden input types into: the float or dock holding the keyboard, else the active one. */
function inputPaneId(keys: KeyContext): PaneId | null {
  return overlayPaneId(keys.owner) ?? keys.activePaneId;
}

export interface ImeClipboardDeps {
  parent: AnyActorRef;
  keys: ContextView<KeyContext>;
}

export function setupImeClipboardAndFocusListeners(deps: ImeClipboardDeps) {
  let isComposing = false;
  let compositionTarget: string | null = null;
  let keyboardFocusEstablished = false;
  let pendingCopyText: string | null = null;

  const syncKeyboardInputTarget = () => {
    const currentPane = inputPaneId(deps.keys.get());
    setKeyboardInputTarget(currentPane);
    if (document.activeElement === getMobileInput()) {
      keyboardFocusEstablished = true;
      return;
    }
    const target = realId(currentPane);
    if (!touchIsPrimary() && !keyboardFocusEstablished && target !== null && nothingFocused()) {
      focusKeyboardInput(target);
      keyboardFocusEstablished = true;
    }
  };

  /** No element holds the focus: the body, the root, or nothing at all. */
  const nothingFocused = () => {
    const active = document.activeElement;
    return active === null || active === document.body || active === document.documentElement;
  };

  /**
   * The page got the focus with no pane asked for it: a reload, a switch back
   * to the tab, a return to the window. The browser restores whatever element
   * it last had, which may be the body or a chrome control after a re-render
   * dropped the hidden input — and a keystroke from there is typed into
   * nothing. Unless a form control, a frame or the tree holds the focus, the
   * hidden input takes it for the active pane, so typing works at once.
   */
  const reclaimKeyboard = () => {
    if (touchIsPrimary() || primaryPointerDown || hasSelection()) return;
    if (deps.keys.get().owner.kind === 'left') return;
    const active = document.activeElement as HTMLElement | null;
    if (active === getMobileInput()) return;
    if (isRealFormControl(active) || active?.tagName === 'IFRAME') return;
    const paneId = realId(inputPaneId(deps.keys.get()));
    if (paneId === null) return;
    focusKeyboardInput(paneId);
    keyboardFocusEstablished = true;
  };
  const handleVisible = () => {
    if (document.visibilityState === 'visible') reclaimKeyboard();
  };

  const cleanupKeyboardInput = setupMobileKeyboard((text, paneId) => {
    if (!deps.keys.get().enabled || deps.keys.get().owner.kind === 'left') return;
    if (getLatches().ctrl !== 'off' || getLatches().alt !== 'off') {
      const [first, ...rest] = [...text];
      if (first) pressKey(first);
      text = rest.join('');
      if (!text) return;
    }
    const textTarget =
      paneId === null ? deps.keys.get().target : (realId(paneId) ?? deps.keys.get().sessionName);
    deps.parent.send({ type: 'DISPATCH_OP', op: TmuxOp.SendText({ target: textTarget, text }) });
  });

  const handleCompositionStart = (event: CompositionEvent) => {
    if (isRealFormControl(event.target)) {
      isComposing = false;
      compositionTarget = null;
      return;
    }
    isComposing = true;
    compositionTarget = deps.keys.get().target;
  };

  const handleCompositionEnd = (event: CompositionEvent) => {
    isComposing = false;
    if (isRealFormControl(event.target)) {
      compositionTarget = null;
      return;
    }
    const target = compositionTarget ?? deps.keys.get().target;
    compositionTarget = null;
    if (!deps.keys.get().enabled) return;
    if (event.target === getMobileInput()) return;

    const composedText = event.data;
    if (!composedText) return;
    deps.parent.send({
      type: 'DISPATCH_OP',
      op: TmuxOp.SendText({ target, text: composedText }),
    });
  };

  const handlePaste = (event: ClipboardEvent) => {
    if (!deps.keys.get().enabled) return;
    if (isRealFormControl(event.target)) return;
    event.preventDefault();
    // Filtered here as well as in the command: a clipboard of nothing but
    // controls is no paste at all, rather than an empty command.
    const text = withoutControls(event.clipboardData?.getData('text/plain') ?? '');
    if (!text) return;

    deps.parent.send({
      type: 'DISPATCH_OP',
      op: TmuxOp.PasteText({ target: deps.keys.get().target, text }),
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

  // What the last release copied, so the same selection is not copied again
  // until it has gone and come back.
  let copiedOnSelect: string | null = null;
  const copyOnSelect = () => {
    if (!deps.keys.get().enabled || touchIsPrimary()) return;
    const selected = terminalSelection();
    if (!selected) {
      copiedOnSelect = null;
      return;
    }
    if (selected.text === copiedOnSelect) return;
    copiedOnSelect = selected.text;
    pendingCopyText = selected.text;
    const wrote = document.execCommand('copy');
    if (!wrote) {
      pendingCopyText = null;
      void writeClipboard(selected.text, null);
    }
    const count = [...selected.text].length;
    deps.parent.send({
      type: 'NOTIFY',
      kind: 'info',
      text: `Copied ${count} character${count === 1 ? '' : 's'}`,
    });
  };
  const handleMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) return;
    copyOnSelect();
  };
  // The selection going — a key cleared it, a click collapsed it — frees the
  // same text to be copied again when it is selected again.
  const handleSelectionChange = () => {
    if (copiedOnSelect !== null && !hasSelection()) copiedOnSelect = null;
  };

  const restoreKeyboardFocus = (byPointer: boolean) => {
    if (touchIsPrimary() || hasSelection()) return;
    const active = document.activeElement as HTMLElement | null;
    if (byPointer && active?.matches?.('[role="tab"], [role="tablist"]')) {
      const paneId = realId(deps.keys.get().activePaneId);
      if (paneId === null) return;
      focusKeyboardInput(paneId);
      keyboardFocusEstablished = true;
      return;
    }
    const pane = active?.closest?.(
      byPointer ? '[data-pane-id][tabindex]' : PANE_SURFACE,
    ) as HTMLElement | null;
    if (!pane || pane !== active) return;
    const paneId = realId(isModelPaneId(pane.dataset.paneId) ? pane.dataset.paneId : null);
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
  window.addEventListener('focus', reclaimKeyboard);
  document.addEventListener('visibilitychange', handleVisible);
  window.addEventListener('compositionstart', handleCompositionStart);
  window.addEventListener('compositionend', handleCompositionEnd);
  window.addEventListener('paste', handlePaste);
  window.addEventListener('copy', handleCopy);
  window.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('selectionchange', handleSelectionChange);

  const cleanup = () => {
    cleanupKeyboardInput();
    window.removeEventListener('focusin', handleFocusIn);
    window.removeEventListener('focus', reclaimKeyboard);
    document.removeEventListener('visibilitychange', handleVisible);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointerdown', handlePointerDown, true);
    window.removeEventListener('pointercancel', handlePointerCancel);
    window.removeEventListener('compositionstart', handleCompositionStart);
    window.removeEventListener('compositionend', handleCompositionEnd);
    window.removeEventListener('paste', handlePaste);
    window.removeEventListener('copy', handleCopy);
    window.removeEventListener('mouseup', handleMouseUp);
    document.removeEventListener('selectionchange', handleSelectionChange);
  };

  return {
    isComposing: () => isComposing,
    setPendingCopyText: (text: string) => {
      pendingCopyText = text;
    },
    /** A key cleared the selection: the same text copies again when selected again. */
    noteSelectionCleared: () => {
      copiedOnSelect = null;
    },
    syncKeyboardInputTarget,
    cleanup,
  };
}
