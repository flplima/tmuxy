# tmux Versions, Bugs and Workarounds

Version-specific tmux behaviour tmuxy depends on or works around. Part of [TMUX.md](TMUX.md).

## tmux Version

Tmuxy targets **tmux 3.7a** (devcontainer, CI, and the in-browser v86 guest all build it from source). Several workarounds below were discovered on 3.3a/3.5a and are kept because they remain safe on 3.7a.

The minimum is **tmux 3.2**. The desktop app and `tmuxy server` run `tmux -V` at startup and refuse an older or missing tmux with a message saying how to install or update it — a dialog on the desktop, stderr for the server (`tmuxy-core/src/tmux_check.rs`). A build that reports no version number (`tmux master`) is accepted. The Homebrew cask and the `.deb`/`.rpm` packages declare tmux as a dependency.

3.2 is the floor because control-mode flow control (`pause-after`) and format subscriptions (`refresh-client -B`) arrived in it, and because it is what Ubuntu 22.04 LTS ships — the oldest system the AppImage catalog tests on. The nightly matrix runs 3.2a alongside 3.4, 3.5a, 3.7a and 3.8 (what Homebrew ships), the full E2E suite on each, so the floor and the newest release are both versions something exercises. Every push also runs the snapshot and alternate-screen suites on 3.4 — the tmux Ubuntu ships, and the version two product bugs were specific to — as the `tmux-3.4` entry of the E2E matrix (`tests/e2e-suites.json`).

What differs between the supported versions, and how tmuxy copes (the commands tmux does not announce, which the monitor re-lists behind, are one table: `tmuxy-core/src/tmux_compat.rs`):

