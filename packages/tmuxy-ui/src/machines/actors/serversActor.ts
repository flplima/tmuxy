/**
 * serversActor — poll that feeds the sidebar's sessions→tabs→panes tree.
 *
 * The live tmux state the app holds is single-session (the attached session's
 * windows/panes). To show *every* session on the current tmux socket, this
 * actor periodically shells `list-windows -a` / `list-panes -a` through the
 * adapter (`run_tmux_command`, which returns stdout on web and desktop alike),
 * parses the result into {@link SessionTreeNode}s, and sends `SESSIONS_UPDATED`
 * to the parent machine. This runs on the web build too — a web client attached
 * to a multi-session socket now sees and can switch to its sibling sessions.
 *
 * The active session's subtree is still drawn from live state by SidebarTree;
 * this poll supplies the *other* sessions, so a ~1.5s refresh lag on them is
 * fine.
 *
 * The saved-server list (which drives the desktop ServerPicker) is the only
 * Tauri-gated part — see {@link createServersActor}.
 */
import { fromCallback, type AnyActorRef } from 'xstate';
import type { TmuxAdapter } from '../../tmux/types';
import type { SessionTreeNode, ServerInfo } from '../types';
import { isTauri } from '../../tmux/adapters';

export type ServersActorEvent = { type: 'REFRESH_SESSIONS' };

export interface ServersActorInput {
  parent: AnyActorRef;
}

const POLL_INTERVAL_MS = 1500;

/** Field separator embedded in the tmux `-F` format (a literal tab). */
const SEP = '\t';

/** tmux window types that are tmuxy-internal chrome, hidden from the tree. */
const HIDDEN_WINDOW_TYPES = new Set(['float', 'float-backdrop', 'group', 'sidebar']);

// One `list-windows -a` / `list-panes -a` row, tab-joined. `#{@tmuxy-window-type}`
// is empty for foreign (e.g. vanilla-tmux) windows — those are kept as tabs.
const WINDOWS_FORMAT = `#{session_name}${SEP}#{window_id}${SEP}#{window_index}${SEP}#{window_name}${SEP}#{@tmuxy-window-type}`;
const PANES_FORMAT = `#{session_name}${SEP}#{window_id}${SEP}#{pane_id}${SEP}#{pane_current_command}${SEP}#{pane_active}`;

export const LIST_WINDOWS_COMMAND = `list-windows -a -F '${WINDOWS_FORMAT}'`;
export const LIST_PANES_COMMAND = `list-panes -a -F '${PANES_FORMAT}'`;

/**
 * Parse raw `list-windows -a` + `list-panes -a` output into session nodes.
 *
 * Pure and exported for unit testing. Windows are index-ordered within a
 * session; sessions are name-ordered. tmuxy-internal windows (floats, groups,
 * the hidden sidebar/backdrop) are dropped; panes orphaned from a kept window
 * are dropped too.
 */
export function parseSessions(windowsOut: string, panesOut: string): SessionTreeNode[] {
  const bySession = new Map<string, SessionTreeNode>();
  const ensure = (name: string): SessionTreeNode => {
    let node = bySession.get(name);
    if (!node) {
      node = { sessionName: name, windows: [], panes: [] };
      bySession.set(name, node);
    }
    return node;
  };

  const keptWindowIds = new Set<string>();
  for (const line of windowsOut.split('\n')) {
    if (!line) continue;
    const [session, windowId, index, name, type] = line.split(SEP);
    if (!session || !windowId) continue;
    if (HIDDEN_WINDOW_TYPES.has(type)) continue;
    keptWindowIds.add(windowId);
    ensure(session).windows.push({
      id: windowId,
      index: Number(index) || 0,
      name: name ?? '',
    });
  }

  for (const line of panesOut.split('\n')) {
    if (!line) continue;
    const [session, windowId, paneId, command, active] = line.split(SEP);
    if (!session || !windowId || !paneId) continue;
    if (!keptWindowIds.has(windowId)) continue;
    ensure(session).panes.push({
      id: paneId,
      windowId,
      command: command ?? '',
      active: active === '1',
    });
  }

  const nodes = Array.from(bySession.values());
  for (const node of nodes) {
    node.windows.sort((a, b) => a.index - b.index);
  }
  nodes.sort((a, b) => a.sessionName.localeCompare(b.sessionName));
  return nodes;
}

/** Shape returned by the `list_servers` Tauri command. */
interface ListServersResult {
  servers?: Array<{ id?: string; label?: string; kind?: string }>;
  currentId?: string;
}

/** Normalize a `list_servers` payload into the picker's {@link ServerInfo} list. */
export function toServerInfos(result: ListServersResult | null | undefined): ServerInfo[] {
  return (result?.servers ?? [])
    .filter((s): s is { id: string; label?: string; kind?: string } => Boolean(s?.id))
    .map((s) => ({
      id: s.id,
      label: s.label || s.id,
      kind: s.kind === 'ssh' ? 'ssh' : 'local',
    }));
}

/**
 * Create the sessions-poll actor bound to `adapter`. It polls every
 * {@link POLL_INTERVAL_MS} and can be nudged with `REFRESH_SESSIONS`.
 *
 * The sessions poll runs whenever the adapter is attached to a real tmux server
 * (`adapter.enumeratesSessions` — the web `HttpAdapter` and the desktop Tauri
 * adapter, not the single-session demo/v86 sandboxes): `list-windows -a` /
 * `list-panes -a` enumerate all sessions on that socket, so the web build lists
 * its socket's other sessions too (activating one reconnects the SSE stream via
 * `HttpAdapter.switchSession`). The saved-server list is Tauri-only — it reads
 * the desktop config and drives the ServerPicker, which web never renders.
 */
export function createServersActor(adapter: TmuxAdapter) {
  return fromCallback<ServersActorEvent, ServersActorInput>(({ input, receive }) => {
    // In-browser sandboxes (demo, v86) are single-session — nothing to enumerate.
    if (!adapter.enumeratesSessions) return () => {};
    const { parent } = input;
    let cancelled = false;

    const tick = async () => {
      // Sessions tree (from tmux) and the saved-server list (from the config
      // file) are independent; refresh each on its own so one failing doesn't
      // blank the other.
      try {
        const [windowsOut, panesOut] = await Promise.all([
          adapter.invoke<string>('run_tmux_command', { command: LIST_WINDOWS_COMMAND }),
          adapter.invoke<string>('run_tmux_command', { command: LIST_PANES_COMMAND }),
        ]);
        if (!cancelled) {
          parent.send({
            type: 'SESSIONS_UPDATED',
            sessions: parseSessions(windowsOut ?? '', panesOut ?? ''),
          });
        }
      } catch {
        // Non-fatal — keep the last tree snapshot; the next tick retries.
      }

      // Saved-server list is desktop-only (backed by the Tauri config); web has
      // no ServerPicker, so skip the invoke rather than let it fail every tick.
      if (isTauri()) {
        try {
          const result = await adapter.invoke<ListServersResult>('list_servers');
          if (!cancelled) {
            parent.send({
              type: 'SERVERS_UPDATED',
              serverList: toServerInfos(result),
              currentServerId: result?.currentId ?? 'localhost',
            });
          }
        } catch {
          // Non-fatal — keep the last server list; the next tick retries.
        }
      }
    };

    void tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    receive((event) => {
      if (event.type === 'REFRESH_SESSIONS') void tick();
    });

    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  });
}
