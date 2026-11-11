/**
 * serversActor — the poll that feeds the sidebar's sessions → tabs → panes
 * tree. The live state the app holds is the attached session's; this lists
 * every session on the socket (`list-windows -a` / `list-panes -a` through the
 * transport's `query`, answered in-band) and sends SESSIONS_UPDATED. The
 * attached session's subtree is drawn from live state (SidebarTree), so a few
 * seconds' lag on the others is fine.
 *
 * It polls only while a tree is on screen (the desktop's column or the phone's
 * bottom view) and the transport enumerates sessions (not the single-session
 * demo and v86 sandboxes): its reads share the control-mode connection, and
 * running them with nothing watching delays window creation and
 * `@tmuxy-window-type` tagging.
 *
 * The same poll carries the tree's git context: each pane's cwd rides in the
 * pane listing, and every DISCOVERY_INTERVAL_MS (and on each forced refresh)
 * the host is asked for the worktrees those cwds sit in (`list_git_worktrees`,
 * which reads the pane paths from tmux itself: nothing about the filesystem is
 * sent from here). The tree matches cwds to worktrees client-side
 * (`components/gitContext.ts`).
 */
import { fromCallback, type AnyActorRef } from 'xstate';
import { isPaneId, isWindowId, type WindowId } from '../../domain/ids';
import { Effect, Fiber } from 'effect';
import type { AppRuntime } from '../../infra/runtime';
import type { ContextView } from '../contextView';
import { TmuxTransport } from '../../infra/transport/TmuxTransport';
import type { SessionTreeNode, SessionTreePane } from '../../domain/servers';
import {
  APP_PANE_TITLE,
  CHROME_WINDOW_TYPES,
  PANE_META_OPTION,
  STASH_SESSION,
  TREE_ROW_OPTION,
} from '../../domain/tmuxyConstants.gen';
import { paneFields } from '../../domain/paneMeta';

export type ServersActorEvent = { type: 'REFRESH_SESSIONS' };

export interface ServersActorInput {
  parent: AnyActorRef;
  /** Whether the tree is on screen (selectTreeVisible): the poll runs only then. */
  treeVisible: ContextView<boolean>;
}

const POLL_INTERVAL_MS = 4000;

// Until a listing comes back the poll looks again this soon: on a page load
// the first look finds the app still connecting and the tree not yet restored
// open, and a full interval's wait left the tree's rows without their cwd and
// branch for seconds. A look with no tree on screen never reaches tmux.
const WAKE_INTERVAL_MS = 250;

// Worktree discovery runs git once per repository; branches change far less
// often than panes, so it rides on the poll only every few ticks.
const DISCOVERY_INTERVAL_MS = 15000;

const SEP = '\t';

const HIDDEN_WINDOW_TYPES = new Set<string>(CHROME_WINDOW_TYPES);

// One `list-windows -a` / `list-panes -a` row, tab-joined. `#{@tmuxy-window-type}`
// is empty for foreign (e.g. vanilla-tmux) windows — those are kept as tabs.
const WINDOWS_FORMAT = `#{session_name}${SEP}#{window_id}${SEP}#{window_index}${SEP}#{window_name}${SEP}#{@tmuxy-window-type}`;
const PANES_FORMAT = `#{session_name}${SEP}#{window_id}${SEP}#{pane_id}${SEP}#{pane_current_command}${SEP}#{pane_active}${SEP}${APP_PANE_TITLE}${SEP}#{pane_current_path}${SEP}#{@tmuxy-group-id}${SEP}#{${PANE_META_OPTION}}`;

export const LIST_WINDOWS_COMMAND = `list-windows -a -F '${WINDOWS_FORMAT}'`;
export const LIST_PANES_COMMAND = `list-panes -a -F '${PANES_FORMAT}'`;

/**
 * Parse raw `list-windows -a` + `list-panes -a` output into session nodes.
 *
 * Windows are index-ordered within a session; sessions are name-ordered. tmuxy-internal windows (floats, groups,
 * the hidden sidebar/backdrop) are dropped; panes orphaned from a kept window
 * are dropped too. A pane-group member parked in the stash session is listed
 * with the tab its group is shown in — it is that tab's pane, out of view — so
 * its cwd and branch reach the tree like any other.
 */
