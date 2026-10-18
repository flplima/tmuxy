/**
 * Keyboard Actor - Formats DOM keyboard events into tmux key syntax and
 * dispatches prefix, sticky key-table, root, and literal/keystroke ops.
 */

import { fromCallback, type AnyActorRef } from 'xstate';
import type { KeyBindings } from '../../domain/wire';
import { getMobileInput } from '../../utils/mobileKeyboard';
import { pinPrefix, TmuxOp } from '../../domain/commands';
import { splitTableSwitch } from '../../domain/keyTables';
import { tabWalksChrome } from '../../utils/chromeTab';
import type { PaneId } from '../../domain/ids';
import {
  bindingKeyOf,
  CLIENT_KEYS,
  type ClientKey,
  formatTmuxKey,
  isRealFormControl,
  isTextKey,
  realPaneId,
  SIDEBAR_REPEAT_MS,
  STICKY_CLIENT_KEYS,
} from './keyboard/keyFormatting';
import { handleModalOrCopyKeyDown, readLiveSnapshot } from './keyboard/modalAndCopyKeys';
import { setupImeClipboardAndFocusListeners } from './keyboard/imeAndClipboard';

export type KeyboardActorEvent =
  | { type: 'UPDATE_SESSION'; sessionName: string }
  | { type: 'UPDATE_ACTIVE_PANE'; paneId: PaneId | null }
  | { type: 'UPDATE_KEYBINDINGS'; keybindings: KeyBindings }
  | { type: 'UPDATE_ENABLED'; enabled: boolean }
  | { type: 'UPDATE_FOCUSED_FLOAT'; paneId: PaneId | null }
  | { type: 'UPDATE_LEFT_SIDEBAR_FOCUSED'; focused: boolean }
  | { type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED'; paneId: PaneId | null };

export interface KeyboardActorInput {
  parent: AnyActorRef;
}

const PREFIX_TIMEOUT_MS = 8000;

export function createKeyboardActor() {
  return fromCallback<KeyboardActorEvent, KeyboardActorInput>(({ input, receive }) => {
    let sessionName = 'tmuxy';
    let activePaneId: PaneId | null = null;
    let focusedFloatPaneId: PaneId | null = null;
    let leftSidebarFocused = false;
    let focusedRightSidebarPaneId: PaneId | null = null;
    const overlayPaneId = (): PaneId | null => focusedFloatPaneId ?? focusedRightSidebarPaneId;
    let enabled = true;

    let prefixKey = 'C-a';
    let prefixBindings: Map<string, string> = new Map();
    let prefixRepeatKeys: Set<string> = new Set();
    let rootBindings: Map<string, string> = new Map();
    let tableBindings: Map<string, Map<string, string>> = new Map();

    const keyTarget = (): string => {
      const overlay = overlayPaneId();
      if (overlay) return realPaneId(overlay) ?? sessionName;
      return realPaneId(activePaneId) ?? sessionName;
    };

    const imeClipboard = setupImeClipboardAndFocusListeners({
      parent: input.parent,
      isEnabled: () => enabled,
      isLeftSidebarFocused: () => leftSidebarFocused,
      getSessionName: () => sessionName,
      getActivePaneId: () => activePaneId,
      getOverlayPaneId: overlayPaneId,
      getKeyTarget: keyTarget,
    });

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
          return input.parent.send({ type: 'SIDEBAR_KEY', side: 'left' });
        case 'right-sidebar':
          return input.parent.send({ type: 'SIDEBAR_KEY', side: 'right' });
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

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!enabled) return;
      if (isRealFormControl(event.target)) return;
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
      if ((event.ctrlKey || event.metaKey) && event.key === 'v') return;

      const snap = readLiveSnapshot(input.parent, activePaneId);

      if (
        handleModalOrCopyKeyDown(event, input.parent, {
          snap,
          overlayPaneId: overlayPaneId(),
          leftSidebarFocused,
          prefixActive: prefixMode.active,
          setPendingCopyText: imeClipboard.setPendingCopyText,
        })
      ) {
        return;
      }

      const bindingPin = (): string => {
        if (overlayPaneId()) return pinPrefix(null, realPaneId(overlayPaneId()));
        let pane = realPaneId(snap.liveActivePaneId);
        const windowId =
          snap.liveActiveWindowId ??
          snap.livePanes.find((p) => p.tmuxId === pane)?.windowId ??
          null;
        if (windowId) {
          const inWindow = (id: PaneId | null) =>
            id !== null && snap.livePanes.some((p) => p.tmuxId === id && p.windowId === windowId);
          if (!inWindow(pane)) {
            pane = realPaneId(
              snap.livePanes.find((p) => p.windowId === windowId && p.active)?.tmuxId ?? null,
            );
          }
          return pinPrefix(windowId, pane);
        }
        return pinPrefix(null, pane);
      };

      const runBinding = (binding: string): string | null | undefined => {
        const { command, table } = splitTableSwitch(binding);
        if (command) {
          input.parent.send({ type: 'SEND_TMUX_COMMAND', command: `${bindingPin()}${command}` });
        }
        return table;
      };

      const hiddenInputText = event.target === getMobileInput() && isTextKey(event);
      if (!hiddenInputText) event.preventDefault();

      if (event.key === 'Escape' && focusedFloatPaneId && keyTable === null) {
        input.parent.send({ type: 'CLOSE_FLOAT', paneId: focusedFloatPaneId });
        return;
      }

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
            op: TmuxOp.SendKeys({ target: keyTarget(), keys: prefixKey }),
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
          if (clientKey === 'left-sidebar' || clientKey === 'right-sidebar') {
            prefixMode.enter(SIDEBAR_REPEAT_MS, new Set([bindingKey]));
          } else {
            prefixMode.exit();
          }
          notifyKeyPress(event);
          return;
        }

        const bindingCommand = prefixBindings.get(bindingKey);
        if (bindingCommand) {
          const table = runBinding(bindingCommand);
          if (table) {
            prefixMode.exit();
            setKeyTable(table);
          } else if (prefixRepeatKeys.has(bindingKey)) {
            prefixMode.enter();
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
          if (!STICKY_CLIENT_KEYS.has(clientKey)) setKeyTable(null);
        } else {
          const binding = tableBindings.get(keyTable)?.get(bindingKey);
          setKeyTable(binding ? (runBinding(binding) ?? null) : null);
        }
        notifyKeyPress(event);
        return;
      }

      if (event.ctrlKey && !event.altKey && !event.metaKey && /^[0-9]$/.test(event.key)) {
        if (event.key === '0') {
          input.parent.send({ type: 'TOGGLE_TAB_OVERVIEW' });
        } else {
          input.parent.send({ type: 'SELECT_TAB_BY_POSITION', position: Number(event.key) });
        }
        notifyKeyPress(event);
        return;
      }

      const rootCommand = formattedKey ? rootBindings.get(formattedKey) : undefined;
      if (rootCommand) {
        event.preventDefault();
        const table = runBinding(rootCommand);
        if (table) setKeyTable(table);
        notifyKeyPress(event);
        return;
      }

      if (leftSidebarFocused) return;
      if (hiddenInputText) return;

      const overlay = overlayPaneId();
      const target = overlay
        ? (realPaneId(overlay) ?? sessionName)
        : (realPaneId(snap.liveActivePaneId) ?? sessionName);
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

    receive((event) => {
      if (event.type === 'UPDATE_SESSION') {
        sessionName = event.sessionName;
      } else if (event.type === 'UPDATE_ACTIVE_PANE') {
        activePaneId = event.paneId;
        imeClipboard.syncKeyboardInputTarget();
      } else if (event.type === 'UPDATE_KEYBINDINGS') {
        const kb = event.keybindings;
        prefixKey = kb.prefix_key;
        prefixBindings = new Map(kb.prefix_bindings.map((b) => [b.key, b.command]));
        prefixRepeatKeys = new Set(kb.prefix_bindings.filter((b) => b.repeat).map((b) => b.key));
        rootBindings = new Map(kb.root_bindings.map((b) => [b.key, b.command]));
        tableBindings = new Map(
          Object.entries(kb.tables).map(([name, bindings]) => [
            name,
            new Map(bindings.map((b) => [b.key, b.command])),
          ]),
        );
      } else if (event.type === 'UPDATE_ENABLED') {
        enabled = event.enabled;
      } else if (event.type === 'UPDATE_FOCUSED_FLOAT') {
        focusedFloatPaneId = event.paneId;
        imeClipboard.syncKeyboardInputTarget();
      } else if (event.type === 'UPDATE_LEFT_SIDEBAR_FOCUSED') {
        leftSidebarFocused = event.focused;
      } else if (event.type === 'UPDATE_RIGHT_SIDEBAR_FOCUSED') {
        focusedRightSidebarPaneId = event.paneId;
        imeClipboard.syncKeyboardInputTarget();
      }
    });

    return () => {
      imeClipboard.cleanup();
      prefixMode.exit(false);
      window.removeEventListener('keydown', handleKeyDown);
    };
  });
}
