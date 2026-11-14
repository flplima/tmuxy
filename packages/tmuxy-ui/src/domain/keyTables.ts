/**
 * Key tables beyond prefix and root: the sticky modes a binding enters with
 * tmux's own `switch-client -T <table>` (PANE on `prefix p`, TAB on
 * `prefix t`).
 *
 * The client answers keys itself — it is the one holding the keyboard — so a
 * table switch never goes to tmux: it is read out of the binding and kept as
 * client state, and the rest of the binding is what gets sent. A table stays
 * active for as long as each key's binding enters it again, which is how tmux
 * itself makes a table sticky; a binding that names no table, `esc`, or a key
 * the table does not bind leaves it.
 */

import { list } from './commandHelpers';
import { commandListParts } from './store/parseCommand';

const TABLE_SWITCH = /^(?:switch-client|switchc)\b.*\s-T\s+(\S+)/;

/**
 * A binding with its table switch taken out: `command` is what is left to
 * send (empty when the binding only switched), `table` the table it enters —
 * null for `root`, which is leaving every table — and undefined when it names
 * none.
 */
export function splitTableSwitch(command: string): {
  command: string;
  table: string | null | undefined;
} {
  let table: string | null | undefined;
  const rest: string[] = [];
  for (const part of commandListParts(command)) {
    const named = part.match(TABLE_SWITCH)?.[1];
    if (named === undefined) rest.push(part);
    else table = named === 'root' ? null : named;
  }
  return { command: list(rest), table };
}

/**
 * Keys the client answers itself, by table: what they open has no tmux window
 * or pane behind it (a sidebar's open/fixed state, the Tab Overview, the keys
 * view), so there is no binding for tmux to run. The keyboard actor runs them;
 * the key labels name them.
 */
export type ClientKey =
  | 'left-sidebar'
  | 'right-sidebar'
  | 'tab-overview'
  | 'keys-view'
  | 'tab-left'
  | 'tab-right'
  | 'command-palette'
  | 'go-to';

export const CLIENT_KEYS: Record<string, Record<string, ClientKey>> = {
  prefix: {
    s: 'left-sidebar',
    S: 'right-sidebar',
    w: 'tab-overview',
    '?': 'keys-view',
    P: 'command-palette',
    g: 'go-to',
  },
  tab: { o: 'tab-overview', '<': 'tab-left', '>': 'tab-right' },
};

/**
 * Client keys on keys tmux binds nothing to by default. A binding found on
 * one is the user's own or a plugin's, and it wins: the client answers the
 * key only while the table has none.
 */
const YIELDING_CLIENT_KEYS: ReadonlySet<ClientKey> = new Set(['command-palette', 'go-to']);

/** The client key `key` of `table` runs; `bound` says the table has a binding on it. */
export function clientKeyFor(table: string, key: string, bound: boolean): ClientKey | undefined {
  const clientKey = CLIENT_KEYS[table]?.[key];
  if (clientKey && bound && YIELDING_CLIENT_KEYS.has(clientKey)) return undefined;
  return clientKey;
}

/**
 * The chords the keyboard actor answers before any table: ctrl+0 opens the
 * Tab Overview, ctrl+1-9 picks a tab by its position in the strip
 * (`TAB_POSITION_CHORDS`), and ctrl+shift+p (cmd+shift+p too) opens the
 * command palette.
 */
export const CLIENT_CHORDS: Partial<Record<ClientKey, string>> = {
  'tab-overview': 'ctrl+0',
  'command-palette': 'ctrl+shift+p',
};
export const TAB_POSITION_CHORDS = 'ctrl+1-9';
