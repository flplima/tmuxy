/**
 * ComposeSheet — the whole screen to write in with the phone keyboard's own
 * help: autocorrect, suggestions, autocomplete, its mic. The hidden input the
 * terminal types through turns all of that off, as a terminal must; this is a
 * real textarea, a form control, which the keyboard actor leaves alone.
 *
 * Holding ⌨ on the key row opens it (KeyRow.tsx). Send pastes everything
 * written into the pane at once (`TmuxOp.PasteText`, a bracketed paste where
 * the program asked for one, so a shell takes the lines as one paste and runs
 * none of them by itself) and closes the sheet. Dragging its top bar down,
 * past a quarter of its height or with a flick (`useSheetDrag.ts`), closes it
 * without sending, as do Cancel and Escape; what was written then stays as
 * the draft for the next time, until it is sent.
 *
 * It fills what the phone keyboard leaves of the screen (`--app-top` and
 * `--app-height`, usePhoneViewport.ts), so Send stays in view above it.
 */

import { useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useSheetDrag } from './useSheetDrag';
import './ComposeSheet.css';

// Kept outside the sheet, so a draft outlives the sheet and the key row
// remounting (the phone turned sideways and back).
let draft = '';

interface ComposeSheetProps {
  /** What the pane is called, said in the bar: where Send pastes. */
  paneName: string;
  /** The textarea, for the hold that opened the sheet to focus on release. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSend: (text: string) => void;
  onClose: () => void;
}

export function ComposeSheet({ paneName, inputRef, onSend, onClose }: ComposeSheetProps) {
  const [text, setText] = useState(draft);
  const { sheetRef, pulled, dragging, barHandlers } = useSheetDrag(onClose);

  const write = (value: string) => {
    draft = value;
    setText(value);
  };
  const sendAll = () => {
    if (!text) return;
    onSend(text);
    draft = '';
    onClose();
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendAll();
    }
  };

  return createPortal(
    <div className="compose-sheet-backdrop" data-testid="compose-sheet">
      <div
        ref={sheetRef}
        className={`compose-sheet${dragging ? ' is-dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Write to the pane"
        style={pulled > 0 ? { transform: `translateY(${pulled}px)` } : undefined}
      >
        <div className="compose-sheet-bar" data-testid="compose-sheet-bar" {...barHandlers}>
          <div className="compose-sheet-handle" aria-hidden="true" />
          <div className="compose-sheet-header">
            <button type="button" className="compose-sheet-button" onClick={onClose}>
              Cancel
            </button>
            <span className="compose-sheet-title">To {paneName}</span>
            <button
              type="button"
              className="compose-sheet-button compose-sheet-send"
              disabled={!text}
              onClick={sendAll}
            >
              Send
            </button>
          </div>
        </div>
        <textarea
          ref={inputRef}
          className="compose-sheet-input"
          aria-label="Text to send"
          placeholder="Write here, with your keyboard's corrections and suggestions. Send pastes it all into the pane at once."
          value={text}
          onChange={(e) => write(e.target.value)}
          onKeyDown={keyDown}
          autoComplete="on"
          autoCorrect="on"
          autoCapitalize="sentences"
          spellCheck
          enterKeyHint="enter"
        />
      </div>
    </div>,
    document.body,
  );
}
