/**
 * Every command a client sends a backend, by the name it travels under: the
 * `{ cmd, args }` the web POSTs to `/commands` and the desktop hands its one
 * `dispatch` IPC command (`ClientCommand` in `tmuxy-core/src/host/command.rs`).
 * Each name has the schema of its arguments and the schema its answer is
 * decoded with, so a call site cannot misspell a command or an argument, and
 * no answer reaches the app unchecked.
 *
 * The protocol fixture test holds this table to the Rust enum: every request
 * in `packages/protocol-fixtures/command_requests.json` decodes here with no
 * argument left over or missing, and every answer in `command_results.json`
 * decodes with its result schema, dropping no field.
 */

import { Schema } from 'effect';
import { PaneId } from './ids';
import { PreviewDocument, PreviewResource } from './preview';
import { GitRepository, RestorableSession, ServerList } from './servers';
import { ScrollbackCells, ServerState, ThemeSettings } from './wire';
import { ThemeInfo, TraceLevel, TraceSettings } from './wireSettings';

interface Command<A, AI, R, RI> {
  readonly args: Schema.Schema<A, AI>;
  readonly result: Schema.Schema<R, RI>;
}

const command = <A, AI, R, RI>(
  args: Schema.Schema<A, AI>,
  result: Schema.Schema<R, RI>,
): Command<A, AI, R, RI> => ({ args, result });

const NoArgs = Schema.Struct({});
const Done = Schema.Null;
const Viewport = Schema.Struct({ cols: Schema.Number, rows: Schema.Number });
/** An argument the host defaults when it is absent (`#[serde(default)]`). */
const optional = <A, I>(schema: Schema.Schema<A, I>) => Schema.optional(Schema.NullOr(schema));
const Flag = Schema.Struct({ enabled: Schema.Boolean });

/** A plugin action the host prepared for a click: launched with its token. */
export const PreparedAction = Schema.Struct({
  plugin: Schema.String,
  action: Schema.String,
  token: Schema.String,
});
export type PreparedAction = Schema.Schema.Type<typeof PreparedAction>;

/** One host event the greeting carries, decoded through the event table. */
const GreetingEvent = Schema.Struct({ event: Schema.String, data: Schema.Unknown });

export const BACKEND_COMMANDS = {
  /** The session's state at the client's viewport, which it reports here too. */
  get_initial_state: command(Viewport, ServerState),
  set_client_size: command(Viewport, Done),
  run_tmux_command: command(Schema.Struct({ command: Schema.String }), Done),
  query_tmux: command(Schema.Struct({ command: Schema.String }), Schema.String),
  get_scrollback_cells: command(
    Schema.Struct({ paneId: PaneId, start: Schema.Number, end: Schema.Number }),
    ScrollbackCells,
  ),
  /** The pane's document, or (`path` given) a resource it links. */
  read_preview: command(
    Schema.Struct({ paneId: PaneId, path: optional(Schema.String) }),
    Schema.Union(PreviewDocument, PreviewResource),
  ),
  stage_preview: command(Schema.Struct({ paneId: PaneId, html: Schema.String }), Done),
  get_theme_settings: command(NoArgs, ThemeSettings),
  set_theme: command(Schema.Struct({ name: Schema.String, mode: optional(Schema.String) }), Done),
  set_theme_mode: command(Schema.Struct({ mode: Schema.String }), Done),
  get_themes_list: command(NoArgs, Schema.Array(ThemeInfo)),
  set_cursor_blink: command(Flag, Done),
  set_send_ask: command(Flag, Done),
  set_transparency: command(Flag, Done),
  list_git_worktrees: command(NoArgs, Schema.Array(GitRepository)),
  list_snapshots: command(NoArgs, Schema.Array(RestorableSession)),
  restore_session: command(Schema.Struct({ session: Schema.String }), Done),
  get_trace_settings: command(NoArgs, TraceSettings),
  /** The switch actually in force: a kill switch can refuse an enable. */
  set_trace_enabled: command(Flag, Schema.Boolean),
  /** The level actually in force: an unknown one normalises to `shape`. */
  set_trace_level: command(Schema.Struct({ level: TraceLevel }), TraceLevel),
  record_trace: command(
    Schema.Struct({
      events: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    }),
    Done,
  ),
  open_trace_file: command(NoArgs, Done),
  open_url: command(Schema.Struct({ url: Schema.String }), Done),
  list_servers: command(NoArgs, ServerList),
  connect_server: command(
    Schema.Struct({ id: Schema.String, session: optional(Schema.String) }),
    Done,
  ),
  detach_client: command(NoArgs, Done),
  prepare_plugin_action: command(
    Schema.Struct({
      plugin: Schema.String,
      action: Schema.String,
      paneId: PaneId,
      selection: optional(Schema.String),
    }),
    Schema.Struct({ token: Schema.String }),
  ),
  /** A clicked link a plugin's handler takes, or null for the browser. */
  open_link: command(
    Schema.Struct({ url: Schema.String, paneId: PaneId }),
    Schema.NullOr(PreparedAction),
  ),
  /** Clicked text: the line and the column in characters. */
  open_text: command(
    Schema.Struct({ paneId: PaneId, line: Schema.String, column: Schema.Number }),
    Schema.NullOr(PreparedAction),
  ),
  /** What a client is told when it connects, as events (the desktop asks for it). */
  greeting: command(NoArgs, Schema.Array(GreetingEvent)),
};

type Commands = typeof BACKEND_COMMANDS;
export type CommandName = keyof Commands;

/** What a call site passes for `K`. */
export type CommandArgs<K extends CommandName> = Schema.Schema.Type<Commands[K]['args']>;

/** The decoded answer to `K`. */
export type CommandResult<K extends CommandName> = Schema.Schema.Type<Commands[K]['result']>;

/** One command as it goes on the wire: the name and its arguments. */
export type BackendCall = {
  readonly [K in CommandName]: { readonly cmd: K; readonly args: CommandArgs<K> };
}[CommandName];

/** The call of `K` with `args`. */
export const backendCall = <K extends CommandName>(cmd: K, args: CommandArgs<K>): BackendCall =>
  ({ cmd, args }) as BackendCall;

/**
 * The commands the transport service sends on behalf of its own calls, never
 * as a plain call: tmux ops go through its serial lane (`run`), the state
 * fetch and the client size carry the viewport a resync asks for again, a
 * read is `query`, a staged preview has a URL to make, and the greeting and
 * the trace sink belong to a driver.
 */
export type LaneCommand =
  | 'run_tmux_command'
  | 'get_initial_state'
  | 'set_client_size'
  | 'query_tmux'
  | 'stage_preview'
  | 'greeting'
  | 'record_trace';

/** A command a caller sends and awaits the decoded answer of. */
export type PlainCommand = Exclude<CommandName, LaneCommand>;

/** A plain command and its arguments, as an event carries it. */
export type PlainCall = Extract<BackendCall, { readonly cmd: PlainCommand }>;
