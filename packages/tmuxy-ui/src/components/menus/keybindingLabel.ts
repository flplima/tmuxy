/**
 * keybindingLabel - Format tmux keybinding labels for menu display
 *
 * Looks up a binding key from keybindings.prefix_bindings by matching the command field,
 * then formats the prefix key for display (e.g., "C-b %" → "ctrl+b %").
 */

import type { KeyBindings } from '../../domain/wire';

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
 * Format a prefix key for display: "C-b" → "ctrl+b", "C-a" → "ctrl+a"
 */
export function formatPrefixKey(prefixKey: string): string {
  const match = prefixKey.match(/^C-(.)/);
  if (match) {
    return 'ctrl+' + match[1].toLowerCase();
  }
  return prefixKey;
}

/**
 * Format a binding key for display
 */
function formatBindingKey(key: string): string {
  return KEY_DISPLAY[key] ?? key;
}

/** `-c "#{pane_current_path}"`, in any of the quotings `list-keys` prints it with. */
const CURRENT_PATH_FLAG =
  /\s+-c\s+(?:"#\{pane_current_path\}"|'#\{pane_current_path\}'|#\{pane_current_path\})/g;

/** `confirm-before`'s own flags, ahead of the command it asks about. */
const CONFIRM_BEFORE =
  /^confirm-before(?:\s+-[by])*(?:\s+-[pct]\s+(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+))*\s+/;

/**
 * What a bound command does, for matching it to a menu item's: a split or a
 * new window that starts in the pane's directory is still that split or
 * window, and a kill that asks first (tmux's own `x`) is still that kill.
 */
export function boundAction(command: string): string {
  let action = command.trim();
  const confirm = action.match(CONFIRM_BEFORE);
  if (confirm) {
    action = action.slice(confirm[0].length).trim();
    const quoted = action.match(/^"(.*)"$|^'(.*)'$/);
    if (quoted) action = quoted[1] ?? quoted[2];
  }
  return action.replace(CURRENT_PATH_FLAG, '').trim();
}

/**
 * Look up a keybinding label for a tmux command.
 * Returns formatted string like "ctrl+b %" or undefined if no binding found.
 */
export function getKeybindingLabel(
  keybindings: KeyBindings | null,
  command: string,
): string | undefined {
  if (!keybindings) return undefined;

  const binding = keybindings.prefix_bindings.find((b) => boundAction(b.command) === command);
  if (!binding) return undefined;

  const prefix = formatPrefixKey(keybindings.prefix_key);
  const key = formatBindingKey(binding.key);
  return `${prefix} ${key}`;
}
