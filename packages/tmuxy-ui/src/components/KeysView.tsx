/**
 * The keys view (`prefix ?`): every binding the config has, table by table.
 * `esc` or `q` closes it (the keyboard actor), as does a click outside the list.
 */

import { useAppSelector, useAppSend } from '../machines/appHooks';
import { selectKeyBindings } from '../machines/selectors/ui';
import { formatKey } from '../domain/keyLabels';
import { splitTableSwitch } from '../domain/keyTables';
import type { KeyBindings } from '../domain/wire';
import './KeysView.css';

type Binding = KeyBindings['prefix_bindings'][number];

/** The server's description, else the command without the sticky table's `switch-client -T`, which every key of a table has. */
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
              <kbd>{formatKey(b.key)}</kbd>
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

  const prefix = formatKey(keybindings.prefix_key);
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
