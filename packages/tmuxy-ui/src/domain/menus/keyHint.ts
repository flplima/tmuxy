/**
 * Key hints: the binding a menu item's op is bound to, formatted for display
 * (`C-b %` → `ctrl+b %`), looked up in the bindings the backend sends.
 */

import type { KeyBindings } from '../wire';
import { toTmuxCommand, type TmuxOp } from '../commands';
import { parseCommandToOp } from '../store/parseCommand';

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
export function formatBindingKey(key: string): string {
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

/** A prefix-table key as the menus show it: `ctrl+a x`. */
function prefixedLabel(keybindings: KeyBindings, key: string): string {
  return `${formatPrefixKey(keybindings.prefix_key)} ${formatBindingKey(key)}`;
}

/**
 * Look up a keybinding label for a tmux command.
 * Returns formatted string like "ctrl+b %" or undefined if no binding found.
 * `normalize` puts a bound action into the spelling `command` is in.
 */
export function getKeybindingLabel(
  keybindings: KeyBindings | null,
  command: string,
  normalize: (action: string) => string = (action) => action,
): string | undefined {
  if (!keybindings) return undefined;

  const binding = keybindings.prefix_bindings.find(
    (b) => normalize(boundAction(b.command)) === command,
  );
  return binding ? prefixedLabel(keybindings, binding.key) : undefined;
}

/**
 * The key hint for an op: the binding whose command is the op's own, so an
 * item and its hint cannot disagree. Undefined when nothing is bound to it.
 *
 * A bound command is compared as the op it parses to, spelled back out: a
 * binding to `kill-window` is the close-tab op even though the op's own
 * command ends in the stash sweep the binding does not spell.
 */
export function keyHint(keybindings: KeyBindings | null, op: TmuxOp): string | undefined {
  return getKeybindingLabel(keybindings, toTmuxCommand(op), (action) =>
    toTmuxCommand(parseCommandToOp(action)),
  );
}

/**
 * The key a plugin's `[[keys]]` entry bound to its action, when tmux has it:
 * a binding is a plugin key by its `--trigger key` (`plugins::keys`), and
 * names its action as `plugin action <plugin>:<id> `.
 */
export function pluginKeyHint(
  keybindings: KeyBindings | null,
  plugin: string,
  action: string,
): string | undefined {
  if (!keybindings) return undefined;
  const ours = (command: string) =>
    command.includes('--trigger key') && command.includes(`plugin action ${plugin}:${action} `);
  const prefixed = keybindings.prefix_bindings.find((b) => ours(b.command));
  if (prefixed) return prefixedLabel(keybindings, prefixed.key);
  const root = keybindings.root_bindings.find((b) => ours(b.command));
  return root ? formatBindingKey(root.key) : undefined;
}
