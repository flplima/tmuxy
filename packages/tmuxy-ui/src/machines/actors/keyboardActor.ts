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
 *
 * Text vs. chord (see isTextKey):
 * - Keyboards produce characters through more than the plain unmodified path:
 *   dead keys (´ + a → á), macOS Option as a compose key (Option+c → ç), and
 *   AltGr third-level symbols (@ { } on ABNT2/German). Each arrives as a
 *   keydown carrying the FINISHED character, wearing modifier flags that make
 *   it look like a chord. isTextKey tells those apart from real chords so the
 *   character is sent as literal text. Sent as a key name instead, tmux happily
 *   turns `M-ç` into ESC + ç — a meta chord no application types as text, so
 *   the character silently vanishes.
 */

import { fromCallback, type AnyActorRef } from 'xstate';
import type { KeyBindings, CopyModeState } from '../../tmux/types';
import { extractSelectedText } from '../../utils/copyMode';
import { setupMobileKeyboard, getMobileInput, isTouchDevice } from '../../utils/mobileKeyboard';

export type KeyboardActorEvent =
  | { type: 'UPDATE_SESSION'; sessionName: string }
  | { type: 'UPDATE_ACTIVE_PANE'; paneId: string | null }
  | { type: 'UPDATE_KEYBINDINGS'; keybindings: KeyBindings }
  | { type: 'UPDATE_ENABLED'; enabled: boolean }
  | { type: 'UPDATE_FOCUSED_FLOAT'; paneId: string | null }
  | { type: 'UPDATE_LEFT_SIDEBAR_FOCUSED'; focused: boolean }
  | { type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED'; paneId: string | null };

export interface KeyboardActorInput {
  parent: AnyActorRef;
}

const KEY_MAP: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'BSpace',
  Delete: 'DC',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Tab: 'Tab',
  Escape: 'Escape',
  Home: 'Home',
  End: 'End',
  PageUp: 'PPage',
  PageDown: 'NPage',
  Insert: 'IC',
  ' ': 'Space',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
};

/**
 * macOS Option+key produces special Unicode characters instead of altKey=true
 * This maps those characters back to their base keys for tmux M- notation
 */
const MACOS_OPTION_KEY_MAP: Record<string, string> = {
  '˙': 'h', // Option+H
  '∆': 'j', // Option+J
  '˚': 'k', // Option+K
  '¬': 'l', // Option+L
  // Add more as needed for other Option+key combinations
};

/**
 * Number of Unicode characters (code points) in a string — `'😀'.length` is 2,
 * but it is one character on screen and one cell in the terminal.
 */
function charCount(s: string): number {
  return Array.from(s).length;
}

/**
 * True when the keydown carries literal text the user typed, rather than a
 * chord to be forwarded as a tmux key name.
 *
 * A layout produces characters through four paths, three of which set modifier
 * flags that read like a chord:
 *  - plain: `a`, and layout-native accents (`ç` and `ã` on a Portuguese
 *    keyboard, `ü` on a German one) — no modifiers;
 *  - dead keys: `´` then `a` → one keydown with key `á`. The OS composes it, so
 *    the browser marks the event as IME-processed (keyCode 229) even though it
 *    already holds the finished character;
 *  - macOS Option-as-compose: Option+c → `ç`, Option+e e → `é`. altKey is set,
 *    but the OS has already replaced the letter with the composed character —
 *    which is why a NON-ASCII key under bare Alt means text, while an ASCII one
 *    (Alt+x, still `x`) is a genuine M- chord;
 *  - AltGr third level: `@ { } ~` on ABNT2, `@ € µ` on German. Legacy flags
 *    report it as ctrl+alt; only the AltGraph modifier state distinguishes it
 *    from a real Ctrl+Alt chord.
 *
 * Ctrl and Cmd never produce text, so they always mean a chord.
 */
function isTextKey(event: KeyboardEvent): boolean {
  if (charCount(event.key) !== 1) return false;
  // Option+h/j/k/l are claimed as M-h/j/k/l for pane navigation below, so the
  // characters macOS gives them are chords here, not text.
  if (MACOS_OPTION_KEY_MAP[event.key]) return false;
  if (event.getModifierState?.('AltGraph')) return true;
  if (event.ctrlKey || event.metaKey) return false;
  if (event.altKey) return event.key.codePointAt(0)! > 0x7f;
  return true;
}

