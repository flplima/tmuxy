/**
 * mobileKeyboard - Manages a hidden input that summons the virtual keyboard on touch devices.
 *
 * Ownership:
 *  - keyboardActor calls setupMobileKeyboard() at startup to register a handler for
 *    typed characters (input events). It also calls getMobileInput() to identify
 *    the element in keydown so it can skip printable chars already handled here.
 *  - usePaneTouch calls focusMobileInput(paneId) on tap to show/toggle the keyboard.
 *
 * Key event routing:
 *  - Special keys (Backspace, Enter, arrows, Escape) fire reliable keydown events
 *    that bubble to window and are handled by keyboardActor's existing keydown listener.
 *  - Printable characters on mobile often only fire an `input` event (no reliable keydown).
 *    The `input` event handler here forwards them via the registered onText callback.
 *  - To avoid double-sending on browsers that fire both keydown AND input for a char,
 *    keyboardActor skips printable keydown events whose target is this input element.
 */

let input: HTMLInputElement | null = null;
let activePaneId: string | null = null;
let onText: ((text: string) => void) | null = null;

function ensureInput(): HTMLInputElement {
  if (!input) {
    input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('inputmode', 'text');
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    Object.assign(input.style, {
      position: 'fixed',
      opacity: '0',
      pointerEvents: 'none',
      width: '1px',
      height: '1px',
      top: '-100px',
      left: '-100px',
    });

    input.addEventListener('input', (e) => {
      const ev = e as InputEvent;
      // Only forward inserted text — special keys (Backspace, Enter) are handled
      // by keyboardActor's window keydown listener. Skip during IME composition.
      if (ev.inputType === 'insertText' && ev.data && !ev.isComposing && onText) {
        onText(ev.data);
      }
      // Always clear so the next keystroke starts from an empty field
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
export function setupMobileKeyboard(handler: (text: string) => void): () => void {
  onText = handler;
  ensureInput();
  return () => {
    onText = null;
  };
}

/** Returns the hidden input element so keyboardActor can identify it via event.target. */
export function getMobileInput(): HTMLInputElement | null {
  return input;
}

/**
 * Called by usePaneTouch on tap.
 * - Same pane tapped again → dismiss keyboard (blur)
 * - Different pane tapped → keep keyboard open and update active pane
 */
export function focusMobileInput(paneId: string): void {
  if (!isTouchDevice()) return;

  const inp = ensureInput();
  const isOpen = document.activeElement === inp;

  if (isOpen && activePaneId === paneId) {
    inp.blur();
    activePaneId = null;
  } else {
    activePaneId = paneId;
    inp.value = '';
    inp.focus();
  }
}
