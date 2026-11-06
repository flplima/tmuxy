/**
 * Sessions and servers as the sidebar tree and the session switcher show
 * them: the `serversActor` poll's answers (`list-windows -a`, `list-panes -a`,
 * `list_servers`, the session snapshots) and the git checkouts the host
 * discovers from pane directories.
 */

import { Schema } from 'effect';
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
  /** Preferred session to attach to on this server, if any. */
  session: Schema.optional(Schema.NullOr(Schema.String)),
  /** Last time this server was connected or probed (unix seconds). */
  last_used: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Reachability status reported by the server list or probe. */
  reachable: Schema.optional(Schema.NullOr(ServerReachability)),
  /** Number of sessions discovered on this server, if known. */
  session_count: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type TmuxServer = Schema.Schema.Type<typeof TmuxServer>;

/** The server picker's list (`list_servers`), and which one this client is on. */
export const ServerList = Schema.Struct({
  servers: Schema.Array(TmuxServer),
  currentId: Schema.NullOr(Schema.String),
});
export type ServerList = Schema.Schema.Type<typeof ServerList>;

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
export const RestorableSession = Schema.Struct({
  name: Schema.String,
  savedAt: Schema.Number,
});
export type RestorableSession = Schema.Schema.Type<typeof RestorableSession>;
