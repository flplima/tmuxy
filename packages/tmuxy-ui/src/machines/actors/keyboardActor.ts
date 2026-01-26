/**
 * Keyboard Actor - Formats DOM keyboard events into tmux key syntax
 *
 * All key interpretation (prefix, bindings, command mode) is handled by tmux natively.
 * This actor simply captures keydown events and sends formatted keys via send-keys.
 *
 * IME Composition Handling:
 * - During IME composition (CJK input, dead keys), we suppress individual keydowns
 * - The composed text is sent as a single unit when composition ends
 * - This prevents garbled text during pinyin/kana input
 */

import { fromCallback, type AnyActorRef } from 'xstate';

export type KeyboardActorEvent =
  | { type: 'UPDATE_SESSION'; sessionName: string };

export interface KeyboardActorInput { parent: AnyActorRef }

const KEY_MAP: Record<string, string> = {
  Enter: 'Enter', Backspace: 'BSpace', Delete: 'DC',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Tab: 'Tab', Escape: 'Escape', Home: 'Home', End: 'End',
  PageUp: 'PPage', PageDown: 'NPage', Insert: 'IC',
  ' ': 'Space',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};

function formatTmuxKey(event: KeyboardEvent): string {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('C');
  if (event.altKey || event.metaKey) modifiers.push('M');
  if (event.shiftKey && event.key.length > 1) modifiers.push('S');

  const mapped = KEY_MAP[event.key];
  if (mapped) {
    return modifiers.length > 0 ? `${modifiers.join('-')}-${mapped}` : mapped;
  } else if (event.key.length === 1) {
    return modifiers.length > 0 ? `${modifiers.join('-')}-${event.key.toLowerCase()}` : event.key;
  }
  return '';
}

/**
 * Escape text for use with tmux send-keys -l (literal mode)
 * This handles special characters that might be interpreted by tmux
 */
function escapeLiteralText(text: string): string {
  // Escape single quotes by ending quote, adding escaped quote, starting new quote
  // 'text' -> 'text'\''more'
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

export function createKeyboardActor() {
  return fromCallback<KeyboardActorEvent, KeyboardActorInput>(({ input, receive }) => {
    let sessionName = 'tmuxy';
    let isComposing = false;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Skip during IME composition
      // keyCode 229 is a special value indicating IME is processing
      if (isComposing || event.isComposing || event.keyCode === 229) {
        return;
      }

      event.preventDefault();
      const key = formatTmuxKey(event);
      if (!key) return;

      input.parent.send({
        type: 'SEND_TMUX_COMMAND',
        command: `send-keys -t ${sessionName} ${key}`,
      });

      input.parent.send({
        type: 'KEY_PRESS',
        key: event.key,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
      });
    };

    const handleCompositionStart = () => {
      isComposing = true;
    };

    const handleCompositionEnd = (event: CompositionEvent) => {
      isComposing = false;

      // Send the composed text as a literal string
      const composedText = event.data;
      if (composedText) {
        // Use -l flag for literal text to avoid key interpretation
        const escaped = escapeLiteralText(composedText);
        input.parent.send({
          type: 'SEND_TMUX_COMMAND',
          command: `send-keys -t ${sessionName} -l ${escaped}`,
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('compositionstart', handleCompositionStart);
    window.addEventListener('compositionend', handleCompositionEnd);

    receive((event) => {
      if (event.type === 'UPDATE_SESSION') {
        sessionName = event.sessionName;
      }
    });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('compositionstart', handleCompositionStart);
      window.removeEventListener('compositionend', handleCompositionEnd);
    };
  });
}
