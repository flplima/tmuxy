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

/** `switch-client -T <table>` (or `switchc`), with the table it names. */
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
