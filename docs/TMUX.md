# tmux Integration

This document covers how tmuxy interacts with tmux: control mode architecture, command routing rules, version-specific bugs, and operational constraints.

## tmux Version

Tmuxy targets **tmux 3.7a** (devcontainer, CI, and the in-browser v86 guest all build it from source). Several workarounds below were discovered on 3.3a/3.5a and are kept because they remain safe on 3.7a.

## Dedicated Server Socket

Tmuxy never talks to the user's default tmux server. Every component targets a **dedicated socket**, resolved the same way everywhere:

| Priority | Source                      | Used by                                                                                                                 |
| -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1        | `TMUX_SOCKET` env var       | all components (dev uses `tmuxy-dev`, agents use `tmuxy-prod`)                                                          |
| 2        | Socket derived from `$TMUX` | shell scripts running inside a pane (`bin/tmuxy-cli`, `bin/tmuxy/_lib`) — so they always target the server hosting them |
| 3        | `tmuxy` (the default)       | everything else                                                                                                         |

A `TMUX_SOCKET` value containing a slash is treated as a **full socket path** (`tmux -S <path>`); any other value is a **socket name** in tmux's default socket directory (`tmux -L <name>`). The Rust side resolves via `tmux_socket()` / `tmux_socket_args()` in `tmuxy-core/src/session.rs` and always passes the socket flag explicitly, which also overrides an inherited `$TMUX` — the server behaves identically whether launched from a terminal, a tmux pane, or Finder. Every bundled shell script sources the same resolution from `bin/tmuxy/_lib` (or defines it inline in `bin/tmuxy-cli`); none may call bare `tmux`. The event-queue scripts (`tmuxy event …`) namespace their FIFO directories by the same socket name.

### Live socket switch (desktop app)

The **web server** binds its socket once at process launch (from the env), so it cannot change sockets without a restart. The **desktop (Tauri) app** can switch servers live: `tmuxy connect <socket> [session]` publishes the request as two tmux global env vars (`TMUXY_CONNECT_TO`, `TMUXY_CONNECT_SESSION`) on the current server; a watcher task in the app (`packages/tmuxy-tauri-app/src/monitor.rs`, `poll_connect_requests`) reads them, sets `TMUX_SOCKET`/`TMUXY_SESSION` in-process, and drives the monitor loop to reconnect (a graceful `MonitorCommand::Shutdown` interrupts the live connection). Because every tmux call — the control-mode connection and the one-off executor commands alike — resolves its socket from the env, updating those two vars retargets the whole app. Adopting an existing server applies tmuxy's config and window-type tagging to it, so this is an explicit opt-in, distinct from the isolated default.

### Remote servers over SSH (desktop app)

A "server" in the desktop app is a tmux server tmuxy drives — the local machine or a **remote host reached over SSH**. Saved servers live in `~/.config/tmuxy/servers.json` (`tmuxy-core/src/servers.rs`); the sidebar footer's **server picker** lists them, and the `tmuxy connect` form (a small ratatui TUI in `packages/tmuxy-connect`, opened in a float) adds new ones. Attaching to a server sets `TMUX_SOCKET` and, for a remote, `TMUXY_SSH` (an ssh argv tail like `-p 2222 user@host`); the Tauri `connect_server` command routes both through the same `request_reconnect` path as a local socket switch.

`TMUXY_SSH` is resolved centrally by `ssh_target()` / `tmux_argv(pty)` in `session.rs`: when set, every tmux invocation is wrapped as `ssh [-tt] <tail> tmux -L <socket> …` (the `-tt` pty flag is used for the `-CC` control-mode connection, omitted for one-off reads so captured output stays clean; the remote binary is bare `tmux`, resolved by the remote login shell). The local `-f <config>` flag is skipped over SSH — that path is local-only. This means the whole app (control mode + executor reads) drives the remote tmux server transparently.

### Sessions tree

