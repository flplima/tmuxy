/**
 * Keyboard Actor - Formats DOM keyboard events into tmux key syntax and
 * dispatches prefix, sticky key-table, root, and literal/keystroke ops.
 */

import { clearNativeSelection, terminalSelection } from '../../infra/dom/nativeSelection';
import { fromCallback, type AnyActorRef, type EventObject } from 'xstate';
import type { KeyBindings } from '../../domain/wire';
import { getMobileInput, markKeyboardTarget } from '../../infra/dom/mobileKeyboard';
import { TmuxOp } from '../../domain/commands';
import { CLIENT_KEYS, type ClientKey, splitTableSwitch } from '../../domain/keyTables';
import { tabWalksChrome } from '../../infra/dom/chromeTab';
import {
  bindingKeyOf,
  formatTmuxKey,
  isModifierOnlyKey,
  isRealFormControl,
  isTextKey,
  windowShortcut,
} from './keyboard/keyFormatting';
import { handleModalOrCopyKeyDown } from './keyboard/modalAndCopyKeys';
import type { ContextView } from '../contextView';
import { overlayPaneId, type KeyContext } from '../selectors/keyboard';
import { setupImeClipboardAndFocusListeners } from './keyboard/imeAndClipboard';
import { isReplayedPreviewKey } from '../../infra/dom/replayedKeys';

const PREVIEW_SAFE_ROOT_COMMAND =
  /^(?:tmuxy-nav-(?:left|right|up|down)|select-pane|selectp|select-window|selectw|previous-window|prev|next-window|next)(?:\s|$)/;

function isSafePreviewRootCommand(command: string): boolean {
  const trimmed = command.trim();
  return (
    !trimmed.includes(';') && !trimmed.includes('\n') && PREVIEW_SAFE_ROOT_COMMAND.test(trimmed)
  );
}

/** The actor takes no events: what it needs from the machine it reads through `keys`. */
export interface KeyboardActorInput {
  parent: AnyActorRef;
  keys: ContextView<KeyContext>;
}

/** The binding tables, as the actor looks keys up in them. */
interface BindingMaps {
  prefixKey: string;
  /** How long a `bind -r` key keeps the prefix armed for the next repeat (tmux's `repeat-time`). */
  repeatTimeMs: number;
  prefix: Map<string, string>;
  prefixRepeat: Set<string>;
  root: Map<string, string>;
  tables: Map<string, Map<string, string>>;
}

const NO_BINDINGS: BindingMaps = {
  prefixKey: 'C-a',
  repeatTimeMs: 500,
  prefix: new Map(),
  prefixRepeat: new Set(),
  root: new Map(),
  tables: new Map(),
};

function bindingMaps(kb: KeyBindings): BindingMaps {
  return {
    prefixKey: kb.prefix_key,
    repeatTimeMs: kb.repeat_time_ms,
    prefix: new Map(kb.prefix_bindings.map((b) => [b.key, b.command])),
    prefixRepeat: new Set(kb.prefix_bindings.filter((b) => b.repeat).map((b) => b.key)),
    root: new Map(kb.root_bindings.map((b) => [b.key, b.command])),
    tables: new Map(
      Object.entries(kb.tables).map(([name, bindings]) => [
        name,
        new Map(bindings.map((b) => [b.key, b.command])),
      ]),
    ),
  };
}

/** Where the page shows the keyboard is: `data-keyboard-target` on the hidden input. */
function keyboardMark(keys: KeyContext): string {
  if (keys.owner.kind === 'left') return 'left-sidebar';
  return overlayPaneId(keys.owner) ?? keys.activePaneId ?? '';
}

const PREFIX_TIMEOUT_MS = 8000;

