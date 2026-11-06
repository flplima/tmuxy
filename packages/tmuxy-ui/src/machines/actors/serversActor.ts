/**
 * serversActor — poll that feeds the sidebar's sessions→tabs→panes tree.
 *
 * The live tmux state the app holds is single-session (the attached session's
 * windows/panes). To show *every* session on the current tmux socket, this
 * actor shells `list-windows -a` / `list-panes -a` through the adapter
 * (`query`, answered in-band on web and desktop alike), parses the
 * result into {@link SessionTreeNode}s, and sends `SESSIONS_UPDATED` to the
 * parent machine. This runs on the web build too — a web client attached to a
 * multi-session socket now sees and can switch to its sibling sessions.
 *
 * It only refreshes while a tree is on screen (the sole consumer: the
 * desktop's column, or the phone's bottom view), on a deliberately slow
 * cadence once it has listed — until then it tries again every
 * {@link WAKE_INTERVAL_MS}, so the tree's cwds and branches come with its
 * first rows on a page load, not a whole poll later — with reads kept off the mutation serial queue —
 * the external-subprocess reads must not contend with the control-mode command
 * pipeline (which would delay window creation / `@tmuxy-window-type` tagging).
 *
 * The active session's subtree is still drawn from live state by SidebarTree;
 * this poll supplies the *other* sessions, so a few seconds' refresh lag on
 * them is fine.
 *
 * The same poll carries the tree's git context: each pane row's cwd
 * (`#{pane_current_path}`) rides along in the pane listing, and every
 * {@link DISCOVERY_INTERVAL_MS} (and on each forced refresh) the host is asked
 * for the worktrees those cwds sit in (`list_git_worktrees`, which reads the
 * pane paths from tmux itself — nothing about the filesystem is sent from
 * here). `GIT_REPOSITORIES_UPDATED` publishes the result; the tree matches
 * cwds to worktrees client-side (`components/gitContext.ts`).
 */
import { fromCallback, type AnyActorRef } from 'xstate';
import { isPaneId, isWindowId, type WindowId } from '../../domain/ids';
import { Effect, Fiber } from 'effect';
import type { AppRuntime } from '../../infra/runtime';
import { TmuxTransport } from '../../infra/transport/TmuxTransport';
import type { GitRepository, SessionTreeNode, SessionTreePane, TmuxServer } from '../types/domain';

export type ServersActorEvent = { type: 'REFRESH_SESSIONS' };

export interface ServersActorInput {
  parent: AnyActorRef;
}

// Poll cadence while the sidebar tree is open. Kept deliberately slow: each
// tick runs read-only tmux commands over the control-mode connection, and the
// tree tolerates a few seconds of lag on non-active sessions. The poll is
// skipped entirely while the sidebar is closed, and an immediate refresh fires
// on open (REFRESH_SESSIONS), so this only governs the steady-state refresh.
const POLL_INTERVAL_MS = 4000;

// Until a listing comes back the poll looks again this soon. On a page load
// the first look finds the app still connecting and the tree not yet
// restored open from tmux's state, and waiting the full interval for the next
// one left the tree's rows without their cwd and branch for seconds. A look
// with no tree on screen reads only the machine's context, never tmux.
const WAKE_INTERVAL_MS = 250;

// Worktree discovery runs git once per repository; branches change far less
// often than panes, so it rides on the poll only every few ticks.
const DISCOVERY_INTERVAL_MS = 15000;

/** Field separator embedded in the tmux `-F` format (a literal tab). */
const SEP = '\t';

/** tmux window types that are tmuxy-internal chrome, hidden from the tree. */
const HIDDEN_WINDOW_TYPES = new Set(['float', 'sidebar-left', 'sidebar-right']);

/** The stash session parks hidden pane-group members; never show it in the tree. */
const STASH_SESSION = '__tmuxy_stash';