The live state the app holds is single-session (the attached session's windows/panes). The sidebar's **sessions→tabs→panes tree** is populated by a poll (`serversActor`, `packages/tmuxy-ui/src/machines/actors/serversActor.ts`) that shells `list-windows -a` / `list-panes -a` through `run_tmux_command` every ~1.5s. It runs on both the web and desktop builds — a client attached to a multi-session socket sees and can switch to (`SWITCH_SESSION`) every session; on web `switchSession` reconnects the SSE stream to the chosen session. The active session's subtree is drawn from live state; other sessions come from the poll. The tree only shows the session level when more than one session exists (a lone session stays a flat tab→pane tree). The poll is gated on the adapter's `enumeratesSessions` capability, so it stays inert on the single-session in-browser sandboxes (demo, v86). The **server picker** (saved-server list via `list_servers`) remains desktop-only.

## Control Mode Architecture

Tmuxy communicates with tmux through **control mode** (`tmux -CC`), which provides real-time event notifications and command execution through a single stdin/stdout connection. No polling is required.

```
Commands:  Frontend → Backend → MonitorCommand → Monitor → stdin → tmux -CC
Events:    Frontend ← Backend ← StateEmitter ← Monitor ← stdout ← tmux -CC
```

The `TmuxMonitor` (in `tmuxy-core/src/control_mode/monitor.rs`) maintains a persistent `tmux -CC attach-session` subprocess via `ControlModeConnection`. All state-modifying commands flow through the monitor's command channel as `MonitorCommand::RunCommand` messages. The monitor writes commands to control mode stdin, and tmux sends notifications back through stdout (`%output`, `%layout-change`, `%window-add`, etc.).

## Why Control Mode Only

Running external `tmux` commands (as separate subprocesses) while a control mode client is attached can **crash the tmux server**. Observed in tmux 3.3a and 3.5a. The [tmux Control Mode wiki](https://github.com/tmux/tmux/wiki/Control-Mode) states that commands should be sent through the control mode client.

All HTTP command handlers in the web server route through `send_via_control_mode()` in `tmuxy-server/src/sse.rs`, which looks up the session's `monitor_command_tx` and sends `MonitorCommand::RunCommand` through the channel.

## Command Routing Rules

### Commands That MUST Go Through Control Mode

Any command that **modifies** session state when a control mode client is attached:

| Command              | Short Form                               |
| -------------------- | ---------------------------------------- |
| `split-window`       | `splitw`                                 |
| `new-window`         | `neww` (but see crash workaround below)  |
| `select-pane`        | `selectp`                                |
| `select-window`      | `selectw`                                |
| `kill-pane`          | `killp`                                  |
| `kill-window`        | `killw`                                  |
| `resize-pane`        | `resizep`                                |
| `resize-window`      | `resizew` (ignored if sent externally)   |
| `swap-pane`          | —                                        |
| `break-pane`         | `breakp`                                 |
| `send-keys` / `send` | (for key input, not SGR mouse sequences) |
| `copy-mode`          | —                                        |
| `next-window`        | `next`                                   |
| `previous-window`    | `prev`                                   |
| `next-layout`        | `nextl`                                  |
| `run-shell`          | —                                        |
| `set-environment`    | —                                        |
| `rename-window`      | —                                        |

Use short command forms when sending through control mode.

**Note:** `new` is short for `new-session`, NOT `new-window`. Use `neww` for creating windows.

### Commands Safe to Run as External Subprocesses

These are used in `tmuxy-core/src/executor.rs` and `session.rs`:

| Command           | Location                      | Justification                                                |
| ----------------- | ----------------------------- | ------------------------------------------------------------ |
| `has-session`     | `session.rs`, `connection.rs` | Check if session exists **before** connecting control mode   |
| `new-session`     | `session.rs`                  | Create session **before** control mode attaches              |
| `source-file`     | `session.rs`, `monitor.rs`    | Source config during session creation and initial state sync |
| `kill-session`    | `session.rs`                  | Destroy session (no control mode attached)                   |
| `capture-pane`    | `executor.rs`                 | Initial state capture and scrollback history                 |
| `display-message` | `executor.rs`                 | Query pane metadata (width, history size)                    |
| `list-keys`       | `executor.rs`                 | Read keybindings from tmux config                            |
| `show-options`    | `executor.rs`                 | Read tmux options                                            |
| `list-windows`    | `executor.rs`, `sse.rs`       | `resize_window` fallback; sessions-tree enumeration (`-a`)   |
| `send-keys -l`    | `executor.rs`                 | Mouse event SGR sequences (escape-heavy)                     |
| `list-panes`      | `executor.rs`, `sse.rs`       | Pane info; sessions-tree enumeration (`-a`)                  |
| `list-sessions`   | `sse.rs`                      | Sessions-tree enumeration                                    |
| `load-buffer -`   | `bin/tmuxy-cli` (`pane paste`)| Reads the payload from stdin, which `run-shell` cannot supply. Mutates only the paste buffer, never session/window/pane state, so it does not touch what control mode is tracking. The `paste-buffer` that follows does route through `run-shell`. |

These are safe because they either run **before** control mode connects, are **read-only queries**, or use `send-keys -l` for binary escape sequences that control mode handles differently.

The web server's `RunTmuxCommand` handler (`sse.rs`) normally forwards commands to the control-mode channel fire-and-forget (no stdout back). The three `list-*` reads above are the exception: it runs them as one-off subprocesses via `executor::run_tmux_command_for_session` and returns their stdout, so the frontend's sessions poll can read output on web the same way it does under Tauri. A guard (`is_readonly_query`) rejects compound (`;`) or multiline strings so a mutation can't ride along a read.

### Shell Scripts and `run-shell`

Shell scripts in `bin/tmuxy/` are executed via tmux's `run-shell` command (sent through control mode). Since `run-shell` executes within the tmux server process itself (not as an external subprocess), scripts can safely call tmux CLI commands internally — except `new-window` (see below).

## `new-window` Crashes Control Mode

**Bug:** Sending `new-window` (or `neww`) through control mode stdin crashes the tmux server in tmux 3.5a. This also happens when `new-window` is called from a `run-shell` command while a control mode client is attached.

**Workaround:** Use `split-window` + `break-pane` as a compound command:

```
splitw -t <session> ; breakp
```

This creates a new pane in the current window, then immediately breaks it into its own window — replicating `new-window` behavior without the crash.

**Where it's applied:**

- `packages/tmuxy-core/src/executor.rs` — `new_window_rewrite` builds the `splitw ; breakp` string (with the optional resize) and is the single place the rewrite is spelled out. Both transports call it: the server via `build_new_window_command` in `packages/tmuxy-server/src/sse.rs`, which intercepts any `neww`/`new-window` arriving on `RunTmuxCommand`, and the Tauri app from `packages/tmuxy-tauri-app/src/commands.rs`.
- `bin/tmuxy/` shell scripts — Use `split-window -dP` + `break-pane -d -s $PANE -n name` when creating windows from `run-shell`.
- `tests/helpers/TmuxTestSession.js` — Test session creation uses the same workaround.

## Tauri Desktop App: `new-window` Handling

The Tauri `run_tmux_command` handler (`packages/tmuxy-tauri-app/src/commands.rs`) intercepts `new-window`/`neww` and pushes the `splitw ; breakp` rewrite through the control-mode connection, exactly like the web server. The external `executor::new_window()` path survives only as a pre-connection fallback: it runs before any control-mode client is attached (during early startup, before the monitor connects), where the 3.5a crash — which requires an attached control-mode client — cannot occur. If that fallback ever crashes tmux, the reconnect loop recovers.

The native desktop menu (`packages/tmuxy-tauri-app/src/gui.rs`) does **not** run tmux commands itself. It dispatches every tmux-affecting menu item to the frontend via `window.tmuxyMenuAction`, which routes through the same control-mode-safe adapter path as the in-app menu (including the `new-window` rewrite and the `@tmuxy-window-type` tag).

## Targeting: Use Stable IDs, Not Indices

Always target tmux objects by their **stable identifiers**, not by indices:

| Object  | Stable ID | Unstable Index | Example             |
| ------- | --------- | -------------- | ------------------- |
| Session | name      | —              | `-t mysession`      |
| Window  | `@N`      | `:N`           | `-t @3` not `-t :3` |
| Pane    | `%N`      | `.N`           | `-t %5` not `-t .2` |

Window indices (`:0`, `:1`, `:3`) can shift when windows are created or destroyed. Pane indices (`.0`, `.1`) are relative to the current window and change when panes are added/removed. Session names, window IDs (`@N`), and pane IDs (`%N`) are assigned by tmux at creation and never change.

This matters especially in automation and tests where multiple operations happen in sequence — between a query and the next command, indices may have shifted.

## `%unlinked-window-close` Events

**Behavior:** tmux fires `%unlinked-window-close` (instead of `%window-close`) for windows from **other sessions** sharing the same tmux server. The parser handles both event types (`parser.rs`), but `state.rs` intentionally **ignores** `UnlinkedWindowClose` events to avoid polluting the current session's state with events from other sessions.

`%window-close` handles window removal for the current session. `%unlinked-window-close` is only relevant in multi-session environments and is correctly ignored.

## tmux Configuration

No manual `~/.tmux.conf` changes are required — tmuxy enforces the options it needs automatically. On every session connect, the monitor's initial sync (`sync_initial_state` in `tmuxy-core/src/control_mode/monitor.rs`) sets `window-size manual` and `aggressive-resize off` (so multi-client viewport sizing stays under tmuxy's control), plus `allow-passthrough on`, `mouse on`, `focus-events on`, pane-border options, and title options. Settings are applied per-session rather than globally, to avoid a tmux 3.5a crash triggered by global settings under control mode.

OSC 8 hyperlinks are parsed by tmuxy's own control-mode parser (`tmuxy-core/src/control_mode/osc.rs`), so no `terminal-features` setting is required either.

## Pane Titles

A pane header shows what the running application called itself, falling back to its process name. The two sources disagree often enough that the order matters:

| Source | tmux format | Notes |
|--------|-------------|-------|
| App title | `pane_title` | Set by the application over OSC 0/2 — `nvim README.md`, an ssh host, a Claude Code session summary. |
| Process name | `pane_current_command` | Only the executable's **file name**. A version-pinned launcher symlink (`~/.local/bin/claude` → `…/versions/2.1.251`) reports the version number, which is useless as a label. |

The catch is that tmux **seeds every pane's `pane_title` with the host name**, so a non-empty value does not by itself mean an application set one. Rather than shipping the host name to every client to compare there, the pane enumerations ask tmux to do the comparison and return an empty field when the title is still the seed — `tmux_formats::APP_PANE_TITLE` in `tmuxy-core/src/constants.rs`, mirrored by the `list-panes` formats in `bin/tmuxy-cli` and the sessions-tree poll in `tmuxy-ui/src/machines/actors/serversActor.ts`. All four must stay in step; the `constants.rs` tests guard the Rust pair. The expression must also stay free of shell metacharacters — the sessions poll reaches tmux through `run_tmux_command`, whose `is_readonly_query` guard (`tmuxy-server/src/sse.rs`) rejects any command carrying one, and the rejected poll returns no rows rather than an error.

Downstream, an empty title unambiguously means "no app title", so every consumer resolves `title → command → 'shell'` (`getTabText` in `tmuxy-ui/src/components/paneTabDisplay.ts`). One consequence is inherent to the rule: tmux keeps the last title a pane was given, so a title can outlive the program that set it until the shell's own prompt hook replaces it.

Titles change without any control-mode event, so they ride the regular `list-panes` refresh and the pane delta must carry the `title` field for a change to reach a connected client.

## Flow Control

tmux 3.2+ supports `pause-after` flow control. The monitor configures `pause-after=5` (pause if a client falls 5 seconds behind). When a pane is paused, the monitor responds with `refresh-client -A '%pane:continue'` to resume. This prevents unbounded memory growth during heavy output.

## tmux 3.7a Format Expansion (Critical)

tmux 3.7a expands format strings (`#{...}`) in **more places** than earlier versions. Two of these bit tmuxy in practice; both will affect any code path that upgrades past 3.6b.

### `run-shell` expands its command string

`run-shell "..."` format-expands the whole string before handing it to the shell. A nested `-F '#{pane_id}'` inside a run-shell'd tmux command is therefore pre-expanded against the **currently active pane** — not the pane the inner command creates. This made `float-create` break the _wrong_ pane into the float window.

Rule: inside any `run-shell` string, write `##{...}` — run-shell's expansion halves it to `#{...}` for the inner command. See `bin/tmuxy/float-create` for the canonical example. (3.6b behaves the same; the bug had simply never been triggered through this path before.)

### `send-keys` expands its arguments — and `##` does NOT protect valid variables

On 3.7a, `send-keys -l 'text'` format-expands the literal. Empirically:

| Payload sent   | Pane receives                               |
| -------------- | ------------------------------------------- |
| `#{pane_id}`   | `%0` (expanded)                             |
| `##{pane_id}`  | `#%0` (still expanded!)                     |
| `#{not_a_var}` | `#{not_a_var}` (unknown names pass through) |
| `#(date)`      | `#(date)` (command formats not run)         |

Because doubling the hash does **not** protect a valid variable, the only reliable transport-level fix is to **split the literal into separate `send-keys -l` chunks at every `#`/`{` boundary** so the two characters never share a format context. The v86 client does this in `toControlModeCommand` (`tmuxy-ui/src/tmux/v86/V86TmuxAdapter.ts`); the native server will need the same treatment when it upgrades. On 3.6b, `send-keys -l` does not expand at all.

### Mouse-tracking panes eat pasted SGR sequences — inject with `send-keys -H`

On 3.7a, when a pane's application has enabled mouse reporting (`?1000h`/`?1006h`, i.e. `mouse_any_flag` is set), an SGR mouse sequence (`ESC [< b;x;y M`) delivered to that pane via `paste-buffer` is **consumed by tmux and never reaches the application** — silently, with no error. The same bytes reach a pane that has NOT enabled mouse tracking. This broke tmuxy's synthetic mouse forwarding (browser click → SGR injection), which previously piped through `load-buffer`/`paste-buffer`.

The reliable transport is `send-keys -t <pane> -H <hex bytes>`: raw hex key bytes bypass both the paste path and 3.7a's `send-keys -l` format expansion. The frontend builds these in `tmuxy-ui/src/hooks/scrollUtils.ts` (`sgrMouseCommand`).

One trap: `-H` commands must never be merged by the frontend's send-keys batcher — joining two puts a literal `-H` token mid-keys, tmux rejects it as an unknown key, and the whole combined command fails (a click's press+release land in one batch window, so a plain click would deliver nothing).