| tmux | Difference | tmuxy |
| --- | --- | --- |
| 3.2 | No `allow-passthrough` option (passthrough is always on) | The monitor sets it with `set -q`, which an older tmux skips silently |
| 3.2 | No `%layout-change` after `swap-pane` | The monitor re-lists the panes behind every swap a client sends, unless the server said it is 3.3 or later (`TmuxCaps::announces_pane_swaps`) |
| 3.2 | Emoji sequences get different widths: a ZWJ sequence (`👩‍💻`) and an emoji with a skin tone (`👍🏽`) take 4 columns instead of 2, a text symbol with VS16 (`❤️`) takes 1 instead of 2 | **Known limitation.** tmuxy's emulator follows the 3.4+ rules, so on a line holding such a sequence everything after it renders a column or two off tmux's own grid. CJK, single emoji, flags and combining marks agree. See [RICH-RENDERING.md](RICH-RENDERING-CELL-GRID.md#cell-widths-must-agree-with-tmux) |
| 3.6 | An emoji followed by its skin-tone modifier (`👍🏽`) takes 4 columns: the modifier stays its own 2-column character (measured on 3.6a; the modifier before the emoji, ZWJ sequences, flags and VS16 combine as on 3.4 and 3.7) | **Known limitation**, as for 3.2: tmuxy's emulator follows 3.4 and 3.7, so on such a line everything after the sequence renders two columns off tmux's grid |
| 3.4 | `run-shell` output — and a "returned 1" for a command that failed — is shown in `view-mode` on the target pane rather than handed to the calling client; every key typed afterwards goes to the mode, not the shell | The CLI runs every command it sends through `run-shell` with its output and exit status redirected to files, and prints them itself (`_run_shell` in `packages/tmuxy-cli/bin/tmuxy/_lib`), so `run-shell` has nothing to show. A session restore, which reads what its pane-group park step prints, has it write the answer into a `@tmuxy-restore-answer-<session>` server option instead (`ask_run_shell` in `tmuxy-core/src/session_snapshot/restore.rs`). A `run-shell` the UI sends without waiting for its output (a binding, a pane-group or navigation script, the command prompt) runs inside a wrapper that keeps the output and exit status in a per-command `@tmuxy-run-<id>` option, which the same command list reads back; the client shows the output as a notice and a failure as an error (`tmuxy-core/src/control_mode/monitor_core/run_shell.rs`). That relay runs on every version, so later ones show the output too |
| 3.8 | `#{window_layout}` is JSON (`{"V":2,"L":{…}}`) rather than `csum,WxH,X,Y[…]`, and no earlier tmux's `select-layout` takes it back; `%layout-change` still carries the classic string | Session snapshots store the classic string: `tmuxy-core/src/layout.rs` (`parse_json`) reads the JSON into the same tree the classic parser builds, and serialises it with tmux's checksum. A snapshot saved on 3.8 restores on any supported version |
| 3.7 and earlier | A notification raised while a command runs can arrive inside that command's `%begin`/`%end` block. 3.8 queues it until the block has closed (tmux issue 5458) | Inside a block every line is the reply's body, since a capture's own text can read `%output …` or `%end …` too: such a notification is part of the reply, and the pane's next output or capture brings it up to date. Pinned by `control_mode/parser/tests.rs` (`a_notification_queued_before_or_after_a_reply_is_read_as_one`, `before_tmux_3_8_a_notification_inside_a_reply_is_its_body`) |
| 3.7 and earlier | A command template puts `%%` in unescaped, so `'%%'` in a `choose-window` or `command-prompt` template ends its quote at a `'` in a session name, and the rest runs as tmux commands, `run-shell` included: a crafted session name runs a shell command when one of its windows is picked. 3.8 escapes `%%` for single quotes | Every shipped template takes its input as `"%%%"`, which tmux escapes on every supported version (`tmuxy.defaults.conf`). `tests/conf_templates.rs` checks no shipped config quotes `%%` in single quotes, and drives `choose-window` on a real tmux in a session named `it's` and in one crafted to run `run-shell` (it does with `'%%'` before 3.8, never with `"%%%"`) |
| 3.8 and earlier | A server whose own working directory has become unreadable, such as the FUSE mount of an AppImage that has since exited, skips the change of directory for every new pane: `getcwd` fails, so tmux never calls `chdir`. Each new shell starts in the dead directory, whatever `-c` or the session's start directory say, and bash prints `getcwd: cannot access parent directories`. tmux's master branch falls back to `/` | No command reaches a running server's own directory, so tmuxy never starts one there: `spawn_tmux` (`tmuxy-core/src/control_mode/connection/spawn.rs`) starts tmux outside the AppImage's mount (`appimage_env::working_dir_outside_appdir`). A server an older build started inside the mount has to be restarted |

## Version Capabilities

Most differences above are handled without knowing the version: a `-q`, a re-list, a layout read by its shape. Where knowing it lets tmuxy skip work or use something newer, it asks. When the monitor attaches, it prints `#{version}` behind a marker of its own (`Markers::version_read_command` in `tmuxy-core/src/control_mode/state/markers.rs`). The answer becomes the aggregator's `TmuxCaps` (`tmuxy-core/src/tmux_compat/caps.rs`). Since the server expands it, a server reached over SSH is judged by its own tmux, not by the one on this machine.

Until the answer comes, every workaround stays on: an unknown version counts as the oldest supported one. A build of tmux's development branch (`master`) counts as the newest; a distribution's own tag (`openbsd-7.4`) says nothing of the tmux behind it and counts as unknown. `next-3.8` and `3.8-rc` read as 3.8.

| Capability | From | What it changes |
| --- | --- | --- |
| `announces_pane_swaps` | 3.3 | No pane re-list behind a `swap-pane`: the `%layout-change` brings it (tmux queues it, so it can come after the next reply) |

`tests/tmux_caps.rs` checks each row against the tmux it runs on, so the nightly matrix checks it on every supported version.

## `new-window` Crashes Control Mode

**Bug:** Sending `new-window` (or `neww`) through control mode stdin crashes the tmux server in tmux 3.5a. This also happens when `new-window` is called from a `run-shell` command while a control mode client is attached.

**Workaround:** Use `split-window` + `break-pane` as a compound command:

```
splitw -t <session> ; breakp
```

This creates a new pane in the current window, then immediately breaks it into its own window — replicating `new-window` behavior without the crash.

**Where it's applied:** `route_command` (`packages/tmuxy-core/src/command_router.rs`) finds a `neww`/`new-window` in any client command — inside a pinned compound or a `{ … }` block too — and swaps it for the rewrite, via `CommandList::rewrite_new_window` in `tmux_command.rs` (the one tmux command-list grammar). `NewTab` (`packages/tmuxy-core/src/tmux_command/new_tab.rs`) is the single place the `splitw ; breakp` list (with its optional resize) is spelled, for the rewrite, `tmuxy tab create` and the MCP's `tab_create` alike. Both transports reach it through `tmuxy_core::host::handle` — the web server's `/commands` route and the desktop's `dispatch` command (`packages/tmuxy-tauri-app/src/commands.rs`) — so no client path to tmux bypasses it. The E2E suite's sessions are created by the server itself (`tests/helpers/TmuxTestSession.js`), through the `-CC new-session` that opens the connection.

## Tauri Desktop App: `new-window` Handling

The native desktop menus (the macOS menu bar and the native popups) are built by the frontend from its menu spec (`packages/tmuxy-ui/src/components/menus/specs/`, rendered natively by `infra/menus/nativeMenu.ts`), so every item's callback runs in the page and dispatches through `useMenuDispatch` (`components/menus/SpecMenu.tsx`) — the same control-mode-safe path as the in-app menu, rewrite and `@tmuxy-window-type` tag included. The Rust side holds no menu of its own.

## `%unlinked-window-close` Events

**Behavior:** tmux fires `%unlinked-window-close` (instead of `%window-close`) for windows that are not the current one, in **any session** sharing the same tmux server. The parser handles both event types (`parser.rs`). The aggregator (`control_mode/state/events.rs`) removes the window only when it already knows it — a window it listed is one of this session's — and ignores one it never saw, which belongs to another session.

## `pane_in_mode` Is Not "In Copy Mode"

`#{pane_in_mode}` is 1 for **every** mode tmux has for a pane — copy-mode, but also
view-mode, tree-mode, buffer-mode and client-mode. The client turns that flag into its own
copy mode, which renders the scrollback and **hides the live terminal**, so a pane in any
other mode disappeared behind a scrollback view that nothing would close.

The pane row therefore asks which mode the pane is in — copy mode, view mode, or
anything else — as one int (`PANE_MODE_FLAG` in `tmuxy-core/src/constants/tmux_formats.rs`).
It expands to the same single int-like field, so the row parser's positions and its
`@window` anchor are unchanged. `%pane-mode-changed` only asks for the pane's row again;
the row is the one source of the mode (see `control_mode/state/events.rs`).

View mode is where `run-shell` output lands on tmux 3.4 (the version table), and `prefix s` opens tree mode on any version; either would hide the live terminal behind a scrollback view nothing closes if the row reported only `pane_in_mode`. A lockstep test in `constants/tests.rs` keeps the format from regressing to the broader field.

### View mode is closed, with a notice

View mode still reaches a tmuxy pane on every version: a `run-shell -b` that prints opens
one on the current pane (`cmd_run_shell_print` with no command item — the relay in
`control_mode/monitor_core/run_shell.rs` leaves `-b` alone, since nobody waits for it), a plugin or tmux.conf
binding doing the same, or a terminal client attached to a grouped session. tmuxy draws
no view mode, and `capture-pane` reads the pane's own grid, never a mode's text, so the
pager cannot be shown either. Left open, every key goes to it, and `:` opens a prompt on
the control client that stalls tmux.

When a pane row first reports view mode, the aggregator asks `list-clients` who is
attached (a marker-wrapped in-band read, like the yank mirror's `show-buffer`). With only
control clients on the session and its group, it resets the pane's modes with
`copy-mode -q` — which needs no client terminal and is safe through control mode on every
version — and shows a notice saying the view was closed. A terminal client of the session
(or of one grouped with it) sees the pager and can close it, so its listing is kept.

Prompt commands that print (`show-messages`, `list-keys`) never open a view for a control
client: tmux answers them inside the command's reply. The monitor shows that reply as a
notice (`control_mode/monitor_core/replies.rs`, the `ReportFailure` waiter), clipped like a `run-shell`'s
output, instead of dropping it. `prefix ?` is a client key and never reaches tmux; the
help modal is native.

## Flow Control

tmux 3.2+ supports `pause-after` flow control. The monitor configures `pause-after=5` (pause if a client falls 5 seconds behind). When a pane is paused, the monitor responds with `refresh-client -A '%pane:continue'` to resume. This prevents unbounded memory growth during heavy output.

## tmux 3.7a Format Expansion (Critical)

tmux 3.7a expands format strings (`#{...}`) in **more** places than earlier versions. The rules below hold on every supported version.

### `run-shell` expands its command string

`run-shell "..."` format-expands the whole string before handing it to the shell, against the **currently active pane** — so a nested `-F '#{pane_id}'` names that pane, not the one the inner command creates. Rule: inside any `run-shell` string, write `##{...}`, which the expansion halves to `#{...}` for the inner command; `shquote` in `packages/tmuxy-cli/bin/tmuxy/_lib` doubles every `#` it interpolates for this reason.

### `run-shell` hands its command no pane, and an outside client has none

The `tmux` a run-shell'd command runs is a client of its own, and run-shell does not set `TMUX_PANE` for it. A target-less `send-keys` or `break-pane` in there resolves as for any unattached client with no pane: to the session with the latest activity — which, once `pane group add` has parked a member in the hidden `__tmuxy_stash` session, is the stash. (Nothing bumps a session's activity back short of a client's key press; `select-window`, `set-option` and the rest leave it alone.)

Rule: `packages/tmuxy-cli/bin/tmuxy-cli` resolves the pane it acts on once per invocation when the caller has no `$TMUX_PANE` (a read-only `list-panes -a -f …`, preferring an attached real session, never the stash), exports it, and `run_safe` passes it to the inner client as `TMUX_PANE=%N tmux …` — tmux reads an unattached client's `TMUX_PANE` the way it reads a pane's own. Every `breakp` the CLI issues also names its destination session, `-t '#{session_id}:'`, expanded by run-shell for that pane.

### `send-keys` expands its arguments in the v86 guest — and `##` does NOT protect valid variables

Through the v86 guest's console (tmux 3.7a on a serial line), `send-keys -l 'text'` format-expands the literal:

| Payload sent | Pane receives |
| --- | --- |
| `#{pane_id}` | `%0` (expanded) |
| `##{pane_id}` | `#%0` (still expanded!) |
| `#{not_a_var}` | `#{not_a_var}` (unknown names pass through) |
| `#(date)` | `#(date)` (command formats not run) |

Rule: split the literal into separate `send-keys -l` chunks at every `#`/`{` boundary, so the two characters never share a format context. The router does this for every transport (`split_format_literals` in `packages/tmuxy-core/src/tmux_compat.rs`, applied by `command_router::route_command`); the in-browser guests route through the same function, compiled to wasm. The native control-mode path has not been seen to expand typed text — `tests/1-input-interaction-keys.test.js` ("typed text reaches the shell verbatim") checks it on every tmux the suites run — and one rule for every transport means a tmux that starts expanding is covered already.

### Mouse-tracking panes eat pasted SGR sequences — inject with `send-keys -H`

On 3.7a, an SGR mouse sequence (`ESC [< b;x;y M`) delivered by `paste-buffer` to a pane whose application has enabled mouse reporting (`mouse_any_flag`) is consumed by tmux and never reaches the application, with no error. Rule: a synthetic mouse event goes as `send-keys -t <pane> -H <hex bytes>` — raw hex key bytes bypass both the paste path and 3.7a's `send-keys -l` expansion. The frontend builds these in `tmuxy-ui/src/domain/commandHelpers.ts` (`mouseReport`, for the `SendMouse` op). The keystroke batcher (`tmuxy-ui/src/infra/transport/keyBatching.ts`) joins only `SendKeys` and `SendText` ops, so a `SendMouse` is never merged into another send-keys: a `-H` token mid-keys is a key tmux does not know, and the whole command would fail.

## `list-keys` Reports Aliases Already Expanded

A `command-alias` is a config-time convenience, not something the client ever
sees. `bind -n C-l tmuxy-nav-right` reads back through `list-keys` — the source
the frontend builds its binding table from — as the alias's **expansion**:
`run-shell "bash …/bin/tmuxy/nav right #{pane_id}"`, the data dir in place of
the `$TMUXY_DATA_DIR` the alias names.

This matters because the client classifies each binding's command to decide
whether it can predict the result optimistically
(`tmuxy-ui/src/domain/store/parseCommand.ts`). Anything it fails to recognise
becomes a `RawCommand` — correct, but unpredicted, so the user waits out the
full round trip instead of seeing the result on the next frame. Matching only
the alias spelling is therefore a silent latency bug, not a parse error: the
key still works, it is just several hundred milliseconds slower. Any classifier
that keys off a bound command must match the **expanded** form (and may accept
the alias too, for commands built in-code).

## Client-Side Placeholder Substitution

Independent of tmux's own expansion, the frontend substitutes `#{pane_id}`, `#{pane_width}`, and `#{pane_height}` in every command that arrives as a string (`SEND_TMUX_COMMAND`: a binding, a command typed at the prompt) with the active pane's values (`expandPaneFormats` in `machines/app/dispatch.ts`). This is deliberate — prefix-binding commands are written against these placeholders. Typed text and pastes are ops (`SendText`, `PasteText`), never strings, so a placeholder in them reaches tmux as typed.

## Bash Variable Conflicts

`GROUPS` is a bash built-in variable (array of user group IDs). Never use it as a custom variable name in shell scripts executed via `run-shell` — it silently contains the wrong value. Use `GRP_JSON` or similar instead.
