import { fromCallback } from 'xstate';
import type { KeyPressEvent } from '../types';

export interface KeyboardActorInput {
  onKeyPress: (event: KeyPressEvent) => void;
}

/**
 * Keyboard actor - captures and normalizes keyboard events
 *
 * Listens to keydown events and emits KEY_PRESS events to parent.
 * The parent machine handles the prefix mode logic.
 */
export const keyboardActor = fromCallback<never, KeyboardActorInput>(
  ({ input }) => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Always prevent default for our app
      event.preventDefault();
      event.stopImmediatePropagation();

      input.onKeyPress({
        type: 'KEY_PRESS',
        key: event.key,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
      });
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }
);

// ============================================
// Key Mapping Utilities
// ============================================

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
  ' ': 'Space',
};

const PANE_NAV_MAP: Record<string, string> = {
  'C-h': 'L', // select-pane -L
  'C-j': 'D', // select-pane -D
  'C-k': 'U', // select-pane -U
  'C-l': 'R', // select-pane -R
};

const PREFIX_BINDINGS: Record<string, string> = {
  '%': 'split-window -h',
  '"': 'split-window -v',
  c: 'new-window',
  n: 'next-window',
  p: 'previous-window',
  x: 'kill-pane',
  z: 'resize-pane -Z',
  '[': 'copy-mode',
  d: 'detach-client',
  '0': 'select-window -t :0',
  '1': 'select-window -t :1',
  '2': 'select-window -t :2',
  '3': 'select-window -t :3',
  '4': 'select-window -t :4',
  '5': 'select-window -t :5',
  '6': 'select-window -t :6',
  '7': 'select-window -t :7',
  '8': 'select-window -t :8',
  '9': 'select-window -t :9',
  o: 'select-pane -t :.+',
  Up: 'select-pane -U',
  Down: 'select-pane -D',
  Left: 'select-pane -L',
  Right: 'select-pane -R',
  '{': 'swap-pane -U',
  '}': 'swap-pane -D',
  Space: 'next-layout',
};

/**
 * Convert key event to tmux key format
 */
export function formatTmuxKey(event: KeyPressEvent): string {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('C');
  if (event.altKey || event.metaKey) modifiers.push('M');
  if (event.shiftKey && event.key.length > 1) modifiers.push('S');

  const mappedKey = KEY_MAP[event.key];

  if (mappedKey) {
    return modifiers.length > 0 ? `${modifiers.join('-')}-${mappedKey}` : mappedKey;
  } else if (event.key.length === 1) {
    return modifiers.length > 0
      ? `${modifiers.join('-')}-${event.key.toLowerCase()}`
      : event.key;
  }

  return '';
}

/**
 * Check if key is prefix trigger (C-a)
 */
export function isPrefixKey(event: KeyPressEvent): boolean {
  return event.ctrlKey && event.key.toLowerCase() === 'a';
}

/**
 * Check if key is command mode trigger (: or ;)
 */
export function isCommandModeKey(key: string): boolean {
  return key === ':' || key === ';';
}

/**
 * Get pane navigation command if key is a nav key
 */
export function getPaneNavCommand(key: string): string | null {
  const direction = PANE_NAV_MAP[key];
  if (direction) {
    return `select-pane -${direction}`;
  }
  return null;
}

/**
 * Get prefix binding command if key has a binding
 */
export function getPrefixBinding(key: string): string | null {
  return PREFIX_BINDINGS[key] || null;
}
