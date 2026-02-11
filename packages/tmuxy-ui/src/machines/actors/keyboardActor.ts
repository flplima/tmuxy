/**
 * Keyboard Actor - Formats DOM keyboard events into tmux key syntax
 *
 * Prefix Mode Handling:
 * - When Ctrl+A (prefix key) is pressed, we enter "prefix mode"
 * - The next key triggers the corresponding tmux command directly
 * - This is necessary because send-keys bypasses tmux's prefix handling
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

/**
 * Prefix key bindings - maps key (after prefix) to tmux command
 * These are the default bindings, matching the tmuxy config
 */
const PREFIX_BINDINGS: Record<string, string | ((session: string) => string)> = {
  // Window operations
  'c': (session) => `new-window -t ${session}`,
  'n': (session) => `next-window -t ${session}`,
  'p': (session) => `previous-window -t ${session}`,
  'l': (session) => `last-window -t ${session}`,
  '0': (session) => `select-window -t ${session}:0`,
  '1': (session) => `select-window -t ${session}:1`,
  '2': (session) => `select-window -t ${session}:2`,
  '3': (session) => `select-window -t ${session}:3`,
  '4': (session) => `select-window -t ${session}:4`,
  '5': (session) => `select-window -t ${session}:5`,
  '6': (session) => `select-window -t ${session}:6`,
  '7': (session) => `select-window -t ${session}:7`,
  '8': (session) => `select-window -t ${session}:8`,
  '9': (session) => `select-window -t ${session}:9`,
  '&': (session) => `kill-window -t ${session}`,
  ',': (session) => `command-prompt -I "#W" "rename-window -t ${session} '%%'"`,
  'w': (session) => `choose-window -t ${session}`,

  // Pane operations
  '"': (session) => `split-window -t ${session} -v`,  // Horizontal split (creates pane below)
  '%': (session) => `split-window -t ${session} -h`,  // Vertical split (creates pane right)
  'z': (session) => `resize-pane -t ${session} -Z`,   // Zoom toggle
  'x': (session) => `kill-pane -t ${session}`,
  'o': (session) => `select-pane -t ${session} -t :.+`, // Next pane
  ';': (session) => `select-pane -t ${session} -l`,    // Last pane
  'q': (session) => `display-panes -t ${session}`,     // Display pane numbers
  '!': (session) => `break-pane -t ${session}`,        // Break pane to window
  '{': (session) => `swap-pane -t ${session} -U`,      // Swap with previous
  '}': (session) => `swap-pane -t ${session} -D`,      // Swap with next

  // Pane navigation with arrows
  'ArrowUp': (session) => `select-pane -t ${session} -U`,
  'ArrowDown': (session) => `select-pane -t ${session} -D`,
  'ArrowLeft': (session) => `select-pane -t ${session} -L`,
  'ArrowRight': (session) => `select-pane -t ${session} -R`,

  // Layout
  ' ': (session) => `next-layout -t ${session}`,

  // Copy mode
  '[': (session) => `copy-mode -t ${session}`,
  ']': (session) => `paste-buffer -t ${session}`,

  // Other
  'd': () => `detach-client`,
  't': (session) => `clock-mode -t ${session}`,
  '?': () => `list-keys`,
  ':': () => `command-prompt`,

  // Send prefix to nested tmux (Ctrl+A Ctrl+A sends literal Ctrl+A)
  'a': (session) => `send-keys -t ${session} C-a`,
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
    let inPrefixMode = false;
    let prefixTimeout: ReturnType<typeof setTimeout> | null = null;

    // Prefix key timeout (tmux default is 500ms, we use 2000ms for web latency)
    const PREFIX_TIMEOUT_MS = 2000;

    const resetPrefixMode = () => {
      inPrefixMode = false;
      if (prefixTimeout) {
        clearTimeout(prefixTimeout);
        prefixTimeout = null;
      }
    };

    const enterPrefixMode = () => {
      inPrefixMode = true;
      // Reset after timeout
      prefixTimeout = setTimeout(() => {
        inPrefixMode = false;
        prefixTimeout = null;
      }, PREFIX_TIMEOUT_MS);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // Skip during IME composition
      // keyCode 229 is a special value indicating IME is processing
      if (isComposing || event.isComposing || event.keyCode === 229) {
        return;
      }

      // Ignore modifier-only key presses (Shift, Control, Alt, Meta)
      // These fire as separate keydown events but shouldn't trigger any action
      const modifierKeys = ['Shift', 'Control', 'Alt', 'Meta'];
      if (modifierKeys.includes(event.key)) {
        return;
      }

      event.preventDefault();

      // Check for prefix key (Ctrl+A)
      if (event.ctrlKey && event.key.toLowerCase() === 'a' && !event.altKey && !event.metaKey) {
        if (inPrefixMode) {
          // Ctrl+A Ctrl+A sends literal Ctrl+A to the shell
          resetPrefixMode();
          input.parent.send({
            type: 'SEND_TMUX_COMMAND',
            command: `send-keys -t ${sessionName} C-a`,
          });
        } else {
          // Enter prefix mode
          enterPrefixMode();
        }

        input.parent.send({
          type: 'KEY_PRESS',
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
        });
        return;
      }

      // If in prefix mode, look up the binding
      if (inPrefixMode) {
        resetPrefixMode();

        // Determine the binding key
        let bindingKey = event.key;

        // Handle shifted characters - browsers may send the base key with shiftKey=true
        // instead of the shifted character (especially with Playwright/automation)
        if (event.shiftKey && event.key.length === 1) {
          const shiftedKeys: Record<string, string> = {
            "'": '"',  // Shift+' = " (horizontal split)
            '5': '%',  // Shift+5 = % (vertical split)
            '7': '&',  // Shift+7 = & (kill window)
            '1': '!',  // Shift+1 = ! (break pane)
            '[': '{',  // Shift+[ = { (swap pane up)
            ']': '}',  // Shift+] = } (swap pane down)
            '/': '?',  // Shift+/ = ? (list keys)
            ';': ':',  // Shift+; = : (command prompt)
          };
          if (shiftedKeys[event.key]) {
            bindingKey = shiftedKeys[event.key];
          }
        }

        const binding = PREFIX_BINDINGS[bindingKey];
        if (binding) {
          const command = typeof binding === 'function' ? binding(sessionName) : binding;
          input.parent.send({
            type: 'SEND_TMUX_COMMAND',
            command,
          });

          input.parent.send({
            type: 'KEY_PRESS',
            key: event.key,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
          });
          return;
        }

        // Unknown binding - just ignore (like tmux does)
        input.parent.send({
          type: 'KEY_PRESS',
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
        });
        return;
      }

      // Normal key handling - send via send-keys
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
      resetPrefixMode();
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('compositionstart', handleCompositionStart);
      window.removeEventListener('compositionend', handleCompositionEnd);
    };
  });
}
