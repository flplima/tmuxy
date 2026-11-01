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
| 3.2 | No `%layout-change` after `swap-pane` | The monitor re-lists the panes behind every swap a client sends |
| 3.2 | Emoji sequences get different widths: a ZWJ sequence (`👩‍💻`) and an emoji with a skin tone (`👍🏽`) take 4 columns instead of 2, a text symbol with VS16 (`❤️`) takes 1 instead of 2 | **Known limitation.** tmuxy's emulator follows the 3.4+ rules, so on a line holding such a sequence everything after it renders a column or two off tmux's own grid. CJK, single emoji, flags and combining marks agree. See [RICH-RENDERING.md](RICH-RENDERING-CELL-GRID.md#cell-widths-must-agree-with-tmux) |
| 3.4 | `run-shell` output — and a "returned 1" for a command that failed — is shown in `view-mode` on the target pane rather than handed to the calling client; every key typed afterwards goes to the mode, not the shell | The CLI runs every command it sends through `run-shell` with its output and exit status redirected to files, and prints them itself (`_run_shell` in `packages/tmuxy-cli/bin/tmuxy/_lib`), so `run-shell` has nothing to show. A session restore, which reads what its pane-group park step prints, has it write the answer into the `@tmuxy-restore-answer` server option instead (`ask_run_shell` in `tmuxy-core/src/session_snapshot/restore.rs`). A `run-shell` the UI sends without waiting for its output (a binding, a pane-group or navigation script, the command prompt) runs inside a wrapper that keeps the output and exit status in a per-command `@tmuxy-run-<id>` option, which the same command list reads back; the client shows the output as a notice and a failure as an error (`tmuxy-core/src/control_mode/monitor/run_shell.rs`). That relay runs on every version, so later ones show the output too |
| 3.8 | `#{window_layout}` is JSON (`{"V":2,"L":{…}}`) rather than `csum,WxH,X,Y[…]`, and no earlier tmux's `select-layout` takes it back; `%layout-change` still carries the classic string | Session snapshots store the classic string: `tmuxy-core/src/layout.rs` (`parse_json`) reads the JSON into the same tree the classic parser builds, and serialises it with tmux's checksum. A snapshot saved on 3.8 restores on any supported version |

## `new-window` Crashes Control Mode

**Bug:** Sending `new-window` (or `neww`) through control mode stdin crashes the tmux server in tmux 3.5a. This also happens when `new-window` is called from a `run-shell` command while a control mode client is attached.

**Workaround:** Use `split-window` + `break-pane` as a compound command:

```
splitw -t <session> ; breakp
```

This creates a new pane in the current window, then immediately breaks it into its own window — replicating `new-window` behavior without the crash.

**Where it's applied:**

- `packages/tmuxy-core/src/command_router.rs` — `route_command` finds a `neww`/`new-window` in any client command (also inside a pinned compound or a `{ … }` block, rewritten in place there) and swaps it for the rewrite, via `rewrite_new_window_in_compound` and `new_window_rewrite` in `executor.rs`, the single place the `splitw ; breakp` string (with the optional resize) is spelled out. Both transports route every client command through it.
- `packages/tmuxy-cli/bin/tmuxy/` shell scripts — Use `split-window -dP` + `break-pane -d -s $PANE -n name` when creating windows from `run-shell`.
- `tests/helpers/TmuxTestSession.js` — Test session creation uses the same workaround.

## Tauri Desktop App: `new-window` Handling

The Tauri `run_tmux_command` handler (`packages/tmuxy-tauri-app/src/commands.rs`) routes through `command_router::route_command` like the web server, so a `new-window`/`neww` reaches the control-mode connection as the `splitw ; breakp` rewrite.

The native desktop menus (the macOS menu bar and the native popups) are built by the frontend from its menu spec (`packages/tmuxy-ui/src/domain/menus/`, rendered natively by `infra/menus/nativeMenu.ts`), so every item's callback runs in the page and dispatches through `executeMenuAction` — the same control-mode-safe adapter path as the in-app menu (including the `new-window` rewrite and the `@tmuxy-window-type` tag). The Rust side holds no menu of its own.

## `%unlinked-window-close` Events

**Behavior:** tmux fires `%unlinked-window-close` (instead of `%window-close`) for windows from **other sessions** sharing the same tmux server. The parser handles both event types (`parser.rs`), but `state.rs` intentionally **ignores** `UnlinkedWindowClose` events to avoid polluting the current session's state with events from other sessions.

`%window-close` handles window removal for the current session. `%unlinked-window-close` is only relevant in multi-session environments and is correctly ignored.

## `pane_in_mode` Is Not "In Copy Mode"

`#{pane_in_mode}` is 1 for **every** mode tmux has for a pane — copy-mode, but also
view-mode, tree-mode, buffer-mode and client-mode. The client turns that flag into its own
copy mode, which renders the scrollback and **hides the live terminal**, so a pane in any
other mode disappeared behind a scrollback view that nothing would close.

The pane row therefore asks `#{?#{==:#{pane_mode},copy-mode},1,0}` instead
(`COPY_MODE_FLAG` in `tmuxy-core/src/constants.rs`). It expands to the same single
int-like field, so the row parser's positions and its `@window` anchor are unchanged.

This surfaced on **tmux 3.4**, where a pane landed in `view-mode` as soon as a CLI command
sent through `run-shell` printed anything or failed (the version table above): the whole
terminal rendered as a 0×0 box and never recovered. It was not version-specific in
principle — `prefix s` on any version could do the same — and 3.4 is simply where it was
guaranteed. A lockstep test in `constants.rs`
keeps the format from regressing to the broader field.

## Flow Control

tmux 3.2+ supports `pause-after` flow control. The monitor configures `pause-after=5` (pause if a client falls 5 seconds behind). When a pane is paused, the monitor responds with `refresh-client -A '%pane:continue'` to resume. This prevents unbounded memory growth during heavy output.

## tmux 3.7a Format Expansion (Critical)

tmux 3.7a expands format strings (`#{...}`) in **more places** than earlier versions. Two of these bit tmuxy in practice; both will affect any code path that upgrades past 3.6b.

### `run-shell` expands its command string

`run-shell "..."` format-expands the whole string before handing it to the shell. A nested `-F '#{pane_id}'` inside a run-shell'd tmux command is therefore pre-expanded against the **currently active pane** — not the pane the inner command creates. This made `float-create` break the _wrong_ pane into the float window.

Rule: inside any `run-shell` string, write `##{...}` — run-shell's expansion halves it to `#{...}` for the inner command. `shquote` in `packages/tmuxy-cli/bin/tmuxy-cli` doubles every `#` it interpolates for this reason. (3.6b behaves the same; the bug had simply never been triggered through this path before.) `float-create` was the path that found the bug and no longer needs the escape: it stopped asking run-shell for the new pane's id (see below).

### `run-shell` hands its command no pane, and an outside client has none

The `tmux` a run-shell'd command runs is a client of its own, and run-shell does not set `TMUX_PANE` for it. A target-less `send-keys` or `break-pane` in there is resolved the way tmux resolves anything for an unattached client with no pane: the session with the latest activity. Usually that is the one the user is in — until `pane group add` parks a member in the hidden `__tmuxy_stash` session, after which the stash is "latest" and a `tab create` or `pane send` from a script, a test or an SSH agent lands where no client looks. (Nothing bumps a session's activity back short of a client's key press; `select-window`, `set-option` and the rest leave it alone.)

`packages/tmuxy-cli/bin/tmuxy-cli` therefore resolves the pane it acts on once per invocation when the caller has no `$TMUX_PANE` (a read-only `list-panes -a -f …`, preferring an attached real session, never the stash), exports it, and `run_safe` passes it to the inner client as `TMUX_PANE=%N tmux …` — tmux reads an unattached client's `TMUX_PANE` the way it reads a pane's own. Every `breakp` the CLI issues also names its destination session, `-t '#{session_id}:'`, expanded by run-shell for that pane. Inside a pane none of this changes anything: the caller's pane is the one resolved.

### `send-keys` expands its arguments in the v86 guest — and `##` does NOT protect valid variables

Through the v86 guest's console (tmux 3.7a on a serial line), `send-keys -l 'text'` format-expands the literal. Empirically:

| Payload sent | Pane receives |
| --- | --- |
| `#{pane_id}` | `%0` (expanded) |
| `##{pane_id}` | `#%0` (still expanded!) |
| `#{not_a_var}` | `#{not_a_var}` (unknown names pass through) |
| `#(date)` | `#(date)` (command formats not run) |

Because doubling the hash does **not** protect a valid variable, the only reliable transport-level fix is to **split the literal into separate `send-keys -l` chunks at every `#`/`{` boundary** so the two characters never share a format context. The in-browser guest clients do this in `toControlModeCommand` (`tmuxy-ui/src/infra/transport/drivers/guest/GuestTmuxAdapter.ts`).

The native control-mode path does not need it: a `#{pane_id}` typed at the prompt reaches the shell verbatim on 3.8 and on every tmux the per-commit and nightly suites run, which `tests/1-input-interaction-keys.test.js` ("typed text reaches the shell verbatim") checks on each of them. Should a tmux ever expand it there, that test is where it shows.

### Mouse-tracking panes eat pasted SGR sequences — inject with `send-keys -H`

On 3.7a, when a pane's application has enabled mouse reporting (`?1000h`/`?1006h`, i.e. `mouse_any_flag` is set), an SGR mouse sequence (`ESC [< b;x;y M`) delivered to that pane via `paste-buffer` is **consumed by tmux and never reaches the application** — silently, with no error. The same bytes reach a pane that has NOT enabled mouse tracking. This broke tmuxy's synthetic mouse forwarding (browser click → SGR injection), which previously piped through `load-buffer`/`paste-buffer`.

The reliable transport is `send-keys -t <pane> -H <hex bytes>`: raw hex key bytes bypass both the paste path and 3.7a's `send-keys -l` format expansion. The frontend builds these in `tmuxy-ui/src/hooks/scrollUtils.ts` (`sgrMouseCommand`).

One trap: `-H` commands must never be merged by the frontend's send-keys batcher — joining two puts a literal `-H` token mid-keys, tmux rejects it as an unknown key, and the whole combined command fails (a click's press+release land in one batch window, so a plain click would deliver nothing).

### Control-mode stdin wants bare `;` separators

The frontend joins compound commands with a shell-escaped `\;` (correct for commands that pass through a shell or `run-shell` context). But tmux's control-mode line parser treats `\;` as a literal argument, silently erroring the whole command — which orphans the frontend's optimistic state (the "frozen UI after keyboard split" bug). Raw control-mode transports must rewrite the separator to a bare `;` — never inside a `send-keys -l` literal.

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

Independent of tmux's own expansion, the frontend substitutes `#{pane_id}`, `#{pane_width}`, and `#{pane_height}` in **every outgoing command** with the active pane's values (`appMachine`'s SEND_TMUX_COMMAND handler). This is deliberate — prefix-binding commands are written against these placeholders — but it means text typed into a terminal containing those three exact placeholders is substituted before tmux ever sees it, on every transport (server, Tauri, v86). A paste is exempt: it travels with `#` and `{` as octal escapes (see `pastedText`), so the placeholder never appears in the command.

## Bash Variable Conflicts

`GROUPS` is a bash built-in variable (array of user group IDs). Never use it as a custom variable name in shell scripts executed via `run-shell` — it silently contains the wrong value. Use `GRP_JSON` or similar instead.
