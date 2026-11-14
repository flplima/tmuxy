/**
 * Every command a client sends a backend, by the name it travels under: the
 * `{ cmd, args }` the web POSTs to `/commands` and the desktop hands its one
 * `dispatch` IPC command (`ClientCommand` in `tmuxy-core/src/host/command.rs`).
 *
 * The protocol fixture test holds this table to the Rust enum: every request
 * in `packages/protocol-fixtures/command_requests.json` and every answer in
 * `command_results.json` decodes here with no field left over or missing.
 */

import { Schema } from 'effect';
import { PaneId } from './ids';
import { PreviewDocument, PreviewResource } from './preview';
import { GitRepository, OwnTmuxOffer, PanePorts, RestorableSession, ServerList } from './servers';
import {
  type CommandFailure,
  LastOutput,
  PromptMarks,
  ScrollbackCells,
  ServerState,
  ThemeSettings,
} from './wire';
import { ProfilesInfo, ThemeInfo, TraceLevel, TraceSettings, TraceShare } from './wireSettings';

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
  get_prompt_marks: command(Schema.Struct({ paneId: PaneId }), PromptMarks),
  get_last_command_output: command(Schema.Struct({ paneId: PaneId }), LastOutput),
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
  /** The profiles and the one this session uses; every profile command answers the same. */
  list_profiles: command(NoArgs, ProfilesInfo),
  /** Move this session to a profile, live. */
  use_profile: command(Schema.Struct({ name: Schema.String }), ProfilesInfo),
  /** A new profile, a copy of `from` (the default when absent), which this session then uses. */
  create_profile: command(
    Schema.Struct({ name: Schema.String, from: optional(Schema.String) }),
    ProfilesInfo,
  ),
  rename_profile: command(Schema.Struct({ from: Schema.String, to: Schema.String }), ProfilesInfo),
  delete_profile: command(Schema.Struct({ name: Schema.String }), ProfilesInfo),
  set_cursor_blink: command(Flag, Done),
  set_send_ask: command(Flag, Done),
  set_transparency: command(Flag, Done),
  list_git_worktrees: command(NoArgs, Schema.Array(GitRepository)),
  list_pane_ports: command(NoArgs, Schema.Array(PanePorts)),
  list_snapshots: command(NoArgs, Schema.Array(RestorableSession)),
  restore_session: command(Schema.Struct({ session: Schema.String }), Done),
  get_trace_settings: command(NoArgs, TraceSettings),
  /** The last `last` actions of the trace, redacted for sharing. */
  get_trace_share: command(Schema.Struct({ last: Schema.Number }), TraceShare),
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
  /** The launch notice about the user's own tmux server, or null for none. */
  own_tmux_offer: command(NoArgs, Schema.NullOr(OwnTmuxOffer)),
  close_own_tmux_offer: command(NoArgs, Done),
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

export type CommandArgs<K extends CommandName> = Schema.Schema.Type<Commands[K]['args']>;

export type CommandResult<K extends CommandName> = Schema.Schema.Type<Commands[K]['result']>;

export type BackendCall = {
  readonly [K in CommandName]: { readonly cmd: K; readonly args: CommandArgs<K> };
}[CommandName];

export const backendCall = <K extends CommandName>(cmd: K, args: CommandArgs<K>): BackendCall =>
  ({ cmd, args }) as BackendCall;

/** The commands only the transport service itself sends, never as a plain call. */
export type LaneCommand =
  | 'run_tmux_command'
  | 'get_initial_state'
  | 'set_client_size'
  | 'query_tmux'
  | 'stage_preview'
  | 'greeting'
  | 'record_trace';

export type PlainCommand = Exclude<CommandName, LaneCommand>;

export type PlainCall = Extract<BackendCall, { readonly cmd: PlainCommand }>;

/** The View menu's profile commands, each answered with the profiles (`ProfilesInfo`). */
export type ProfileCall = Extract<
  BackendCall,
  {
    readonly cmd:
      | 'list_profiles'
      | 'use_profile'
      | 'create_profile'
      | 'rename_profile'
      | 'delete_profile';
  }
>;

/** A profile command, typed as one: `backendCall` widens to any call. */
export const profileRequest = <K extends ProfileCall['cmd']>(
  cmd: K,
  args: CommandArgs<K>,
): ProfileCall => ({ cmd, args }) as ProfileCall;

/**
 * What a backend that does not run `cmd` answers: null where null is an
 * answer `cmd` can have, else a refusal of kind `unavailable` — never a null
 * the answer's schema would reject as a protocol error.
 */
export function noAnswer(cmd: CommandName): null {
  if (Schema.is(BACKEND_COMMANDS[cmd].result as Schema.Schema<unknown, unknown>)(null)) return null;
  throw { error: `${cmd} is not available here`, kind: 'unavailable' } satisfies CommandFailure;
}