export function createKeyboardActor() {
  return fromCallback<EventObject, KeyboardActorInput>(({ input }) => {
    const { keys } = input;
    let bindingsSource: KeyBindings | null = null;
    let bindings = NO_BINDINGS;
    const currentBindings = (kb: KeyBindings | null): BindingMaps => {
      if (kb !== bindingsSource) {
        bindingsSource = kb;
        bindings = kb ? bindingMaps(kb) : NO_BINDINGS;
      }
      return bindings;
    };

    const imeClipboard = setupImeClipboardAndFocusListeners({ parent: input.parent, keys });

    let prefixActive = false;
    let prefixRepeatOnly: ReadonlySet<string> | null = null;
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
      get repeatOnly() {
        return prefixRepeatOnly;
      },
      enter(timeoutMs = PREFIX_TIMEOUT_MS, repeatOnly: ReadonlySet<string> | null = null) {
        prefixActive = true;
        prefixRepeatOnly = repeatOnly;
        input.parent.send({
          type: 'PREFIX_MODE_CHANGE',
          active: true,
          repeatOnly: repeatOnly ? [...repeatOnly] : null,
        });
        clearPrefixTimer();
        prefixTimer = setTimeout(() => {
          prefixActive = false;
          prefixRepeatOnly = null;
          prefixTimer = null;
          input.parent.send({ type: 'PREFIX_MODE_CHANGE', active: false });
        }, timeoutMs);
      },
      exit(notify = true) {
        const wasActive = prefixActive;
        prefixActive = false;
        prefixRepeatOnly = null;
        clearPrefixTimer();
        if (notify && wasActive) {
          input.parent.send({ type: 'PREFIX_MODE_CHANGE', active: false });
        }
      },
    };

    let keyTable: string | null = null;
    const setKeyTable = (table: string | null) => {
      if (table === keyTable) return;
      keyTable = table;
      input.parent.send({ type: 'KEY_TABLE_CHANGE', table });
    };

    const runClientKey = (key: ClientKey) => {
      switch (key) {
        case 'left-sidebar':
          return input.parent.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
        case 'right-sidebar':
          return input.parent.send({ type: 'TOGGLE_SIDEBAR', side: 'right' });
        case 'tab-overview':
          return input.parent.send({ type: 'TOGGLE_TAB_OVERVIEW' });
        case 'keys-view':
          return input.parent.send({ type: 'TOGGLE_KEYS_VIEW' });
        case 'tab-left':
          return input.parent.send({ type: 'MOVE_ACTIVE_TAB', by: -1 });
        case 'tab-right':
          return input.parent.send({ type: 'MOVE_ACTIVE_TAB', by: 1 });
      }
    };

    const notifyKeyPress = (event: KeyboardEvent) =>
      input.parent.send({ type: 'KEY_PRESS', key: event.key });

    // A selection over terminal text is already on the clipboard (copied on
    // the release that made it). The next key — Ctrl+C, Cmd+C, a letter —
    // clears the highlight and is processed as typed: Ctrl+C interrupts the
    // shell, a letter goes to the pane, Cmd+C copies the same text again
    // before the highlight goes. A modifier on its own leaves it, so Shift
    // or Cmd pressed on the way to a chord does not lose it.
    const handleKeyDown = (event: KeyboardEvent) => {
      const ctx = keys.get();
      if (!ctx.enabled) return;
      if (isRealFormControl(event.target)) return;
      const selected = !isModifierOnlyKey(event.key) && terminalSelection() !== null;
      try {
        routeKeyDown(event, ctx);
      } finally {
        if (selected) {
          clearNativeSelection();
          imeClipboard.noteSelectionCleared();
        }
      }
    };

    const routeKeyDown = (event: KeyboardEvent, ctx: KeyContext) => {
      if (
        event.key === 'Tab' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        tabWalksChrome(event.target)
      ) {
        return;
      }

      if (imeClipboard.isComposing() || event.isComposing) return;
      if (event.keyCode === 229 && !isTextKey(event)) return;

      const modifierKeys = ['Shift', 'Control', 'Alt', 'Meta'];
      if (modifierKeys.includes(event.key)) return;
      if (event.key === 'Dead') return;
      // Paste keys are the browser's: its paste event types the clipboard.
      if ((event.ctrlKey || event.metaKey) && event.key === 'v') return;
      if (windowShortcut(event) && event.code === 'KeyV') return;

      if (
        handleModalOrCopyKeyDown(event, input.parent, {
          keys: ctx,
          prefixActive: prefixMode.active,
          setPendingCopyText: imeClipboard.setPendingCopyText,
        })
      ) {
        return;
      }

      const replayed = isReplayedPreviewKey(event);

      // Ctrl+Shift+C copies the page's selection, as in a terminal emulator.
      // After the copy keys above, which copy a client selection (select-all,
      // the scroll view) with the same key.
      if (!replayed && windowShortcut(event) && !event.metaKey && event.code === 'KeyC') {
        event.preventDefault();
        document.execCommand('copy');
        return;
      }

      // A replayed chord from an HtmlPreview frame already moved focus back to
      // the pane on the first key, so a second replayed chord while prefix or
      // a sticky key table is armed can only come from the frame reclaiming
      // focus to chain a multi-chord shortcut. Cancel the armed state and drop it.
      if (replayed && (prefixMode.active || keyTable !== null)) {
        prefixMode.exit();
        setKeyTable(null);
        return;
      }

      const runBinding = (binding: string): string | null | undefined => {
        const { command, table } = splitTableSwitch(binding);
        if (command) {
          input.parent.send({ type: 'SEND_TMUX_COMMAND', command: `${ctx.bindingPin}${command}` });
        }
        return table;
      };

      const hiddenInputText = event.target === getMobileInput() && isTextKey(event);
      if (!hiddenInputText) event.preventDefault();

      if (event.key === 'Escape' && ctx.owner.kind === 'float' && keyTable === null) {
        input.parent.send({ type: 'CLOSE_FLOAT', paneId: ctx.owner.paneId });
        return;
      }

      const { prefixKey, repeatTimeMs, prefix, prefixRepeat, root, tables } = currentBindings(
        ctx.keybindings,
      );

      const formattedKey = formatTmuxKey(event);

      if (prefixMode.active && prefixMode.repeatOnly) {
        if (!prefixMode.repeatOnly.has(bindingKeyOf(event))) prefixMode.exit();
      }

      if (formattedKey === prefixKey && !event.repeat) {
        event.preventDefault();
        setKeyTable(null);
        if (prefixMode.active) {
          prefixMode.exit();
          input.parent.send({
            type: 'DISPATCH_OP',
            op: TmuxOp.SendKeys({ target: ctx.target, keys: prefixKey }),
          });
        } else {
          prefixMode.enter();
        }
        notifyKeyPress(event);
        return;
      }

      if (prefixMode.active) {
        event.preventDefault();
        const bindingKey = bindingKeyOf(event);

        const clientKey = CLIENT_KEYS.prefix[bindingKey];
        if (clientKey) {
          runClientKey(clientKey);
          prefixMode.exit();
          notifyKeyPress(event);
          return;
        }

        // `prefix M-y` and `prefix C-o` are bindings of their own (a plugin's
        // `[[keys]]` among them): with Ctrl or Alt held the key is looked up
        // with them first, then bare as it always was.
        const modified = event.ctrlKey || event.altKey ? prefix.get(formattedKey) : undefined;
        const bindingCommand = modified ?? prefix.get(bindingKey);
        if (bindingCommand) {
          const table = runBinding(bindingCommand);
          if (table) {
            prefixMode.exit();
            setKeyTable(table);
          } else if (prefixRepeat.has(bindingKey)) {
            prefixMode.enter(repeatTimeMs, prefixRepeat);
          } else {
            prefixMode.exit();
          }
          notifyKeyPress(event);
          return;
        }

        prefixMode.exit();
        notifyKeyPress(event);
        return;
      }

      if (keyTable !== null) {
        event.preventDefault();
        const bindingKey = bindingKeyOf(event);
        const clientKey = CLIENT_KEYS[keyTable]?.[bindingKey];
        if (event.key === 'Escape') {
          setKeyTable(null);
        } else if (clientKey) {
          runClientKey(clientKey);
          setKeyTable(null);
        } else {
          const binding = tables.get(keyTable)?.get(bindingKey);
          setKeyTable(binding ? (runBinding(binding) ?? null) : null);
        }
        notifyKeyPress(event);
        return;
      }

      if (
        !replayed &&
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        /^[0-9]$/.test(event.key)
      ) {
        if (event.key === '0') {
          input.parent.send({ type: 'TOGGLE_TAB_OVERVIEW' });
        } else {
          input.parent.send({ type: 'SELECT_TAB_BY_POSITION', position: Number(event.key) });
        }
        notifyKeyPress(event);
        return;
      }

      const rootCommand = formattedKey ? root.get(formattedKey) : undefined;
      if (rootCommand) {
        if (replayed && !isSafePreviewRootCommand(rootCommand)) return;
        event.preventDefault();
        const table = runBinding(rootCommand);
        if (table && !replayed) setKeyTable(table);
        notifyKeyPress(event);
        return;
      }

      if (replayed) return;
      if (ctx.owner.kind === 'left') return;
      if (hiddenInputText) return;

      const { target } = ctx;
      let op: TmuxOp;
      if (isTextKey(event)) {
        op = TmuxOp.SendText({ target, text: event.key });
      } else if (formattedKey) {
        op = TmuxOp.SendKeys({ target, keys: formattedKey });
      } else {
        return;
      }
      input.parent.send({ type: 'DISPATCH_OP', op });
      notifyKeyPress(event);
    };

    window.addEventListener('keydown', handleKeyDown);

    const unsubscribe = keys.subscribe((ctx) => {
      imeClipboard.syncKeyboardInputTarget();
      markKeyboardTarget(keyboardMark(ctx));
    });

    return () => {
      unsubscribe();
      imeClipboard.cleanup();
      prefixMode.exit(false);
      window.removeEventListener('keydown', handleKeyDown);
    };
  });
}