### Control-mode stdin wants bare `;` separators

The frontend joins compound commands with a shell-escaped `\;` (correct for commands that pass through a shell or `run-shell` context). But tmux's control-mode line parser treats `\;` as a literal argument, silently erroring the whole command — which orphans the frontend's optimistic state (the "frozen UI after keyboard split" bug). Raw control-mode transports must rewrite the separator to a bare `;` — never inside a `send-keys -l` literal.

## Client-Side Placeholder Substitution

Independent of tmux's own expansion, the frontend substitutes `#{pane_id}`, `#{pane_width}`, and `#{pane_height}` in **every outgoing command** with the active pane's values (`appMachine`'s SEND_TMUX_COMMAND handler). This is deliberate — prefix-binding commands are written against these placeholders — but it means text typed or pasted into a terminal containing those three exact placeholders is substituted before tmux ever sees it, on every transport (server, Tauri, v86).

## Bash Variable Conflicts

`GROUPS` is a bash built-in variable (array of user group IDs). Never use it as a custom variable name in shell scripts executed via `run-shell` — it silently contains the wrong value. Use `GRP_JSON` or similar instead.

## Window Tags (`@tmuxy-*`)

tmuxy marks the windows and panes it manages with tmux user-options under the `@tmuxy-*` namespace. This is the canonical reference for that schema and how the backend, frontend, and shell scripts consume it.

### Filtering rule

**Tabs carry no marker.** Any window in the attached session that is *not* tagged `float`, `float-backdrop`, or `sidebar` is a tab — including foreign windows a user creates with a raw `tmux neww`, which simply appear as tabs. Only the non-tab chrome windows are tagged, and only those are filtered out of the tab strip. Window names are purely cosmetic and never used to infer type.

So the attached session's window list maps 1:1 to the tab strip (minus any open floats), and a native `tmux attach` and tmuxy agree on what the tabs are. Hidden pane-group members live in a separate stash session, so they are not windows in the attached session at all.

### Schema

Window options are scoped per window (`set-option -w -t <window-id>`). The one pane option (`@tmuxy-group-id`) is scoped per pane (`set-option -p -t <pane-id>`).

| Option | Scope | Values | Set on |
|---|---|---|---|
| `@tmuxy-window-type` | window | `float` \| `float-backdrop` \| `sidebar-left` \| `sidebar-right` | non-tab chrome windows only (tabs are untagged) |
| `@tmuxy-float-parent` | window | `@<window-id>` | floats and float-backdrops |
| `@tmuxy-float-width` | window | integer (columns) | floats |
| `@tmuxy-float-height` | window | integer (rows) | floats |
| `@tmuxy-float-drawer` | window | `top` \| `bottom` \| `left` \| `right` \| unset | drawer-style floats |
| `@tmuxy-float-bg` | window | `blur` \| `dim` \| unset | floats with a backdrop |
| `@tmuxy-float-noheader` | window | `1` \| unset | floats that hide the header chrome |
| `@tmuxy-group-id` | pane | `g<n>`, e.g. `g5` | every member of a pane group |
| `@tmuxy-focus-request` | session | `left` \| `right` \| `panes` \| unset | a shell helper asking a client to move keyboard focus |
| `@tmuxy-sidebar-cols` | window | integer (columns) \| unset | a sidebar column the user has dragged off its default width |
| `@tmuxy-sidebar-hidden` | window | `1` \| unset | a sidebar column the user has closed; its pane stays alive, no client draws it |

`@tmuxy-float-parent` is always a **window id**, interpreted by the window's type: on a `float` it is the window the float was launched from (focus returns there on close); on a `float-backdrop` it is the float window the backdrop sits behind. The window-type disambiguates, so there is no separate backdrop-of option.

Drawer direction, backdrop style, and the no-header flag live in their own options rather than being encoded in the window name — float names are user-facing labels (the running command, or a user-set title).

### The two sidebars

Both sidebars are **chrome windows of exactly the same shape as a float**: a single-pane window, broken out and tagged in one atomic command list, excluded from the tab strip, sized to its own column instead of the viewport. They differ only in the tag, the width, and what the pane runs.

| | left (`sidebar-left`) | right (`sidebar-right`) |
|---|---|---|
| Pane runs | `tmuxy widget tree` | the default shell |
| Started in | — | the current pane's directory (a bare `split-window`, like any fresh pane) |
| Width | `sidebar_dock::LEFT_COLS` | `sidebar_dock::RIGHT_COLS` |
| Dragged width | `@tmuxy-sidebar-cols` on its window | same |
| Closing the column | hides it (`@tmuxy-sidebar-hidden`); the widget pane survives | hides it (`@tmuxy-sidebar-hidden`); the shell survives |
| Window name | `__sidebar-left` | `__sidebar-right` |

The left column's pane carries **no content**: `bin/tmuxy/tmuxy-widget-tree` prints the widget marker and blocks, and the UI renders the registered `tree` widget in place of the pane's terminal, deriving the tree from state it already holds. The pane exists so the column has a real pane identity — something `ctrl+hjkl` and `tmuxy nav` can move into, and the backend can size — rather than being invisible to tmux entirely.

Both columns are normally real flex siblings of the pane area, so an open sidebar shrinks the pane container and tmux re-tiles the panes into what is left. Below `SIDEBAR_OVERLAY_MIN_COLS` of terminal content left for the tab, a column stops docking and overlays the panes with a backdrop instead, and only one column may be open (`selectSidebarLayout`).

Neither column draws a header while docked — its title lives in the app header, in a cluster sized to exactly that column's width so the two dividers line up. An overlaying column grows its own header, because there is no app-header room left beside it.

Three consequences for the backend:

- **Sizing.** Every other window is resized to the client viewport (`window-size manual` means tmux sizes nothing on its own). A sidebar window instead gets `sidebar_dock::size(window_type, user_cols, rows)` from `tmuxy-core/src/constants.rs` — its own column width, and the viewport's rows unchanged (a headerless column runs the full height of the app body). Both `control_mode::monitor::apply_client_size` and `executor::resize_window` implement this split, and the widths are mirrored in `tmuxy-ui/src/machines/constants.ts` (`LEFT_SIDEBAR_COLS` / `RIGHT_SIDEBAR_COLS`). If the two sides disagree, the pane wraps at a width the UI does not draw.
- **Resizing.** Dragging a column's inner edge writes `@tmuxy-sidebar-cols` on its window, and the sizing pass above reads it back — so a drag moves the drawn column and the tmux pane together, in whole terminal columns, clamped to `sidebar_dock::MIN_COLS`/`MAX_COLS` (mirrored as `SIDEBAR_MIN_COLS`/`MAX_COLS` in the frontend). Because the width lives on the window rather than in a client, it survives a reload and every client attached to the session draws the column the same. The value must reach the client on BOTH state paths — the control-mode aggregator and the `get_initial_state` snapshot (`executor::get_windows`) — or a client whose baseline is the snapshot draws a resized column at its default width.
- **Keyboard.** A column is focused without `select-pane` — that would switch the active window and blank the tab behind it. Keys reach the right column through the same overlay target a focused float uses (`overlayPaneId` in `machines/actors/keyboardActor.ts`); the left column's tree handles its own keys while focused (j/k/Enter, `l` to hand the keyboard back, `q` to close the column). Neither column claims Escape: a program pinned in a sidebar may need it, so Escape is forwarded like any other key, and leaving a column is Ctrl+h / Ctrl+l, a click on a pane, or the tree's `q`.
- **Focus requests.** Because focusing a column is client-side, a shell helper has no tmux command for it. `bin/tmuxy/nav` instead sets the session-scoped `@tmuxy-focus-request` when the calling pane is at the grid's edge (`#{pane_at_left}` / `#{pane_at_right}` — a `select-pane -L/-R` at the edge *wraps* on current tmux, so "was it a no-op" cannot tell) and that edge has a column, or when the caller is itself inside a column (`$TMUX_PANE`, passed by `tmuxy nav`; run-shell's own `#{pane_id}` is the tab's active pane). It rides the `list-windows` poll (read as a per-window column, set at session scope so every row carries it) and the client that acts on it unsets it. This is what makes `tmuxy nav left` from a shell behave like `Ctrl+h`, which the frontend intercepts before it ever reaches tmux.

Creating a chrome window is one atomic tmux command list: `split-window ; break-pane -d -n <name> [-t :<index>] ; set-option -w -t <target> @tmuxy-window-type <type>`. `break-pane -d` deliberately leaves the session's *current* window alone, so an untargeted `set-option -w` would tag the window the user is looking at instead of the new one — the list has to name the new window. A **float** names a free index up front. A **sidebar** is targeted by its fixed window name (`:__sidebar-left` / `:__sidebar-right`) instead: the client's copy of the window indices goes stale for a beat after any window closes (`renumber-windows on` shifts the rest and `%window-close` carries no indices), and a guessed index tmux already used made `break-pane` fail after `split-window` had run, leaving a raw widget pane in the tab. Tagging inside the same list also means the marker exists before the monitor reacts to `%window-add`, so a chrome window is never briefly rendered as a tab. If the pane never appears (or exits at once — a missing `tmuxy` CLI on the server), the client shows a failure state in the column after a short timeout instead of "starting…".

**Open state.** Because closing a column keeps its pane, the window's existence no longer means "shown": a client derives open = window exists ∧ not `@tmuxy-sidebar-hidden`. Closing sets the option, reopening unsets it, so the choice survives a reload and is the same in every client.

**Keyboard contract while a column has the keyboard.** Plain keys and non-binding chords stay in the column (the tree swallows them; the dock's pane receives them, Escape included). Prefix bindings and root bindings still run, and they act on the *tab grid* — tmux cannot make a chrome window current without blanking the tab, so `prefix %` with the dock focused splits the tab's active pane, not the dock. Leaving a column is Ctrl+h / Ctrl+l (or `l`/`q` in the tree), a click on a pane, or `tmuxy nav`.

**Option writes and latency.** tmux emits no control-mode notification when a user option changes. The monitor therefore re-lists windows right after forwarding any client command that writes a `@tmuxy-*` option, and a shell helper that writes one (`request_focus` in `bin/tmuxy/_lib`) follows it with a harmless `%window-renamed` (renaming a sidebar's chrome window to the name it already has), which the monitor's deferred metadata sync turns into a `list-windows`. Without either, a dragged width or a focus request waited for the idle heartbeat.

### Pane groups and the stash session

Pane groups are **not** a window type. A group is a set of panes sharing a `@tmuxy-group-id` pane option, minted from the anchor pane id (`%5` → `g5`) and unique for the group's life because tmux never reuses pane ids. The **visible** member is an ordinary pane in the attached session; the **hidden** members are parked one-per-window in a dedicated session, `__tmuxy_stash`, which is never attached and is filtered out of every session enumeration (the sidebar tree, `session switch`, the server picker).

Because a pane's options travel with it across a **cross-session `swap-pane`**, switching group tabs moves the target member into the visible slot and the previous one into the stash with no membership bookkeeping — verified behavior on tmux 3.7.

The stash session is created lazily (`new-session -d -s __tmuxy_stash`, control-mode safe) by the `bin/tmuxy/pane-group-*` helpers, which read/write `@tmuxy-group-id` via `show-options -pqv` / `set-option -p` and locate members with `list-panes -a`. Closing a group member runs `gc_groups`, and each `pane-group-add` sweeps first, so hidden members orphaned by a wholesale tab-kill are reaped on the next group operation. Even before that sweep they are invisible: the backend prunes any stash member whose group has no visible pane from the emitted state, so an orphan never renders as a phantom tab.

### How the tags are consumed

The backend (`tmuxy-core`) reads the options off `list-windows` and emits each window's `windowType` on the wire, defaulting an untagged window to `tab` (see `WindowState::to_tmux_window`). The setup pass (`collect_window_tag_commands` in `control_mode/state.rs`) re-tags a float/sidebar window whose option went missing, takes the `pane-border-status` row back off a window that turns out to be a sidebar, and enforces `pane-border-status top` per tab window (a session-level `set` is not inherited by windows), but it never writes a `tab` marker. Hidden group members are enumerated with a separate `list-panes` against the stash session (rows carry a `stashmember,` sentinel) and emitted as lightweight pane stubs carrying `group_id`.

The frontend filters on `windowType`:

- `selectVisibleWindows` (`packages/tmuxy-ui/src/machines/selectors.ts`) keeps only `windowType === 'tab'` windows for the tab strip.
- the sidebar tree (`machines/actors/serversActor.ts`) hides `float` / `float-backdrop` / `sidebar-left` / `sidebar-right` windows and the `__tmuxy_stash` session; everything else (including untagged foreign windows) shows as a tab.
- floats are rebuilt from `windowType === 'float'` windows and their `@tmuxy-float-*` metadata, and each group from the panes sharing a `group_id` (`machines/app/helpers.ts`).

Window/pane mutations go through the optimistic pipeline in `packages/tmuxy-ui/src/tmux/store/` — each op predicts a local patch, dispatches the tmux command, and reconciles against the next server snapshot (`ops.ts`, `TmuxStore.ts`).

### History

`@tmuxy-window-type` replaced the legacy `__float_*` / `__group_*` name-prefix conventions. Two later changes reshaped the scheme: pane groups moved from a `group` window type (plus a `@tmuxy-group-panes` membership list) to the per-pane `@tmuxy-group-id` and the stash session, and the `tab` marker was dropped so an untagged window is a tab. Only `float`, `float-backdrop`, `sidebar-left`, and `sidebar-right` windows carry a type today. The sidebar tag has been through three shapes: a single `sidebar` type first marked the hidden window running the `tmuxy tree` ratatui TUI behind the left drawer; that became a native React tree with no tmux window at all, and `sidebar` was reused for the pinned terminal; today it is split in two, and BOTH columns are panes again — the tree as a `tmuxy widget`, rendered by React but owning a real pane, which is what lets pane navigation reach it.

## Related

- [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) — TmuxMonitor, ControlModeConnection, and command channel details
- [DATA-FLOW.md](DATA-FLOW.md) — How commands flow through control mode in different deployment scenarios
- [SECURITY.md](SECURITY.md) — Security implications of `run-shell` and arbitrary command execution