export function parseSessions(
  windowsOut: string,
  panesOut: string,
  nowSeconds = Date.now() / 1000,
): SessionTreeNode[] {
  const bySession = new Map<string, SessionTreeNode>();
  const ensure = (name: string): SessionTreeNode => {
    let node = bySession.get(name);
    if (!node) {
      node = { sessionName: name, windows: [], panes: [] };
      bySession.set(name, node);
    }
    return node;
  };

  const keptWindowIds = new Set<WindowId>();
  for (const line of windowsOut.split('\n')) {
    if (!line) continue;
    const [session, windowId, index, name, type] = line.split(SEP);
    if (!session || !isWindowId(windowId)) continue;
    if (session === STASH_SESSION) continue;
    if (HIDDEN_WINDOW_TYPES.has(type)) continue;
    keptWindowIds.add(windowId);
    ensure(session).windows.push({
      id: windowId,
      index: Number(index) || 0,
      name: name ?? '',
    });
  }

  // Where each group is shown: its member in a kept window.
  const shownGroup = new Map<string, { session: string; windowId: WindowId }>();
  const parked: Array<{ group: string; pane: SessionTreePane }> = [];
  for (const line of panesOut.split('\n')) {
    if (!line) continue;
    const [session, windowId, paneId, command, active, title, cwd, group, meta] = line.split(SEP);
    if (!session || !isWindowId(windowId) || !isPaneId(paneId)) continue;
    const pane: SessionTreePane = {
      id: paneId,
      windowId,
      command: command ?? '',
      title: title ?? '',
      cwd: cwd ?? '',
      active: active === '1',
      fields: paneFields(meta ?? '', nowSeconds),
    };
    if (session === STASH_SESSION) {
      if (group) parked.push({ group, pane: { ...pane, active: false } });
      continue;
    }
    if (!keptWindowIds.has(windowId)) continue;
    if (group) shownGroup.set(group, { session, windowId });
    ensure(session).panes.push(pane);
  }
  for (const { group, pane } of parked) {
    const shown = shownGroup.get(group);
    if (shown) ensure(shown.session).panes.push({ ...pane, windowId: shown.windowId });
  }

  const nodes = Array.from(bySession.values());
  for (const node of nodes) {
    node.windows.sort((a, b) => a.index - b.index);
  }
  nodes.sort((a, b) => a.sessionName.localeCompare(b.sessionName));
  return nodes;
}

/** How long until the next look: the steady cadence once a listing came back. */
export function nextPollDelay(listed: boolean): number {
  return listed ? POLL_INTERVAL_MS : WAKE_INTERVAL_MS;
}

