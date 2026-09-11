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
 * - A composition can only START on an editable element, so a hidden input
 *   (utils/mobileKeyboard.ts) owns browser focus on every device and follows
 *   the pane holding the keyboard. Text typed into it arrives as `input`
 *   events; keydowns on it are still classified here so bindings win.
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
import {
  focusKeyboardInput,
  getMobileInput,
  isTouchDevice,
  setKeyboardInputTarget,
  setupMobileKeyboard,
} from '../../utils/mobileKeyboard';

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

/**
 * A key that only changes what the NEXT key means.
 *
 * The scroll view stays open through these: holding Shift to extend a
 * selection, or Meta on the way to Cmd+C, is not the user asking to type.
 */
function isModifierOnlyKey(key: string): boolean {
  return (
    key === 'Shift' ||
    key === 'Control' ||
    key === 'Alt' ||
    key === 'Meta' ||
    key === 'CapsLock' ||
    key === 'AltGraph' ||
    key === 'Dead'
  );
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
    // Where a composition begun outside the hidden input commits: pinned when
    // it starts, so a pane switch mid-composition cannot redirect the text.
    let compositionTarget: string | null = null;
    // Whether browser focus has been handed to the hidden input once. After
    // that, clicks on panes and floats move it; nothing here steals it back.
    let keyboardFocusEstablished = false;
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

    /**
     * The `-t` target for text and keys: the overlay holding the keyboard, else
     * the active pane, else the session. A placeholder overlay (a float still
     * being created) falls through to the session rather than to the pane
     * behind it — see realPaneId.
     */
    const keyTarget = (): string => {
      const overlay = overlayPaneId();
      if (overlay) return realPaneId(overlay) ?? sessionName;
      return realPaneId(activePaneId) ?? sessionName;
    };

    const isRealFormControl = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      return (
        element !== null &&
        (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') &&
        element !== getMobileInput()
      );
    };

    /**
     * Point the hidden input at the pane holding the keyboard, and hand it
     * browser focus the first time a real pane exists — an IME cannot begin a
     * composition until an editable element owns focus. Only when nothing else
     * has focus: a real form control keeps it, and a touch device waits for a
     * tap so the virtual keyboard never pops up unasked.
     */
    const syncKeyboardInputTarget = () => {
      setKeyboardInputTarget(overlayPaneId() ?? activePaneId);
      if (document.activeElement === getMobileInput()) {
        keyboardFocusEstablished = true;
        return;
      }
      const target = realPaneId(overlayPaneId() ?? activePaneId);
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

    // Text the hidden input received — typed characters and committed IME
    // compositions on every device; on touch also the characters a virtual
    // keyboard delivers only as `input` events. Special keys still travel
    // through the window keydown listener. The pane the input was aimed at
    // when the text arrived wins, so a commit lands where composition began.
    const cleanupKeyboardInput = setupMobileKeyboard((text, paneId) => {
      if (!enabled || leftSidebarFocused) return;
      const textTarget = paneId === null ? keyTarget() : (realPaneId(paneId) ?? sessionName);
      input.parent.send({
        type: 'SEND_TMUX_COMMAND',
        command: `send-keys -t ${textTarget} -l ${escapeLiteralText(text)}`,
      });
    });

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
      // The hidden keyboard input is not one of those: its keydowns are
      // classified below, and its text arrives through `input` events.
      if (isRealFormControl(event.target)) return;

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
        // cmd+0 resets the font; ctrl+0 is the Tab Overview (handled below).
        if (event.key === '0' && event.metaKey) {
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
      let liveActiveWindowId: string | null = null;
      let liveCopyStates: Record<string, CopyModeState> | undefined;
      let livePanes: ReadonlyArray<{ tmuxId: string; windowId: string; active: boolean }> = [];
      try {
        const snapshot = input.parent.getSnapshot() as {
          context?: {
            activePaneId?: string;
            activeWindowId?: string | null;
            copyModeStates?: Record<string, CopyModeState>;
            panes?: ReadonlyArray<{ tmuxId: string; windowId: string; active: boolean }>;
          };
        };
        const ctx = snapshot?.context;
        if (ctx?.activePaneId !== undefined) liveActivePaneId = ctx.activePaneId;
        if (ctx?.activeWindowId) liveActiveWindowId = ctx.activeWindowId;
        liveCopyStates = ctx?.copyModeStates;
        if (ctx?.panes) livePanes = ctx.panes;
      } catch (_) {
        /* keep the cached closure values */
      }

      /**
       * The pin prepended to a binding so it runs where the user is looking.
       *
       * A binding such as `split-window` carries no target and acts on tmux's
       * CURRENT window and pane. Right after a tab switch the client has already
       * moved on (the switch is optimistic) while tmux may not have — and
       * `select-pane -t <pane>` alone never changes the current window, so the
       * split could land in the tab the user just left. Naming the window too
       * makes the binding independent of what tmux's current window is at that
       * instant. An overlay (float, dock) is pinned by pane only: its window must
       * never become current, or the tab behind it would blank.
       *
       * The WINDOW is what steers: `select-pane` on a pane in another window
       * sets that window's active pane and leaves tmux's current window alone,
       * so a `split-window` after it still runs wherever tmux already was.
       * A pane pin on its own therefore steers nothing, which is how splits
       * kept landing in the first tab. The window is taken from the machine
       * when it has one and derived from the pinned pane otherwise (cold
       * start, the beat after a session switch), so the pin is never
       * pane-only. The pane must then name a pane OF that window: when the
       * machine's active pane is not in it (a stale id from a snapshot, a
       * switch mid-flight), the window's own active pane is pinned instead, or
       * just the window.
       */
      const bindingPin = (): string => {
        const overlay = realPaneId(overlayPaneId());
        if (overlayPaneId()) return overlay ? `select-pane -t ${overlay} \\; ` : '';
        let pane = realPaneId(liveActivePaneId);
        const windowId =
          liveActiveWindowId ?? livePanes.find((p) => p.tmuxId === pane)?.windowId ?? null;
        if (windowId) {
          const inWindow = (id: string | null) =>
            id !== null && livePanes.some((p) => p.tmuxId === id && p.windowId === windowId);
          if (!inWindow(pane)) {
            pane = realPaneId(
              livePanes.find((p) => p.windowId === windowId && p.active)?.tmuxId ?? null,
            );
          }
          const windowPin = `select-window -t ${windowId} \\; `;
          return pane ? `${windowPin}select-pane -t ${pane} \\; ` : windowPin;
        }
        // Nothing known about the window: the pane pin at least aims at the
        // right pane if tmux is already on its window.
        return pane ? `select-pane -t ${pane} \\; ` : '';
      };

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
      let scrollbackPane: string | null = null;
      if (!leftSidebarFocused) {
        scrollbackPane = overlayPaneId() ?? liveActivePaneId;
        activeCopyState = scrollbackPane ? liveCopyStates?.[scrollbackPane] : undefined;
      }
      // Only tmux's copy mode takes the keyboard. The scroll view is a way of
      // looking at scrollback, not a mode you type in: a keystroke there means
      // the user is done reading, so it closes the view and goes to the pane,
      // which is what every other terminal does.
      const copyModeActive = activeCopyState?.mode === 'copy';
      const scrollModePane = activeCopyState?.mode === 'scroll' ? scrollbackPane : null;

      /** A selection the user made with the browser, anywhere in the app. */
      const nativeSelection = () => window.getSelection()?.toString() ?? '';

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
        } else if (event.metaKey && nativeSelection()) {
          // Cmd+C over a selection the browser owns: let it copy, and do not
          // interrupt the process. Ctrl+C deliberately does NOT land here —
          // interrupting has to stay reliable even with text selected, which
          // is the contract every terminal keeps.
          return;
        } else {
          event.preventDefault();
        }
        input.parent.send({ type: 'COPY_SELECTION' });
        return;
      }

      // The scroll view closes on the first real keystroke and the key goes on
      // to the pane, so typing while scrolled up lands at the prompt with the
      // view back at the bottom — the behaviour of any terminal. Modifier
      // presses on their own are not "typing" and leave it open, or holding
      // Shift to extend a selection would close what you are selecting from.
      if (scrollModePane && !isModifierOnlyKey(event.key)) {
        input.parent.send({ type: 'EXIT_SCROLL_MODE', paneId: scrollModePane });
        // Escape is spent on leaving; anything else carries on to the pane.
        if (event.key === 'Escape') {
          event.preventDefault();
          return;
        }
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

      // A text keydown on the hidden input becomes an `input` event, which
      // mobileKeyboard.ts forwards — so it must NOT be sent here too, and its
      // default must survive. It still runs through the prefix and binding
      // checks below so a bound printable key wins; each of those branches
      // cancels the event itself. Only the unbound text path lets it through.
      const hiddenInputText = event.target === getMobileInput() && isTextKey(event);
      if (!hiddenInputText) event.preventDefault();

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
        event.preventDefault();
        if (prefixMode.active) {
          // Double prefix sends literal prefix key to the shell
          prefixMode.exit();
          input.parent.send({
            type: 'SEND_TMUX_COMMAND',
            command: `send-keys -t ${keyTarget()} ${prefixKey}`,
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
        // Every key after the prefix is consumed, bound or not (tmux ignores an
        // unbound one) — it must never fall through as typed text.
        event.preventDefault();
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
        // `prefix w` is tmux's own "choose window" key; here it opens the Tab
        // Overview, the same view ctrl+0 toggles.
        if (bindingKey === 't' || bindingKey === 'T' || bindingKey === 'w') {
          input.parent.send({
            type:
              bindingKey === 't'
                ? 'TOGGLE_LEFT_SIDEBAR'
                : bindingKey === 'T'
                  ? 'TOGGLE_RIGHT_SIDEBAR'
                  : 'TOGGLE_TAB_OVERVIEW',
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
          // Prefix-pin to the window and pane the user sees (see `bindingPin`).
          // Most prefix bindings (e.g., `split-window`, `kill-pane`) have no
          // `-t` target and run against tmux's server-side current window/pane,
          // which can lag the user's perceived focus right after a window switch
          // or pane-group swap. For bindings that carry their own target (e.g.,
          // `select-pane -L`), the prepend is a harmless no-op.
          const command = `${bindingPin()}${bindingCommand}`;
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

      // ctrl+1…9 select a tab by its POSITION in the strip and ctrl+0 toggles
      // the Tab Overview — handled here, not by tmux root bindings, so a
      // chrome window's tmux index (a sidebar, a float) can never shift which
      // tab a digit lands on, and so the overview works on every client.
      if (event.ctrlKey && !event.altKey && !event.metaKey && /^[0-9]$/.test(event.key)) {
        if (event.key === '0') {
          input.parent.send({ type: 'TOGGLE_TAB_OVERVIEW' });
        } else {
          input.parent.send({ type: 'SELECT_TAB_BY_POSITION', position: Number(event.key) });
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

      // Check for root bindings (bind -n) - these bypass send-keys
      const rootCommand = formattedKey ? rootBindings.get(formattedKey) : undefined;
      if (rootCommand) {
        event.preventDefault();
        // Same pin as prefix bindings — root bindings (bind -n) also run
        // against tmux's server-side current window/pane and need the
        // post-tab-switch / post-group-swap race guarded the same way.
        const command = `${bindingPin()}${rootCommand}`;
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

      // The hidden input delivers this character itself (see above).
      if (hiddenInputText) return;

      // Normal key handling - send via send-keys
      // Target priority: focused overlay > active pane ID > session name
      // Using activePaneId ensures input reaches the correct pane immediately
      // after an optimistic tab switch (before tmux processes select-window).
      const overlay = overlayPaneId();
      const target = overlay
        ? (realPaneId(overlay) ?? sessionName)
        : (realPaneId(liveActivePaneId) ?? sessionName);
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

    // A composition inside a real form control belongs to the browser.
    const handleCompositionStart = (event: CompositionEvent) => {
      if (isRealFormControl(event.target)) {
        isComposing = false;
        compositionTarget = null;
        return;
      }
      isComposing = true;
      compositionTarget = keyTarget();
    };

    const handleCompositionEnd = (event: CompositionEvent) => {
      isComposing = false;
      if (isRealFormControl(event.target)) {
        compositionTarget = null;
        return;
      }
      const target = compositionTarget ?? keyTarget();
      compositionTarget = null;
      if (!enabled) return;
      // The hidden input commits its own composition (mobileKeyboard.ts), so
      // the `input` event that follows can be de-duplicated there.
      if (event.target === getMobileInput()) return;

      // Send the composed text (CJK, an emoji from the picker, a dead-key
      // accent) as one literal string, to the pane that held the keyboard when
      // the composition began: a focused float or the pinned dock rather than
      // the pane behind it.
      const composedText = event.data;
      if (!composedText) return;
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

      const pasteTarget = keyTarget();
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

    /**
     * A pane taking browser focus gives it straight back.
     *
     * The pane wrapper is focusable (it is the grid's tab stop), so clicking
     * into a pane moves focus off the hidden input — and an accent typed after
     * that simply never arrives. A dead key is not a keystroke the browser
     * reports: the OS composes `\u00b4` and `a` into `\u00e1` and delivers it only
     * to whatever is being EDITED, so with focus on a plain div there is
     * nowhere for the composed character to go. Ordinary keys were fine, which
     * is why this reads as "diacritics stopped working" rather than "typing
     * stopped working".
     *
     * Not while something is selected, though. Focusing an input moves the
     * insertion point into it, which drops whatever the page had selected —
     * and a right-click on a selection is a focus change too, so taking the
     * focus back there would clear the very text the menu is about. The
     * release of the pointer is the second chance: by then the selection is
     * either deliberate (leave it, and leave the focus) or gone.
     *
     * Only the pane surfaces hand focus back. Menus, the sidebar tree and real
     * form controls all take focus on purpose and keep it.
     */
    const hasSelection = (): boolean => {
      const selection = window.getSelection();
      return !!selection && !selection.isCollapsed && selection.toString().length > 0;
    };

    const restoreKeyboardFocus = () => {
      if (isTouchDevice() || hasSelection()) return;
      const active = document.activeElement as HTMLElement | null;
      const pane = active?.closest?.('[data-pane-id][tabindex]') as HTMLElement | null;
      if (!pane || pane !== active) return;
      const paneId = realPaneId(pane.dataset.paneId ?? null);
      if (paneId === null) return;
      focusKeyboardInput(paneId);
      keyboardFocusEstablished = true;
    };

    const handleFocusIn = () => restoreKeyboardFocus();
    const handlePointerUp = () => restoreKeyboardFocus();

    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('focusin', handleFocusIn);
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
        syncKeyboardInputTarget();
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
        syncKeyboardInputTarget();
      } else if (event.type === 'UPDATE_LEFT_SIDEBAR_FOCUSED') {
        leftSidebarFocused = event.focused;
      } else if (event.type === 'UPDATE_RIGHT_SIDEBAR_FOCUSED') {
        focusedRightSidebarPaneId = event.paneId;
        syncKeyboardInputTarget();
      }
    });

    return () => {
      cleanupKeyboardInput();
      prefixMode.exit(false);
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('compositionstart', handleCompositionStart);
      window.removeEventListener('compositionend', handleCompositionEnd);
      window.removeEventListener('paste', handlePaste);
      window.removeEventListener('copy', handleCopy);
    };
  });
}
