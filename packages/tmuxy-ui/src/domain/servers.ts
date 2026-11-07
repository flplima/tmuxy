/**
 * Sessions and servers as the sidebar tree and the session switcher show
 * them: the `serversActor` poll's answers (`list-windows -a`, `list-panes -a`,
 * `list_servers`, the session snapshots) and the git checkouts the host
 * discovers from pane directories.
 */

import { Schema } from 'effect';
import type { PaneId, WindowId } from './ids';

export interface SessionTreeWindow {
  id: WindowId;
  index: number;
  name: string;
}

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
export const GitWorktree = Schema.Struct({
  path: Schema.String,
  /** Absent for a detached HEAD and for a bare repository. */
  branch: Schema.optional(Schema.String),
  head: Schema.String,
  isMain: Schema.Boolean,
  detached: Schema.Boolean,
  bare: Schema.Boolean,
  locked: Schema.Boolean,
  prunable: Schema.Boolean,
});
export type GitWorktree = Schema.Schema.Type<typeof GitWorktree>;

/** A repository and its checkouts (`list_git_worktrees`). */
export const GitRepository = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.NullOr(Schema.String),
  worktrees: Schema.Array(GitWorktree),
});
export type GitRepository = Schema.Schema.Type<typeof GitRepository>;

/**
 * SSH details for a remote tmux server — the wire shape of
 * `tmuxy-core/src/servers.rs`.
 *
 * Deliberately thin. tmuxy runs the system `ssh` binary rather than speaking
 * the protocol itself, so `~/.ssh/config` supplies User, Port, IdentityFile,
 * ProxyJump, agent and 2FA behaviour for free; `host` can be any alias that
 * file defines. `options` is the escape hatch for a raw flag.
 */
export const TmuxSshConfig = Schema.Struct({
  host: Schema.String,
  user: Schema.optional(Schema.NullOr(Schema.String)),
  port: Schema.optional(Schema.NullOr(Schema.Number)),
  options: Schema.optional(Schema.NullOr(Schema.String)),
});
export type TmuxSshConfig = Schema.Schema.Type<typeof TmuxSshConfig>;

export const ServerReachability = Schema.Literal('online', 'known', 'offline');
export type ServerReachability = Schema.Schema.Type<typeof ServerReachability>;

/** A saved tmux server: a socket on this machine, or one reached over SSH. */
export const TmuxServer = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literal('local', 'ssh'),
  ssh: Schema.optional(Schema.NullOr(TmuxSshConfig)),
  /** tmux socket name (`-L`), or a path when it contains a `/` (`-S`). */
  socket: Schema.String,
  session: Schema.optional(Schema.NullOr(Schema.String)),
  /** Last connected or probed, in unix seconds. */
  last_used: Schema.optional(Schema.NullOr(Schema.Number)),
  reachable: Schema.optional(Schema.NullOr(ServerReachability)),
  session_count: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type TmuxServer = Schema.Schema.Type<typeof TmuxServer>;

/**
 * The host of `host [session]` in the sidebar title and the status line:
 * `[user@]host` for an SSH server, else `hostname`, what the server said of
 * itself in its greeting (`localhost` until it has).
 */
export function serverHostLabel(
  servers: readonly TmuxServer[],
  currentServerId: string | null,
  isDemo?: boolean,
  hostname: string | null = null,
): string {
  if (isDemo) return 'demo@localhost';
  const current = currentServerId ? servers.find((s) => s.id === currentServerId) : undefined;
  if (current?.kind === 'ssh') {
    if (current.ssh?.host) {
      return current.ssh.user ? `${current.ssh.user}@${current.ssh.host}` : current.ssh.host;
    }
    return current.label || hostname || 'localhost';
  }
  return hostname || 'localhost';
}

/** The server picker's list (`list_servers`), and which one this client is on. */
export const ServerList = Schema.Struct({
  servers: Schema.Array(TmuxServer),
  currentId: Schema.NullOr(Schema.String),
});
export type ServerList = Schema.Schema.Type<typeof ServerList>;

/**
 * Empty on the single-session in-browser sandboxes (demo, v86), which render
 * the flat tab/pane tree. The active session's subtree is drawn from live
 * state, not this summary.
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
export const RestorableSession = Schema.Struct({
  name: Schema.String,
  savedAt: Schema.Number,
});
export type RestorableSession = Schema.Schema.Type<typeof RestorableSession>;
