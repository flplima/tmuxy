/**
 * Key formatting, key-table classification, and text-vs-chord detection for
 * keyboardActor.
 */

import { getMobileInput } from '../../../utils/mobileKeyboard';
import { isPlaceholderId, type PaneId } from '../../../domain/ids';

export const KEY_MAP: Record<string, string> = {
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
 * The tmux name a key is bound under in a key table: DOM names mapped to
 * tmux's, and a shifted character as the character — automation (and some
 * browsers) report Shift+' as `'` with shiftKey set rather than as `"`.
 */
export function bindingKeyOf(event: KeyboardEvent): string {
  const SHIFTED: Record<string, string> = {
    "'": '"', // Shift+' = " (horizontal split)
    '5': '%', // Shift+5 = % (vertical split)
    '7': '&', // Shift+7 = & (kill window)
    '1': '!', // Shift+1 = ! (break pane)
    '[': '{', // Shift+[ = { (swap pane up)
    ']': '}', // Shift+] = } (swap pane down)
    '/': '?', // Shift+/ = ? (the keys view)
    ';': ':', // Shift+; = : (command prompt)
    ',': '<', // Shift+, = < (swap left)
    '.': '>', // Shift+. = > (swap right)
    '\\': '|', // Shift+\ = | (split right)
  };
  if (event.shiftKey && SHIFTED[event.key]) return SHIFTED[event.key];
  return KEY_MAP[event.key] ?? event.key;
}

/**
 * Keys the client answers itself, by table: what they open has no tmux window
 * or pane behind it (a sidebar's open/fixed state, the Tab Overview, the keys
 * view), so there is no binding for tmux to run.
 */
export type ClientKey =
  | 'left-sidebar'
  | 'right-sidebar'
  | 'tab-overview'
  | 'keys-view'
  | 'tab-left'
  | 'tab-right';

export const CLIENT_KEYS: Record<string, Record<string, ClientKey>> = {
  prefix: { s: 'left-sidebar', S: 'right-sidebar', w: 'tab-overview', '?': 'keys-view' },
  tab: { o: 'tab-overview', '<': 'tab-left', '>': 'tab-right' },
};

/**
 * macOS Option+key produces special Unicode characters instead of altKey=true.
 * This maps those characters back to their base keys for tmux M- notation.
 */
export const MACOS_OPTION_KEY_MAP: Record<string, string> = {
  '˙': 'h', // Option+H
  '∆': 'j', // Option+J
  '˚': 'k', // Option+K
  '¬': 'l', // Option+L
};

function charCount(s: string): number {
  return Array.from(s).length;
}

/**
 * True when the keydown carries literal text the user typed, rather than a
 * chord to be forwarded as a tmux key name.
 */
export function isTextKey(event: KeyboardEvent): boolean {
  if (charCount(event.key) !== 1) return false;
  if (MACOS_OPTION_KEY_MAP[event.key]) return false;
  if (event.getModifierState?.('AltGraph')) return true;
  if (event.ctrlKey || event.metaKey) return false;
  if (event.altKey) return event.key.codePointAt(0)! > 0x7f;
  return true;
}

export function formatTmuxKey(event: KeyboardEvent): string {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('C');
  if (event.altKey || event.metaKey) modifiers.push('M');
  if (event.shiftKey && event.key.length > 1) modifiers.push('S');

  const macosKey = MACOS_OPTION_KEY_MAP[event.key];
  if (macosKey) {
    return `M-${macosKey}`;
  }

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

/** The DOM key a tmux key name stands for: `formatTmuxKey`'s map, inverted. */
const DOM_KEY_OF: Record<string, string> = Object.fromEntries(
  Object.entries(KEY_MAP).map(([dom, tmux]) => [tmux, dom]),
);

/**
 * The keydown that `formatTmuxKey` would name `name` — the prefix key from
 * the bindings (`C-a`, `M-Space`, `F12`), pressed from the phone's key row as
 * though typed. Null for a name no keydown produces.
 */
export function keyEventInitOf(name: string): KeyboardEventInit | null {
  const init = { ctrlKey: false, altKey: false, shiftKey: false };
  let rest = name;
  while (
    rest.length > 2 &&
    rest[1] === '-' &&
    (rest[0] === 'C' || rest[0] === 'M' || rest[0] === 'S')
  ) {
    if (rest[0] === 'C') init.ctrlKey = true;
    else if (rest[0] === 'M') init.altKey = true;
    else init.shiftKey = true;
    rest = rest.slice(2);
  }
  if (rest === 'BTab') return { ...init, key: 'Tab', shiftKey: true };
  const key = DOM_KEY_OF[rest] ?? rest;
  if (key.length !== 1 && !DOM_KEY_OF[rest]) return null;
  return { ...init, key };
}

/**
 * Placeholder pane ids (`__placeholder_*`) are client-side predictions from the
 * optimistic store — tmux has never heard of them. Until the placeholder
 * reconciles to a real `%N`, fall back to null.
 */
export function realPaneId(id: PaneId | null): PaneId | null {
  return id !== null && isPlaceholderId(id) ? null : id;
}

/**
 * The modifier shape the app's own window/selection shortcuts wear: bare Cmd on
 * a Mac, Ctrl+Shift elsewhere.
 */
export function windowShortcut(event: KeyboardEvent): boolean {
  if (event.altKey) return false;
  if (event.metaKey) return !event.ctrlKey && !event.shiftKey;
  return event.ctrlKey && event.shiftKey;
}

/**
 * A key that only changes what the NEXT key means.
 */
export function isModifierOnlyKey(key: string): boolean {
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

export function isRealFormControl(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    element !== null &&
    (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') &&
    element !== getMobileInput()
  );
}
