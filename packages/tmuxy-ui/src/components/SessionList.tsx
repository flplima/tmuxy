/**
 * SessionList — the way back in once detached: the session switcher's own
 * list (`sessionSwitcherSpec`), drawn as buttons on the overlay rather than as
 * a dropdown, since there is no status line to hang one from. Picking a
 * session attaches to it, a restorable one is rebuilt first, and a server is
 * connected to — the switcher's own events, through the menus' dispatch.
 *
 * Connecting to a new server opens a float, which takes an attached session,
 * so that item is the status line's switcher's alone.
 */

import { useAppSelector } from '../machines/appHooks';
import { sessionSwitcherSpec } from '../domain/menus/sessionSwitcher';
import type { MenuNode } from '../domain/menus/spec';
import { useMenuDispatch } from './menus/SpecMenu';
import { useMenuEnv } from './menus/menuEnv';
import './SessionList.css';

type Item = Extract<MenuNode, { kind: 'item' }>;
type Group = { label: string; items: Item[] };

/** The spec's headers and the items under each, the connect item left out. */
function groupsOf(spec: ReadonlyArray<MenuNode>): Group[] {
  const groups: Group[] = [];
  for (const node of spec) {
    if (node.kind === 'header') groups.push({ label: node.label, items: [] });
    else if (node.kind === 'item' && node.id !== 'session-connect') {
      groups[groups.length - 1]?.items.push(node);
    }
  }
  return groups.filter((g) => g.items.length > 0);
}

export function SessionList() {
  const env = useMenuEnv();
  const groups = useAppSelector((ctx) => groupsOf(sessionSwitcherSpec(ctx, env)));
  const dispatch = useMenuDispatch();

  return (
    <div className="session-list">
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h2 className="session-list-header">{group.label}</h2>
          <ul>
            {group.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`session-list-item${item.className ? ` ${item.className}` : ''}`}
                  data-testid={item.testId}
                  onClick={() => dispatch(item.action)}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
