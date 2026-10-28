import type { PaneId } from '../domain/ids';
/**
 * mobileKeyboard - Manages the hidden text input used by desktop IMEs and touch keyboards.
 *
 * Ownership:
 *  - keyboardActor calls setupMobileKeyboard() at startup to register a handler for
 *    typed characters (input events). It also calls getMobileInput() to identify
 *    the element in keydown so it can skip printable chars already handled here.
 *  - usePaneTouch calls focusMobileInput(paneId) on tap so an open keyboard follows
 *    the pane; the key row's ⌨ key calls toggleMobileKeyboard() to show or hide it.
 *
 * Key event routing:
 *  - Special keys (Backspace, Enter, arrows, Escape) fire reliable keydown events
 *    that bubble to window and are handled by keyboardActor's existing keydown listener.
 *  - Printable characters and finalized IME compositions arrive through `input` or
 *    `compositionend` events and are forwarded through the registered callback.
 *  - keyboardActor skips printable keydowns from this input so text is sent once.
 */

let input: HTMLInputElement | null = null;
let activePaneId: PaneId | null = null;
let onText: ((text: string, paneId: PaneId | null) => void) | null = null;
let handlerOwner: symbol | null = null;
let isComposing = false;
let compositionPaneId: PaneId | null = null;
let suppressCommittedText: string | null = null;
let clearSuppressionTimer: number | null = null;
let keyboardTarget = '';

function ensureInput(): HTMLInputElement {
  if (!input) {
    input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('inputmode', 'text');
    // Focused by the app, never by Tab: the page's tab order is the chrome's.
    input.tabIndex = -1;
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.dataset.keyboardTarget = keyboardTarget;
    Object.assign(input.style, {
      position: 'fixed',
      opacity: '0',
      pointerEvents: 'none',
      width: '1px',
      height: '1px',
      top: '-100px',
      left: '-100px',
    });

    input.addEventListener('compositionstart', () => {
      isComposing = true;
      compositionPaneId = activePaneId;
      suppressCommittedText = null;
      if (clearSuppressionTimer !== null) {
        window.clearTimeout(clearSuppressionTimer);
        clearSuppressionTimer = null;
      }
    });

    input.addEventListener('compositionend', (event) => {
      isComposing = false;
      const targetPaneId = compositionPaneId ?? activePaneId;
      compositionPaneId = null;
      if (event.data && onText) {
        onText(event.data, targetPaneId);
        suppressCommittedText = event.data;
        clearSuppressionTimer = window.setTimeout(() => {
          suppressCommittedText = null;
          clearSuppressionTimer = null;
        }, 0);
      }
      if (input) input.value = '';
    });

    input.addEventListener('input', (event) => {
      const inputEvent = event as InputEvent;
      if (inputEvent.isComposing || isComposing) return;

      if (inputEvent.inputType === 'insertText' && inputEvent.data && onText) {
        if (inputEvent.data === suppressCommittedText) {
          suppressCommittedText = null;
          if (clearSuppressionTimer !== null) {
            window.clearTimeout(clearSuppressionTimer);
            clearSuppressionTimer = null;
          }
        } else {
          onText(inputEvent.data, activePaneId);
        }
      }
      if (input) input.value = '';
    });

    document.body.appendChild(input);
  }
  return input;
}

export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/** Called by keyboardActor at startup to register the character-forwarding handler. */
export function setupMobileKeyboard(
  handler: (text: string, paneId: PaneId | null) => void,
): () => void {
  const owner = Symbol();
  handlerOwner = owner;
  onText = handler;
  ensureInput();
  return () => {
    if (handlerOwner !== owner) return;
    handlerOwner = null;
    onText = null;
    activePaneId = null;
    isComposing = false;
    compositionPaneId = null;
    suppressCommittedText = null;
    if (clearSuppressionTimer !== null) {
      window.clearTimeout(clearSuppressionTimer);
      clearSuppressionTimer = null;
    }
    if (input) {
      input.value = '';
      input.blur();
    }
  };
}

/** Returns the hidden input element so keyboardActor can identify it via event.target. */
export function getMobileInput(): HTMLInputElement | null {
  return input;
}

/** Updates the pane target without changing DOM focus. */
export function setKeyboardInputTarget(paneId: PaneId | null): void {
  activePaneId = paneId;
}

/**
 * Say where the keyboard actor sends keys now — a pane id, or `left-sidebar`
 * when the tree holds the keyboard — as `data-keyboard-target` on this input.
 * The actor learns of a focus change by message, after the app's context has
 * it; a test that waits on this attribute knows the next key goes where it
 * means, rather than sleeping and hoping.
 */
export function markKeyboardTarget(target: string): void {
  keyboardTarget = target;
  if (input) input.dataset.keyboardTarget = target;
}

function focusInput(paneId: PaneId): void {
  setKeyboardInputTarget(paneId);
  const inp = ensureInput();
  if (document.activeElement !== inp) {
    inp.value = '';
    inp.focus({ preventScroll: true });
  }
}

/** Moves mouse or keyboard input to the hidden editable element. */
export function focusKeyboardInput(paneId: PaneId): void {
  focusInput(paneId);
}

/** Whether the phone's keyboard is up: the hidden input has the focus. */
export function isMobileKeyboardOpen(): boolean {
  return input !== null && document.activeElement === input;
}

/**
 * The key row's ⌨ key: put the keyboard away if it is up, bring it up for
 * `paneId` otherwise. A tap on a pane never does this (it only focuses the
 * pane); the key is the one way to toggle the keyboard on a phone.
 */
export function toggleMobileKeyboard(paneId: PaneId | null): void {
  if (!isTouchDevice()) return;
  const inp = ensureInput();
  if (document.activeElement === inp) {
    inp.blur();
    activePaneId = null;
  } else if (paneId) {
    focusInput(paneId);
  }
}

/**
 * Called by usePaneTouch on a tap: the keyboard, if it is up, follows the
 * pane; if it is down it stays down.
 */
export function focusMobileInput(paneId: PaneId): void {
  if (!isTouchDevice()) return;
  if (isMobileKeyboardOpen()) focusInput(paneId);
}