function formatTmuxKey(event: KeyboardEvent): string {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('C');
  if (event.altKey || event.metaKey) modifiers.push('M');
  if (event.shiftKey && event.key.length > 1) modifiers.push('S');

  // Check for macOS Option+key special characters
  const macosKey = MACOS_OPTION_KEY_MAP[event.key];
  if (macosKey) {
    // This is a macOS Option+key producing a special character
    // Treat it as M-<key>
    return `M-${macosKey}`;
  }

  // Shift+Tab: tmux's "S-Tab" emits a literal Tab (0x09), not the back-tab
  // sequence (CSI Z) applications expect — that's the dedicated "BTab" key.
  // Only rewrite the bare Shift+Tab; Ctrl+Shift+Tab must stay "C-S-Tab" so it
  // still matches the previous-window root binding.
  if (event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    return 'BTab';
  }

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

/**
 * Placeholder pane ids (`__placeholder_*`) are client-side predictions from the
 * optimistic store — tmux has never heard of them. Targeting one (the
 * `select-pane` pin or a `send-keys -t`) makes real tmux reject the whole
 * command, dropping the user's input. Until the placeholder reconciles to a
 * real `%N`, fall back to "no pane target": commands queue FIFO on the control
 * stream, so by the time they execute server-side the in-flight split/new-window
 * has landed and tmux's own active pane IS the pane the placeholder stands for.
 */
function realPaneId(id: string | null): string | null {
  return id !== null && id.startsWith('__placeholder_') ? null : id;
}

export function createKeyboardActor() {
  return fromCallback<KeyboardActorEvent, KeyboardActorInput>(({ input, receive }) => {
    let sessionName = 'tmuxy';
    let activePaneId: string | null = null;
    let focusedFloatPaneId: string | null = null;
    // When true, the sidebar tree holds focus; its own capture-phase listener
    // handles nav keys, so we stop forwarding keystrokes to tmux.
    let leftSidebarFocused = false;
    // Pane id of the pinned terminal dock while it holds focus. Like a focused
    // float it becomes the key target, so keys reach a pane in another window
    // without `select-pane` switching the active tab out from under the user.
    let focusedRightSidebarPaneId: string | null = null;
    /**
     * The pane keys belong to when an overlay owns focus: a float wins over the
     * dock (a float is drawn on top of it), and neither is set when the plain
     * pane grid has focus.
     */
    const overlayPaneId = (): string | null => focusedFloatPaneId ?? focusedRightSidebarPaneId;
    let enabled = true;
    let isComposing = false;
    // Text pending copy via native clipboard event (client-side copy mode yank)
    let pendingCopyText: string | null = null;

    // Dynamic keybindings from server
    let prefixKey = 'C-a'; // Default, will be updated from server
    let prefixBindings: Map<string, string> = new Map();
    let prefixRepeatKeys: Set<string> = new Set();
    let rootBindings: Map<string, string> = new Map();

    // Prefix key timeout (tmux default is 500ms, we use 8000ms so the hint is
    // readable and users have time to choose a binding)
    const PREFIX_TIMEOUT_MS = 8000;

    // Mobile keyboard: forward typed characters to the active tmux session.
    // keydown handles special keys (Backspace, Enter, arrows) via the existing
    // window listener; this handles printable chars that mobile browsers only
    // deliver via `input` events.
    const cleanupMobileKeyboard = isTouchDevice()
      ? setupMobileKeyboard((text) => {
          if (!enabled) return;
          const escaped = escapeLiteralText(text);
          const mobileTarget = overlayPaneId() ?? realPaneId(activePaneId) ?? sessionName;
          input.parent.send({
            type: 'SEND_TMUX_COMMAND',
            command: `send-keys -t ${mobileTarget} -l ${escaped}`,
          });
        })
      : null;

    // Prefix mode as a small self-contained unit: it owns the active flag, the
    // auto-exit timer, and the PREFIX_MODE_CHANGE notifications. Every entry/exit
    // goes through enter()/exit(), so no caller has to remember to clear the
    // timer or fire the event — the "state with a timeout" that the scattered
    // boolean + setTimeout used to model by hand.
    let prefixActive = false;
    let prefixTimer: ReturnType<typeof setTimeout> | null = null;
    const clearPrefixTimer = () => {
      if (prefixTimer) {
        clearTimeout(prefixTimer);
        prefixTimer = null;
      }
    };
    const prefixMode = {
      get active() {
        return prefixActive;
      },
      enter() {
        prefixActive = true;
        input.parent.send({ type: 'PREFIX_MODE_CHANGE', active: true });
        clearPrefixTimer();
        prefixTimer = setTimeout(() => {
          prefixActive = false;
          prefixTimer = null;
          input.parent.send({ type: 'PREFIX_MODE_CHANGE', active: false });
        }, PREFIX_TIMEOUT_MS);
      },
      // Leave prefix mode. notify=false is the silent teardown path.
      exit(notify = true) {
        const wasActive = prefixActive;
        prefixActive = false;
        clearPrefixTimer();
        if (notify && wasActive) {
          input.parent.send({ type: 'PREFIX_MODE_CHANGE', active: false });
        }
      },
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!enabled) return;

      // Let keys pass through when the user is interacting with a real form
      // control (e.g. the read-only debug log textarea on the status screen).
      // Without this, keys like Cmd+A / Cmd+C wouldn't reach the textarea
      // because they'd be intercepted as send-keys / copy-mode triggers.
      // Mobile keyboard's hidden input is excluded — it has dedicated handling
      // further down (mobileKeyboard.ts forwards `input` events).
      const eventTarget = event.target as HTMLElement | null;
      if (
        eventTarget &&
        (eventTarget.tagName === 'TEXTAREA' || eventTarget.tagName === 'INPUT') &&
        eventTarget !== getMobileInput()
      ) {
        return;
      }

      // Skip while an IME is mid-composition — the composed text arrives whole
      // on compositionend, so forwarding the individual keydowns would garble
      // pinyin/kana input.
      if (isComposing || event.isComposing) {
        return;
      }

      // keyCode 229 means "the IME handled this key". It rides on two very
      // different events: the ones that produced no text yet (pinyin still
      // composing, key `Process`) AND the one that DELIVERS a finished dead-key
      // character (Option+e e → key `é`), which fires with no composition around
      // it when focus is not on an editable element. Suppressing both is what
      // made diacritics untypable — only drop the ones carrying no character.
      if (event.keyCode === 229 && !isTextKey(event)) {
        return;
      }

      // Ignore modifier-only key presses (Shift, Control, Alt, Meta)
      // These fire as separate keydown events but shouldn't trigger any action
      const modifierKeys = ['Shift', 'Control', 'Alt', 'Meta'];
      if (modifierKeys.includes(event.key)) {
        return;
      }

      // Let browser handle dead keys (diacritic composition)
      if (event.key === 'Dead') return;

      // Let browser handle Ctrl+V / Cmd+V for paste
      if ((event.ctrlKey || event.metaKey) && event.key === 'v') return;

      // Font size shortcuts (CmdOrCtrl + = / + / - / 0). Handled here rather
      // than via the native menu accelerator because the menu only exists on
      // macOS, and Cmd+= alone isn't reliably caught by Tauri's "CmdOrCtrl+Plus"
      // mapping — that string targets Cmd+Shift+=.
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key === '=' || event.key === '+') {
          event.preventDefault();
          input.parent.send({ type: 'INCREASE_FONT_SIZE' });
          return;
        }
        if (event.key === '-' || event.key === '_') {
          event.preventDefault();
          input.parent.send({ type: 'DECREASE_FONT_SIZE' });
          return;
        }
        if (event.key === '0') {
          event.preventDefault();
          input.parent.send({ type: 'RESET_FONT_SIZE' });
          return;
        }
      }

      // Read the machine's live activePaneId (and copy-mode states) straight off
      // the parent snapshot, rather than trusting the cached closure below.
      //
      // A pane-group tab click runs `assign({ activePaneId })` synchronously in
      // the machine transition, but the `UPDATE_ACTIVE_PANE` event that refreshes
      // our closure is delivered a task later. A key fired in the same tick as
      // the click would therefore target the previously-active pane — the first
      // character after a tab switch lands in the wrong pane. Reading the
      // snapshot here closes that window; `activePaneId` (the cached closure)
      // remains the fallback if the read ever throws.
      let liveActivePaneId = activePaneId;
      let liveCopyStates: Record<string, CopyModeState> | undefined;
      try {
        const snapshot = input.parent.getSnapshot() as {
          context?: { activePaneId?: string; copyModeStates?: Record<string, CopyModeState> };
        };
        const ctx = snapshot?.context;
        if (ctx?.activePaneId !== undefined) liveActivePaneId = ctx.activePaneId;
        liveCopyStates = ctx?.copyModeStates;
      } catch (_) {
        /* keep the cached closure values */
      }

      // Copy mode is per-pane and derived (not synced): a pane is in copy mode
      // iff the *currently active* pane has a CopyModeState. Deriving this fresh
      // on every keydown — rather than tracking a pushed boolean — means
      // switching to another pane, or closing the copy-mode pane, instantly
      // stops routing keys to copy mode without any event plumbing to keep in
      // sync. A focused overlay (float or dock) always takes priority, so its
      // keys are never hijacked by an underlying pane's copy mode.
      // The dock's pane can be in client-side copy mode too (wheel, drag), so
      // the pane whose copy state matters is the one holding the keyboard.
      let activeCopyState: CopyModeState | undefined;
      if (!leftSidebarFocused) {
        const keyboardPane = overlayPaneId() ?? liveActivePaneId;
        activeCopyState = keyboardPane ? liveCopyStates?.[keyboardPane] : undefined;
      }
      const copyModeActive = !!activeCopyState;

      // Cmd+C / Ctrl+C: copy selection to clipboard (if in copy mode with selection)
      // or send SIGINT (if not in copy mode / no selection)
      if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
        // The tree owns the keyboard: nothing here is a pane to interrupt.
        // Forwarding used to SIGINT the shell in the tab behind the column.
        if (leftSidebarFocused) {
          event.preventDefault();
          return;
        }
        if (copyModeActive) {
          // Extract text for the native copy event handler
          if (activeCopyState?.selectionMode && activeCopyState?.selectionAnchor) {
            pendingCopyText = extractSelectedText(activeCopyState);
          }
          // Don't preventDefault — let browser fire native copy event
        } else {
          event.preventDefault();
        }
        input.parent.send({ type: 'COPY_SELECTION' });
        return;
      }

      // Client-side copy mode: intercept all keys (must be checked before the
      // mobile input guard so that Space and other single-char keys reach copy
      // mode on touch-capable devices where the hidden input may have focus)
      if (copyModeActive) {
        event.preventDefault();
        // For yank keys (y, Enter), copy to clipboard via native copy event
        if (event.key === 'y' || event.key === 'Enter') {
          if (activeCopyState?.selectionMode && activeCopyState?.selectionAnchor) {
            pendingCopyText = extractSelectedText(activeCopyState);
            // Trigger native copy event (our copy handler will set clipboardData)
            document.execCommand('copy');
          }
        }
        input.parent.send({
          type: 'COPY_MODE_KEY',
          key: event.key,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
        });
        return;
      }

      // On mobile, printable character keydowns from the hidden input are handled
      // by the `input` event in mobileKeyboard.ts to avoid double-sending.
      if (event.target === getMobileInput() && isTextKey(event)) {
        return;
      }

      event.preventDefault();

      // Escape closes the focused float instead of being sent to tmux. A
      // focused SIDEBAR is different: Escape is an ordinary key there, so a
      // program running in the pinned dock (vim, lazygit, fzf) receives it,
      // and the tree column's own key handler decides what it means for the
      // tree. Leaving a column is Ctrl+h / Ctrl+l, a click, or the tree's `q`.
      if (event.key === 'Escape' && focusedFloatPaneId) {
        input.parent.send({ type: 'CLOSE_FLOAT', paneId: focusedFloatPaneId });
        return;
      }

      // Format the key to check against bindings
      const formattedKey = formatTmuxKey(event);

      // Check for prefix key (dynamic, from server)
      // Ignore auto-repeated prefix key events — holding Ctrl+A too long
      // would trigger the "double prefix" handler, resetting prefix mode
      // before the user can press the binding key.
      if (formattedKey === prefixKey && !event.repeat) {
        if (prefixMode.active) {
          // Double prefix sends literal prefix key to the shell
          prefixMode.exit();
          const prefixTarget = overlayPaneId() ?? realPaneId(liveActivePaneId) ?? sessionName;
          input.parent.send({
            type: 'SEND_TMUX_COMMAND',
            command: `send-keys -t ${prefixTarget} ${prefixKey}`,
          });
        } else {
          // Enter prefix mode
          prefixMode.enter();
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

      // If in prefix mode, look up the binding. Each terminal branch below
      // leaves prefix mode via prefixMode.exit() (or re-arms via enter() for
      // repeat bindings), which handles the timer and notification — so there
      // is no manual clear/notify to keep in sync here.
      if (prefixMode.active) {
        // Determine the binding key — map DOM key values to tmux key names
        let bindingKey = KEY_MAP[event.key] ?? event.key;

        // Handle shifted characters - browsers may send the base key with shiftKey=true
        // instead of the shifted character (especially with Playwright/automation)
        if (event.shiftKey && event.key.length === 1) {
          const shiftedKeys: Record<string, string> = {
            "'": '"', // Shift+' = " (horizontal split)
            '5': '%', // Shift+5 = % (vertical split)
            '7': '&', // Shift+7 = & (kill window)
            '1': '!', // Shift+1 = ! (break pane)
            '[': '{', // Shift+[ = { (swap pane up)
            ']': '}', // Shift+] = } (swap pane down)
            '/': '?', // Shift+/ = ? (list keys)
            ';': ':', // Shift+; = : (command prompt)
          };
          if (shiftedKeys[event.key]) {
            bindingKey = shiftedKeys[event.key];
          }
        }

        // `prefix t` toggles the left sidebar (the tree) and `prefix T` the
        // right one (the pinned dock). Handled client-side (like the header
        // buttons) so they never reach tmux and work for web clients
        // regardless of any server-side binding for those keys.
        if (bindingKey === 't' || bindingKey === 'T') {
          input.parent.send({
            type: bindingKey === 't' ? 'TOGGLE_LEFT_SIDEBAR' : 'TOGGLE_RIGHT_SIDEBAR',
          });
          prefixMode.exit();
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

        const bindingCommand = prefixBindings.get(bindingKey);
        if (bindingCommand) {
          // Prefix-pin to activePaneId. Most prefix bindings (e.g., `split-window`,
          // `kill-pane`) have no `-t` target and run against tmux's server-side
          // active pane — which can lag the user's perceived focus right after a
          // window switch or pane-group swap. Prepending `select-pane -t <id>`
          // aligns tmux's view with ours before the binding executes; for
          // bindings that carry their own target (e.g., `select-pane -L`), the
          // prepend is a harmless no-op since the binding overrides it.
          const target = overlayPaneId() ?? realPaneId(liveActivePaneId);
          const command = target
            ? `select-pane -t ${target} \\; ${bindingCommand}`
            : bindingCommand;
          input.parent.send({
            type: 'SEND_TMUX_COMMAND',
            command,
          });

          // Re-enter prefix mode for repeat (-r) bindings, matching tmux behavior.
          // This lets users press e.g. prefix+o o o to cycle panes without
          // re-pressing the prefix key each time.
          if (prefixRepeatKeys.has(bindingKey)) {
            prefixMode.enter();
          } else {
            prefixMode.exit();
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

        // Unknown binding - just ignore (like tmux does)
        prefixMode.exit();
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

      // Check for root bindings (bind -n) - these bypass send-keys
      const rootCommand = formattedKey ? rootBindings.get(formattedKey) : undefined;
      if (rootCommand) {
        // Same prefix-pin treatment as prefix bindings — root bindings (bind -n)
        // also run against tmux's server-side active pane and need the
        // post-tab-switch / post-group-swap race guarded the same way.
        const target = overlayPaneId() ?? realPaneId(liveActivePaneId);
        const command = target ? `select-pane -t ${target} \\; ${rootCommand}` : rootCommand;
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

      // The tree column has the keyboard and this key was not a binding: it
      // belongs to nothing. The tree's own listener already swallowed plain
      // keys; this catches the chords it let through for bindings' sake, which
      // otherwise reached the tab's active pane behind the column.
      if (leftSidebarFocused) {
        return;
      }

      // Normal key handling - send via send-keys
      // Target priority: focused float > active pane ID > session name
      // Using activePaneId ensures input reaches the correct pane immediately
      // after an optimistic tab switch (before tmux processes select-window).
      const target = overlayPaneId() ?? realPaneId(liveActivePaneId) ?? sessionName;
      // Typed characters go as literal mode (-l) so tmux never reads them as key
      // syntax; everything else goes as a tmux key name. A character the layout
      // composed (á, ç, @ via AltGr) has no meaningful key name: tmux accepts
      // `send-keys M-ç` but delivers ESC + ç, which the shell discards as an
      // unbound meta sequence — the character never reaches the line.
      let command: string;
      if (isTextKey(event)) {
        command = `send-keys -t ${target} -l ${escapeLiteralText(event.key)}`;
      } else if (formattedKey) {
        command = `send-keys -t ${target} ${formattedKey}`;
      } else {
        return;
      }
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
    };

    const handleCompositionStart = () => {
      isComposing = true;
    };

    const handleCompositionEnd = (event: CompositionEvent) => {
      isComposing = false;
      if (!enabled) return;

      // Send the composed text (CJK, an emoji from the picker, a dead-key
      // accent) as one literal string. Same target priority as a keystroke, so
      // composed text reaches a focused float or the pinned dock rather than
      // the pane behind it.
      const composedText = event.data;
      if (!composedText) return;
      const target = overlayPaneId() ?? realPaneId(activePaneId) ?? sessionName;
      input.parent.send({
        type: 'SEND_TMUX_COMMAND',
        command: `send-keys -t ${target} -l ${escapeLiteralText(composedText)}`,
      });
    };

    const PASTE_CHUNK_SIZE = 500;

    const handlePaste = (event: ClipboardEvent) => {
      if (!enabled) return;
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;

      // Build multiple send-keys commands joined by \n. Control mode processes
      // each line as a separate command, so this keeps them atomic and ordered.
      // For each text line: send-keys -l 'text', then send-keys Enter.
      const lines = text.split('\n');
      const commands: string[] = [];

      const pasteTarget = overlayPaneId() ?? realPaneId(activePaneId) ?? sessionName;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 0) {
          // Chunk long lines
          for (let j = 0; j < line.length; j += PASTE_CHUNK_SIZE) {
            const chunk = line.slice(j, j + PASTE_CHUNK_SIZE);
            commands.push(`send-keys -t ${pasteTarget} -l ${escapeLiteralText(chunk)}`);
          }
        }
        if (i < lines.length - 1) {
          commands.push(`send-keys -t ${pasteTarget} Enter`);
        }
      }

      if (commands.length > 0) {
        // Send all commands as \n-separated string in a single call.
        // The backend writes this to control mode stdin, which processes
        // each line as a separate command in order.
        input.parent.send({
          type: 'SEND_TMUX_COMMAND',
          command: commands.join('\n'),
        });
      }
    };

    // Native copy event handler — uses pendingCopyText set by keydown handler
    const handleCopy = (event: ClipboardEvent) => {
      if (pendingCopyText) {
        event.preventDefault();
        event.clipboardData?.setData('text/plain', pendingCopyText);
        pendingCopyText = null;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('compositionstart', handleCompositionStart);
    window.addEventListener('compositionend', handleCompositionEnd);
    window.addEventListener('paste', handlePaste);
    window.addEventListener('copy', handleCopy);

    receive((event) => {
      if (event.type === 'UPDATE_SESSION') {
        sessionName = event.sessionName;
      } else if (event.type === 'UPDATE_ACTIVE_PANE') {
        activePaneId = event.paneId;
      } else if (event.type === 'UPDATE_KEYBINDINGS') {
        const kb = event.keybindings;
        prefixKey = kb.prefix_key;
        prefixBindings = new Map(kb.prefix_bindings.map((b) => [b.key, b.command]));
        prefixRepeatKeys = new Set(kb.prefix_bindings.filter((b) => b.repeat).map((b) => b.key));
        rootBindings = new Map(kb.root_bindings.map((b) => [b.key, b.command]));
      } else if (event.type === 'UPDATE_ENABLED') {
        enabled = event.enabled;
      } else if (event.type === 'UPDATE_FOCUSED_FLOAT') {
        focusedFloatPaneId = event.paneId;
      } else if (event.type === 'UPDATE_LEFT_SIDEBAR_FOCUSED') {
        leftSidebarFocused = event.focused;
      } else if (event.type === 'UPDATE_RIGHT_SIDEBAR_FOCUSED') {
        focusedRightSidebarPaneId = event.paneId;
      }
    });

    return () => {
      cleanupMobileKeyboard?.();
      prefixMode.exit(false);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('compositionstart', handleCompositionStart);
      window.removeEventListener('compositionend', handleCompositionEnd);
      window.removeEventListener('paste', handlePaste);
      window.removeEventListener('copy', handleCopy);
    };
  });
}
