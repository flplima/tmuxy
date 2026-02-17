/**
 * keybindingLabel - Format tmux keybinding labels for menu display
 *
 * Looks up a binding key from keybindings.prefix_bindings by matching the command field,
 * then formats the prefix key for display (e.g., "C-b %" → "^B %").
 */

import type { KeyBindings } from '../../machines/types';

/** Special key display mappings */
const KEY_DISPLAY: Record<string, string> = {
  Up: '\u2191',
  Down: '\u2193',
  Left: '\u2190',
  Right: '\u2192',
  Space: 'Space',
  BSpace: 'BS',
  Enter: '\u21B5',
  Escape: 'Esc',
  Tab: 'Tab',
};

/**
 * Format a prefix key for display: "C-b" → "^B", "C-a" → "^A"
 */
function formatPrefixKey(prefixKey: string): string {
  const match = prefixKey.match(/^C-(.)/);
  if (match) {
    return '^' + match[1].toUpperCase();
  }
  return prefixKey;
}

/**
 * Format a binding key for display
 */
function formatBindingKey(key: string): string {
  return KEY_DISPLAY[key] ?? key;
}

/**
 * Look up a keybinding label for a tmux command.
 * Returns formatted string like "^B %" or undefined if no binding found.
 */
export function getKeybindingLabel(keybindings: KeyBindings | null, command: string): string | undefined {
  if (!keybindings) return undefined;

  const binding = keybindings.prefix_bindings.find(b => b.command === command);
  if (!binding) return undefined;

  const prefix = formatPrefixKey(keybindings.prefix_key);
  const key = formatBindingKey(binding.key);
  return `${prefix} ${key}`;
}
