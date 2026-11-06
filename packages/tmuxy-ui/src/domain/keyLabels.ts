/**
 * Key labels: the key the user presses for an op, one of the client's own
 * keys or a plugin's action, read from the bindings the backend sends (every
 * table: prefix, root and the sticky modes) and from the keys the client
 * answers itself (`CLIENT_KEYS`, `CLIENT_CHORDS`), and spelled the one way the
 * app shows keys (`C-a` → `ctrl+a`, `Up` → `↑`). Menu hints, tooltips, the
 * status line and the keys view all take their labels here, so none of them
 * writes a key down that the config could have moved.
 */

import type { KeyBinding, KeyBindings } from './wire';
import { toTmuxCommand, type TmuxOp } from './commands';
import { boundAction, parseCommandToOp, runShellScript } from './store/parseCommand';
import { CLIENT_CHORDS, CLIENT_KEYS, splitTableSwitch, type ClientKey } from './keyTables';

/** `text`, followed by the key that does it when one is bound: `Zoom (ctrl+a z)`. */
export function withKeyHint(text: string, hint: string | undefined): string {
  return hint ? `${text} (${hint})` : text;
}

/** Special key display mappings */
const KEY_DISPLAY: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Space: 'Space',
  BSpace: 'BS',
  Enter: '↵',
  Escape: 'Esc',
  Tab: 'Tab',
};

const MODIFIERS: Record<string, string> = { C: 'ctrl', M: 'alt', S: 'shift' };

/** A tmux key name as the app shows it: `C-a` → `ctrl+a`, `M-Up` → `alt+↑`, `BSpace` → `BS`. */
export function formatKey(key: string): string {
  const modifiers: string[] = [];
  let rest = key;
  for (let m = rest.match(/^([CMS])-(.+)$/); m; m = rest.match(/^([CMS])-(.+)$/)) {
    modifiers.push(MODIFIERS[m[1]]);
    rest = m[2];
  }
  // tmux reads C-A as C-a.
  const base = KEY_DISPLAY[rest] ?? (modifiers.includes('ctrl') ? rest.toLowerCase() : rest);
  return [...modifiers, base].join('+');
}

/** Every table's bindings, prefix first, then root, then the sticky modes. */
function tables(keybindings: KeyBindings): Array<[string, readonly KeyBinding[]]> {
  return [
    ['prefix', keybindings.prefix_bindings],
    ['root', keybindings.root_bindings],
    ...Object.entries(keybindings.tables),
  ];
}

/**
 * A key of `table` as the user types it: a root key alone, a prefix key after
 * the prefix, a mode's key after the prefix key that enters the mode
 * (`ctrl+a p S`). Undefined for a mode no prefix key enters.
 */
export function tableKeyLabel(
  keybindings: KeyBindings,
  table: string,
  key: string,
): string | undefined {
  if (table === 'root') return formatKey(key);
  const prefix = formatKey(keybindings.prefix_key);
  if (table === 'prefix') return `${prefix} ${formatKey(key)}`;
  const entry = keybindings.prefix_bindings.find((b) => {
    const { command, table: entered } = splitTableSwitch(b.command);
    return entered === table && command === '';
  });
  return entry ? `${prefix} ${formatKey(entry.key)} ${formatKey(key)}` : undefined;
}

const actions = new Map<string, string>();

/**
 * What a command does, in the one spelling ops and bindings are compared in:
 * parsed to its op and spelled back out (so a binding to `kill-window` is the
 * close-tab op, whose own command ends in the stash sweep), and a bundled
 * script named by its file and verb (so `tmuxy-stack-toggle`, expanded by
 * `list-keys` with whatever path and target, is the stack toggle).
 */
function actionOf(command: string): string {
  let action = actions.get(command);
  if (action === undefined) {
    const spelled = toTmuxCommand(parseCommandToOp(boundAction(command)));
    const script = runShellScript(spelled);
    action = script ? `script ${script.name} ${script.args[0] ?? ''}` : spelled;
    // Ops carry pane and window ids, so the commands asked about never stop
    // changing; a small cache is all a menu or the status line needs.
    if (actions.size > 512) actions.clear();
    actions.set(command, action);
  }
  return action;
}

/** The keys of `table` bound to `op`, as tmux names them (`h`, `C-l`), in binding order. */
export function tableKeysFor(keybindings: KeyBindings | null, table: string, op: TmuxOp): string[] {
  if (!keybindings) return [];
  const wanted = actionOf(toTmuxCommand(op));
  const bindings = tables(keybindings).find(([name]) => name === table)?.[1] ?? [];
  return bindings.filter((b) => actionOf(b.command) === wanted).map((b) => b.key);
}

/**
 * The key hint for an op: the first binding, in any table, whose command is
 * the op's own, so an item and its hint cannot disagree. Undefined when
 * nothing is bound to it.
 */
export function keyHint(keybindings: KeyBindings | null, op: TmuxOp): string | undefined {
  if (!keybindings) return undefined;
  for (const [table] of tables(keybindings)) {
    for (const key of tableKeysFor(keybindings, table, op)) {
      const label = tableKeyLabel(keybindings, table, key);
      if (label) return label;
    }
  }
  return undefined;
}

/** The key hint for one of the client's own keys: its chord, else its key in a table. */
export function clientKeyHint(
  keybindings: KeyBindings | null,
  clientKey: ClientKey,
): string | undefined {
  const chord = CLIENT_CHORDS[clientKey];
  if (chord || !keybindings) return chord;
  for (const [table, keys] of Object.entries(CLIENT_KEYS)) {
    for (const [key, bound] of Object.entries(keys)) {
      if (bound !== clientKey) continue;
      const label = tableKeyLabel(keybindings, table, key);
      if (label) return label;
    }
  }
  return undefined;
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
  for (const [table, bindings] of tables(keybindings)) {
    const binding = bindings.find((b) => ours(b.command));
    const label = binding && tableKeyLabel(keybindings, table, binding.key);
    if (label) return label;
  }
  return undefined;
}