// One `list-windows -a` / `list-panes -a` row, tab-joined. `#{@tmuxy-window-type}`
// is empty for foreign (e.g. vanilla-tmux) windows — those are kept as tabs.
const WINDOWS_FORMAT = `#{session_name}${SEP}#{window_id}${SEP}#{window_index}${SEP}#{window_name}${SEP}#{@tmuxy-window-type}`;
/**
 * The app-set pane title, with tmux's default host-name seed filtered out —
 * the same expression the Rust monitor uses (`tmux_formats::APP_PANE_TITLE` in
 * `tmuxy-core/src/constants.rs`); keep the two in step.
 */
const APP_PANE_TITLE = '#{?#{==:#{pane_title},#{host}},,#{pane_title}}';

const PANES_FORMAT = `#{session_name}${SEP}#{window_id}${SEP}#{pane_id}${SEP}#{pane_current_command}${SEP}#{pane_active}${SEP}${APP_PANE_TITLE}${SEP}#{pane_current_path}${SEP}#{@tmuxy-group-id}`;

export const LIST_WINDOWS_COMMAND = `list-windows -a -F '${WINDOWS_FORMAT}'`;
export const LIST_PANES_COMMAND = `list-panes -a -F '${PANES_FORMAT}'`;

/**
 * Parse raw `list-windows -a` + `list-panes -a` output into session nodes.
 *
 * Pure and exported for unit testing. Windows are index-ordered within a
 * session; sessions are name-ordered. tmuxy-internal windows (floats, groups,
 * the hidden sidebar/backdrop) are dropped; panes orphaned from a kept window
 * are dropped too. A pane-group member parked in the stash session is listed
 * with the tab its group is shown in — it is that tab's pane, out of view — so
 * its cwd and branch reach the tree like any other.
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
    const [session, windowId, paneId, command, active, title, cwd, group] = line.split(SEP);
    if (!session || !isWindowId(windowId) || !isPaneId(paneId)) continue;
    const pane: SessionTreePane = {
      id: paneId,
      windowId,
      command: command ?? '',
      title: title ?? '',
      cwd: cwd ?? '',
      active: active === '1',
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

/** The parts of the app's context the poll's gate reads. */
interface TreeGateContext {
  leftSidebarOpen?: boolean;
  phoneLayout?: boolean;
  phoneBottomView?: string;
}

/**
 * Whether a tree is on screen to show what the poll reads: the desktop's
 * column, or the phone's bottom view with the tree in front.
 */
export function treeOnScreen(ctx: TreeGateContext | undefined): boolean {
  if (!ctx) return false;
  return (
    ctx.leftSidebarOpen === true || (ctx.phoneLayout === true && ctx.phoneBottomView === 'tree')
  );
}

/** How long until the next look: the steady cadence once a listing came back. */
export function nextPollDelay(listed: boolean): number {
  return listed ? POLL_INTERVAL_MS : WAKE_INTERVAL_MS;
}

/**
 * Create the sessions-poll actor over the app runtime's transport. While the sidebar tree is
 * open it refreshes every {@link POLL_INTERVAL_MS}; it also polls immediately on
 * `REFRESH_SESSIONS` (raised when the sidebar opens) and skips entirely while
 * the sidebar is closed — the tree is the only consumer, and the reads are
 * external tmux subprocesses that must not churn against the control-mode
 * pipeline when nothing is watching.
 *
 * The poll runs whenever the adapter is attached to a real tmux server
 * (`enumeratesSessions` — the web `HttpAdapter` and the desktop Tauri
 * adapter, not the single-session demo/v86 sandboxes): `list-windows -a` /
 * `list-panes -a` enumerate all sessions on that socket, so the web build lists
 * its socket's other sessions too (activating one reconnects the SSE stream via
 * `HttpAdapter.switchSession`). Reads go through the transport's `query` so they
 * bypass the mutation serial queue.
 */
