/**
 * The keys view (`prefix ?`): every binding the config has, table by table —
 * the prefix, each sticky table (PANE, TAB, …) and the chords that need no
 * prefix. The status line shows a handful per mode; this is the rest.
 *
 * Drawn over the pane area on a blurred scrim. `esc` or `q` closes it (the
 * keyboard actor), as does a click outside the list.
 */

import { useAppSelector, useAppSend } from '../machines/appHooks';
import { selectKeyBindings } from '../machines/selectors/ui';
import { formatPrefixKey } from './menus/keybindingLabel';
import { splitTableSwitch } from '../domain/keyTables';
import type { KeyBindings } from '../domain/wire';
import './KeysView.css';

type Binding = KeyBindings['prefix_bindings'][number];

/**
 * What a binding does, in words: the server's description when it has one of
 * its own, else the command — with a sticky table's `switch-client -T` left
 * out, since every key of a table has it.
 */
function bindingText(binding: Binding): string {
  if (binding.description && binding.description !== binding.command) return binding.description;
  const { command, table } = splitTableSwitch(binding.command);
  return command || (table ? `${table.toUpperCase()} mode` : binding.command);
}

function Section({ title, bindings }: { title: string; bindings: readonly Binding[] }) {
  if (bindings.length === 0) return null;
  return (
    <section className="keys-view-section">
      <h3 className="keys-view-title">{title}</h3>
      <dl className="keys-view-list">
        {bindings.map((b) => (
          <div key={b.key} className="keys-view-row">
            <dt>
              <kbd>{b.key}</kbd>
            </dt>
            <dd>{bindingText(b)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function KeysView() {
  const open = useAppSelector((ctx) => ctx.keysViewOpen);
  const keybindings = useAppSelector(selectKeyBindings);
  const send = useAppSend();
  if (!open || !keybindings) return null;

  const prefix = formatPrefixKey(keybindings.prefix_key);
  return (
    <div className="keys-view" data-testid="keys-view" role="dialog" aria-label="Keys">
      <div className="keys-view-scrim" onClick={() => send({ type: 'TOGGLE_KEYS_VIEW' })} />
      <div className="keys-view-panel">
        <Section title={`PREFIX · ${prefix}, then`} bindings={keybindings.prefix_bindings} />
        {Object.entries(keybindings.tables).map(([name, bindings]) => (
          <Section key={name} title={name.toUpperCase()} bindings={bindings} />
        ))}
        <Section title="Without the prefix" bindings={keybindings.root_bindings} />
      </div>
    </div>
  );
}
