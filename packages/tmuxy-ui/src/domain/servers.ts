/**
 * Sessions and servers as the sidebar tree and the session switcher show
 * them: the `serversActor` poll's answers (`list-windows -a`, `list-panes -a`,
 * `list_servers`, the session snapshots) and the git checkouts the host
 * discovers from pane directories.
 */

import type { PaneId, WindowId } from './ids';

/**
 * A lightweight window in another session's subtree (sidebar sessions tree).
 * Only the fields needed to render and switch — not a full {@link TmuxWindow}.
 */
export interface SessionTreeWindow {
  id: WindowId;
  index: number;
  name: string;
}

/** A lightweight pane in another session's subtree. */
export interface SessionTreePane {
  id: PaneId;
  windowId: WindowId;
  command: string;
  /** App-set pane title (OSC 0/2); empty when the app never set one. */
  title: string;
  /** Working directory tmux reports for the pane (`#{pane_current_path}`). */
  cwd: string;
  active: boolean;
}

/**
 * One checkout of a repository as `git worktree list` reports it — the wire
 * shape of `tmuxy-core/src/worktrees.rs`, discovered by the host from the cwd
 * of every pane and shown as a branch badge in the sidebar tree.
 */
export interface GitWorktree {
  path: string;
  /** Absent for a detached HEAD and for a bare repository. */
  branch?: string;
  head: string;
  isMain: boolean;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface GitRepository {
  id: string;
  name: string;
  root: string | null;
  worktrees: GitWorktree[];
}

/**
 * SSH details for a remote tmux server — the wire shape of
 * `tmuxy-core/src/servers.rs`.
 *
 * Deliberately thin. tmuxy runs the system `ssh` binary rather than speaking
 * the protocol itself, so `~/.ssh/config` supplies User, Port, IdentityFile,
 * ProxyJump, agent and 2FA behaviour for free; `host` can be any alias that
 * file defines. `options` is the escape hatch for a raw flag.
 */
export interface TmuxSshConfig {
  host: string;
  user?: string | null;
  port?: number | null;
  options?: string | null;
}

export type ServerReachability = 'online' | 'known' | 'offline';

/** A saved tmux server: a socket on this machine, or one reached over SSH. */
export interface TmuxServer {
  id: string;
  label: string;
  kind: 'local' | 'ssh';
  ssh?: TmuxSshConfig | null;
  /** tmux socket name (`-L`), or a path when it contains a `/` (`-S`). */
  socket: string;
  /** Preferred session to attach to on this server, if any. */
  session?: string | null;
  /** Last time this server was connected or probed (unix seconds). */
  last_used?: number | null;
  /** Reachability status reported by the server list or probe. */
  reachable?: ServerReachability | null;
  /** Number of sessions discovered on this server, if known. */
  session_count?: number | null;
}

/**
 * One tmux session as shown in the sidebar's sessions→tabs→panes tree.
 *
 * Populated by the `serversActor` poll (`list-windows -a` / `list-panes -a`) on
 * both the web and desktop builds, so a client attached to a multi-session
 * socket lists all of them. Empty on the single-session in-browser sandboxes
 * (demo, v86), which render the classic flat tab/pane tree. The active
 * session's subtree is drawn from live state, not this summary.
 */
export interface SessionTreeNode {
  sessionName: string;
  windows: SessionTreeWindow[];
  panes: SessionTreePane[];
}

/**
 * A session that has a snapshot to be rebuilt from (`session_snapshot`), and
 * when it was last saved (unix seconds). Listed by the same poll as the
 * sessions, so the switcher can offer what is not running beside what is.
 */
export interface RestorableSession {
  name: string;
  savedAt: number;
}
