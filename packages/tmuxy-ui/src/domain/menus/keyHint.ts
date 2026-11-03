import type { KeyBindings } from '../wire';
import { toTmuxCommand, type TmuxOp } from '../commands';
import { parseCommandToOp } from '../store/parseCommand';
import {
  formatBindingKey,
  formatPrefixKey,
  getKeybindingLabel,
} from '../../components/menus/keybindingLabel';

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
  if (prefixed)
    return `${formatPrefixKey(keybindings.prefix_key)} ${formatBindingKey(prefixed.key)}`;
  const root = keybindings.root_bindings.find((b) => ours(b.command));
  return root ? formatBindingKey(root.key) : undefined;
}