export function createServersActor(runtime: AppRuntime) {
  return fromCallback<ServersActorEvent, ServersActorInput>(({ input, receive }) => {
    const { parent, treeVisible } = input;

    // Worktree discovery, due every DISCOVERY_INTERVAL_MS or when forced. The
    // host derives the pane paths from tmux and runs git; a failure (no git on
    // the host, say) just leaves the previous repositories in place.
    let lastDiscovery = 0;
    /**
     * The saved servers. Only the desktop switches servers; the web answers
     * `list_servers` unavailable and the list stays empty, which is right
     * there: a web client always uses its launch socket.
     */
    const listServers = (): Effect.Effect<void, never, TmuxTransport> =>
      TmuxTransport.pipe(Effect.flatMap((t) => t.call('list_servers', {}))).pipe(
        Effect.flatMap((result) =>
          Effect.sync(() =>
            parent.send({
              type: 'SERVERS_UPDATED',
              servers: result.servers,
              currentServerId: result.currentId,
            }),
          ),
        ),
        Effect.ignore,
      );

    /** The sessions a snapshot could bring back; an empty list is the ordinary answer. */
    const listSnapshots = (): Effect.Effect<void, never, TmuxTransport> =>
      TmuxTransport.pipe(Effect.flatMap((t) => t.call('list_snapshots', {}))).pipe(
        Effect.flatMap((result) =>
          Effect.sync(() =>
            parent.send({
              type: 'SNAPSHOTS_UPDATED',
              restorableSessions: result,
            }),
          ),
        ),
        Effect.ignore,
      );

    const discover = (force: boolean): Effect.Effect<void, never, TmuxTransport> =>
      Effect.suspend(() => {
        if (!force && Date.now() - lastDiscovery < DISCOVERY_INTERVAL_MS) return Effect.void;
        lastDiscovery = Date.now();
        return TmuxTransport.pipe(Effect.flatMap((t) => t.call('list_git_worktrees', {}))).pipe(
          Effect.flatMap((repositories) =>
            Effect.sync(() => parent.send({ type: 'GIT_REPOSITORIES_UPDATED', repositories })),
          ),
          Effect.ignore,
        );
      });

    // The ports the panes' programs listen on, on every tick: a server comes
    // up in seconds, and finding them reads the process table, not git. A
    // failure leaves the last answer in place.
    const listPorts = (): Effect.Effect<void, never, TmuxTransport> =>
      TmuxTransport.pipe(Effect.flatMap((t) => t.call('list_pane_ports', {}))).pipe(
        Effect.flatMap((panePorts) =>
          Effect.sync(() => parent.send({ type: 'PANE_PORTS_UPDATED', panePorts })),
        ),
        Effect.ignore,
      );

    // The user's row template, read with the sessions: a `tmuxy config
    // reload` after editing it shows within a poll.
    const readRowTemplate = (): Effect.Effect<void, never, TmuxTransport> =>
      TmuxTransport.pipe(
        Effect.flatMap((t) => t.query(`show-options -gqv ${TREE_ROW_OPTION}`)),
      ).pipe(
        Effect.flatMap((text) =>
          Effect.sync(() =>
            parent.send({ type: 'TREE_ROW_TEMPLATE_UPDATED', treeRowTemplate: text.trim() }),
          ),
        ),
        Effect.ignore,
      );

    // One poll tick, answering whether the sessions were listed. Interrupting
    // the poll fiber between a query and its parent.send drops the stale send.
    const tick = (force = false): Effect.Effect<boolean, never, TmuxTransport> =>
      Effect.suspend(() => {
        // `force` is for the nudges: the tree coming on screen,
        // REFRESH_SESSIONS, the session menu opening.
        if (!force && !treeVisible.get()) return Effect.succeed(false);

        // Concurrent, so a slow socket scan never holds up the snapshot list.
        const listSessions = TmuxTransport.pipe(
          Effect.flatMap((t) =>
            Effect.all([t.query(LIST_WINDOWS_COMMAND), t.query(LIST_PANES_COMMAND)], {
              concurrency: 'unbounded',
            }),
          ),
        ).pipe(
          Effect.flatMap(([windowsOut, panesOut]) =>
            Effect.sync(() =>
              parent.send({
                type: 'SESSIONS_UPDATED',
                sessions: parseSessions(windowsOut, panesOut),
              }),
            ),
          ),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

        return Effect.all(
          [
            listSessions,
            listServers(),
            listSnapshots(),
            discover(force),
            listPorts(),
            readRowTemplate(),
          ],
          { concurrency: 'unbounded' },
        ).pipe(
          Effect.map(([listed]) => listed),
          Effect.orElseSucceed(() => false),
        );
      });

    const whileEnumerable = (program: Effect.Effect<void, never, TmuxTransport>) =>
      TmuxTransport.pipe(Effect.flatMap((t) => (t.enumeratesSessions() ? program : Effect.void)));
    const poll = tick().pipe(
      Effect.flatMap((listed) => Effect.sleep(nextPollDelay(listed))),
      Effect.forever,
    );
    const pollFiber = runtime.runFork(whileEnumerable(poll));
    receive((event) => {
      if (event.type === 'REFRESH_SESSIONS') runtime.runFork(whileEnumerable(tick(true)));
    });
    // The tree coming on screen shows what is there now, not the last poll's.
    const unsubscribe = treeVisible.subscribe((visible) => {
      if (visible) runtime.runFork(whileEnumerable(tick(true)));
    });

    return () => {
      unsubscribe();
      runtime.runFork(Fiber.interrupt(pollFiber));
    };
  });
}