export function createServersActor(runtime: AppRuntime) {
  return fromCallback<ServersActorEvent, ServersActorInput>(({ input, receive }) => {
    const { parent } = input;

    // Worktree discovery, due every DISCOVERY_INTERVAL_MS or when forced. The
    // host derives the pane paths from tmux and runs git; a failure (no git on
    // the host, say) just leaves the previous repositories in place.
    let lastDiscovery = 0;
    /**
     * The saved servers, on the same cadence as worktree discovery.
     *
     * `list_servers` is a desktop-only Tauri command; on web the invoke simply
     * fails and the `ignore()` below leaves the list empty, which is the
     * correct answer there — a web client always uses its launch socket.
     */
    const listServers = (): Effect.Effect<void, never, TmuxTransport> =>
      TmuxTransport.pipe(
        Effect.flatMap((t) =>
          t.invoke<{ servers: TmuxServer[]; currentId: string | null } | null>('list_servers', {}),
        ),
      ).pipe(
        Effect.flatMap((result) =>
          Effect.sync(() =>
            parent.send({
              type: 'SERVERS_UPDATED',
              servers: result?.servers ?? [],
              currentServerId: result?.currentId ?? null,
            }),
          ),
        ),
        Effect.ignore,
      );

    /**
     * The sessions a snapshot could bring back, on the same cadence. Answered
     * by both hosts (`list_snapshots`); an empty list is the ordinary answer.
     */
    const listSnapshots = (): Effect.Effect<void, never, TmuxTransport> =>
      TmuxTransport.pipe(
        Effect.flatMap((t) =>
          t.invoke<Array<{ name: string; savedAt: number }> | null>('list_snapshots', {}),
        ),
      ).pipe(
        Effect.flatMap((result) =>
          Effect.sync(() =>
            parent.send({
              type: 'SNAPSHOTS_UPDATED',
              restorableSessions: result ?? [],
            }),
          ),
        ),
        Effect.ignore,
      );

    const discover = (force: boolean): Effect.Effect<void, never, TmuxTransport> =>
      Effect.suspend(() => {
        if (!force && Date.now() - lastDiscovery < DISCOVERY_INTERVAL_MS) return Effect.void;
        lastDiscovery = Date.now();
        return TmuxTransport.pipe(
          Effect.flatMap((t) => t.invoke<GitRepository[] | null>('list_git_worktrees', {})),
        ).pipe(
          Effect.flatMap((repositories) =>
            Effect.sync(() =>
              parent.send({ type: 'GIT_REPOSITORIES_UPDATED', repositories: repositories ?? [] }),
            ),
          ),
          Effect.ignore,
        );
      });

    // One poll tick as an Effect, answering whether the sessions were listed.
    // Modelling it in Effect means interrupting the poll fiber (on stop)
    // between a query and its parent.send drops the stale send — no
    // `cancelled` flag to thread through. suspend() re-reads the gate on
    // every repeat.
    const tick = (force = false): Effect.Effect<boolean, never, TmuxTransport> =>
      Effect.suspend(() => {
        // Only enumerate while a tree is actually on screen. The poll's
        // read-only tmux commands share the control-mode connection; running
        // them continuously (even with no tree to show them) contends with
        // the control-mode pipeline and delays window creation and
        // `@tmuxy-window-type` tagging. `force` bypasses the check for the
        // REFRESH_SESSIONS nudge raised as the sidebar opens (whose context
        // commit may not be visible) and as the session menu opens
        // (SESSION_MENU_OPENED).
        if (!force) {
          const snap = parent.getSnapshot() as { context?: TreeGateContext } | undefined;
          if (!treeOnScreen(snap?.context)) return Effect.succeed(false);
        }

        // Sessions tree (tmux), servers, snapshots, and git discovery run
        // concurrently so a slow socket scan never blocks snapshot listing.
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
                sessions: parseSessions(windowsOut ?? '', panesOut ?? ''),
              }),
            ),
          ),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

        return Effect.all([listSessions, listServers(), listSnapshots(), discover(force)], {
          concurrency: 'unbounded',
        }).pipe(
          Effect.map(([listed]) => listed),
          Effect.orElseSucceed(() => false),
        );
      });

    // A tick, then the next one after `nextPollDelay`, while attached: soon
    // until a listing comes back, at the steady cadence after.
    // REFRESH_SESSIONS forces one in between.
    // In-browser sandboxes (demo, v86) are single-session — nothing to
    // enumerate, and nothing to read it with: `query` is the only call that
    // returns tmux output, `run_tmux_command` resolves null everywhere.
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

    return () => {
      runtime.runFork(Fiber.interrupt(pollFiber));
    };
  });
}
