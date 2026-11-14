# Window and Pane Tags (`@tmuxy-*`)

The `@tmuxy-*` tag schema and the pane-group model built on it. Part of [TMUX.md](TMUX.md).

## Window Tags (`@tmuxy-*`)

tmuxy marks the windows and panes it manages with tmux user-options under the `@tmuxy-*` namespace. This is the canonical reference for that schema and how the backend, frontend, and shell scripts consume it.

### Filtering rule

**Tabs carry no marker.** Any window in the attached session that is _not_ tagged `float`, `sidebar-left` or `sidebar-right` is a tab — including foreign windows a user creates with a raw `tmux neww`, which simply appear as tabs. Only the non-tab chrome windows are tagged, and only those are filtered out of the tab strip. Window names are purely cosmetic and never used to infer type.

So the attached session's window list maps 1:1 to the tab strip (minus any open floats), and a native `tmux attach` and tmuxy agree on what the tabs are. Hidden pane-group members live in a separate stash session, so they are not windows in the attached session at all.

### Schema

Window options are scoped per window (`set-option -w -t <window-id>`). The pane options (`@tmuxy-group-id`, `@tmuxy-group-pos`, `@tmuxy-pane-state`, `@tmuxy-pane-status`, `@tmuxy-ask`, `@tmuxy-ask-answer`, `@tmuxy-pane-widget`) are scoped per pane (`set-option -p -t <pane-id>`).

| Option | Scope | Values | Set on |
| --- | --- | --- | --- |
| `@tmuxy-window-type` | window | `float` \| `sidebar-left` \| `sidebar-right` | non-tab chrome windows only (tabs are untagged) |
| `@tmuxy-float-parent` | window | `@<window-id>` | floats |
| `@tmuxy-float-width` | window | integer (columns) | floats; its window is sized to it ([TMUX-SIDEBARS.md](TMUX-SIDEBARS.md), Sizing) |
| `@tmuxy-float-height` | window | integer (rows) | floats, likewise |
| `@tmuxy-float-drawer` | window | `top` \| `bottom` \| `left` \| `right` \| unset | drawer-style floats |
| `@tmuxy-float-bg` | window | `blur` \| `dim` \| unset | floats with a backdrop |
| `@tmuxy-float-noheader` | window | `1` \| unset | floats that hide the header chrome |
| `@tmuxy-float-minimized` | window | `1` \| unset | a float in the queue at its tab's bottom edge; its pane runs on |
| `@tmuxy-group-id` | pane | `g<n>`, e.g. `g5` | every member of a pane group |
| `@tmuxy-group-pos` | pane | integer (0 is first) \| unset | a member's place in its group, once the group was reordered or joined; members without one follow, by pane id |
| `@tmuxy-group-rev` | global | opaque \| unset | bumped by the group scripts after a change tmux does not announce, so the pane-metadata subscription fires (every pane inherits it) |
| `@tmuxy-plugins` | global | base64 of a JSON array `[{name, actions: [{id, title, menu?, surface}]}]` \| unset | the installed plugins' actions, for the menus; written by `tmuxy plugin install\|update\|remove`, `tmuxy config reload` and every server as it attaches ([PLUGINS.md](PLUGINS.md)). Read by the client with one query, never subscribed to |
| `@tmuxy-plugins-rev` | global | 16 hex digits (a hash of the inventory) \| unset | changes exactly when `@tmuxy-plugins` does; rides the pane-metadata subscription and the `list-panes` rows, so a client re-reads the inventory within a second |
| `@tmuxy-cli` | global | the bundled CLI's absolute path (`<data>/bin/tmuxy-cli`) | set by the entry file beside `TMUXY_DATA_DIR`; a plugin key names the CLI by it (`#{q:@tmuxy-cli}`), because the client runs a binding as `list-keys` prints it and tmux before 3.5 prints a `$` in a form that does not parse back (`plugins/keys.rs`) |
| `@tmuxy-config-dir` | global | the config directory | set by the entry file ([PERMISSIONS.md](PERMISSIONS.md)) |
| `@tmuxy-pane-state` | pane | `idle` \| `working` \| `needs-input` \| `error` \| `unread` \| unset | what the pane says it is doing; set by whatever runs in it |
| `@tmuxy-pane-status` | pane | report body \| unset | what the pane's program said behind its state with OSC 7501; written by the host that read it |
| `@tmuxy-meta` | pane | base64 JSON | `tmuxy pane meta` (`tmuxy-core/src/pane_meta.rs`) |
| `@tmuxy-ask` | pane | base64 of `{token, caller, keys}` or `{token, kind: "offer", command}` \| unset | a send into this pane waiting on the user (`tmuxy pane send -t`), or a command a session restore offers to run again (the client shows it as a one-line banner and runs or drops it itself) |
| `@tmuxy-ask-answer` | pane | `<token>:yes` \| `<token>:no` \| unset | the answer a client recorded for the pending `@tmuxy-ask` |
| `@tmuxy-pane-widget` | pane | a widget name, e.g. `tree` \| unset | which widget this pane may render; written by `tmuxy-widget` and cleared when it exits |
| `@tmuxy-pane-preview` | pane | an absolute path \| unset | the one file a `preview` pane may read (`tmuxy open`); written by `tmuxy-widget-preview` and cleared when it exits, honoured only while `@tmuxy-pane-widget` is `preview` (see [A Preview Reads One File](SECURITY-CONTENT.md#a-preview-reads-one-file)) |
| `@tmuxy-pane-preview-net` | pane | `1` \| unset | the preview was opened with `--net`: its page may load from the network |
| `@tmuxy-pane-restore` | pane | a shell line \| unset | how to bring this pane back after a session restore (`tmuxy pane restore-cmd`); set by the program itself, wins over what `ps` finds. See `tmuxy_core::session_snapshot` |
| `@tmuxy-focus-request` | session | `left` \| `right` \| `panes` \| unset | a shell helper asking a client to move keyboard focus |
| `@tmuxy-sidebar-cols` | window | integer (columns) \| unset | a sidebar column the user has dragged off its default width — for the dock these are its own cells: the right column runs in the sidebar font (80% of the pane font), so its cell width is the pane grid's advance scaled to that size (`selectSidebarCellMetrics`) |
| `@tmuxy-sidebar-hidden` | window | `1` \| unset | a sidebar column the user has closed; its pane stays alive, no client draws it |
| `@tmuxy-collapsible` | window | `1` \| unset | collapsible panes: only the first-level row holding the active pane is expanded (see below) |
| `@tmuxy-sidebar-rows` | window | integer (rows) \| unset | rows the dock's pane is sized to; the client sets it from its own (shorter, sidebar-font) row height, so the column holds more rows than the viewport |

`@tmuxy-float-parent` is the **window id** of the window the float was launched from; focus returns there when the float closes. A float's backdrop is a style of the float (`@tmuxy-float-bg`), not a window of its own.

`@tmuxy-pane-state` is the pane's own word: whatever runs in a pane declares its state through `tmuxy pane state <value>`, or in its output with OSC 7501 ([RICH-RENDERING.md](RICH-RENDERING.md#program-status-osc-7501)), a shell says a long command ended with OSC 133 ([PROMPT-MARKS.md](PROMPT-MARKS.md)), and the sidebar tree draws it at the row's right edge. An agent sets it from its hooks, a shell from a `precmd`/`preexec` pair, a build script on failure. Activity never infers it — tmux's activity flag means "bytes arrived", which a spinner produces continuously, so activity cannot tell working from waiting. The one thing read off a screen is an agent's approval dialog (below).

**Coding agents.** `tmuxy agent install [claude|codex|agy]` puts tmuxy into an agent's own lifecycle hooks — Claude Code's `settings.json`, Codex's `hooks.json`, Antigravity's `hooks.json`; the home directory's by default, the project's with `--project` — and installs the tmuxy skill beside them. Every installed hook is the same bare command, `tmuxy agent hook <agent> <event>`, called through `tmuxy` on PATH and guarded so that settings synced to a machine without tmuxy do nothing there: what an event means (`working` on a prompt or a finished tool call, `needs-input` on a permission request, `idle` on stop, `error` on a failed turn, unset when the session ends) is decided by the server binary when the hook fires (`tmuxy-verbs/src/agents.rs`), so an upgrade changes behaviour without a reinstall and uninstall finds tmuxy's entries by that command alone. The hook script (`packages/tmuxy-cli/bin/tmuxy/agent-hook`) never makes the agent wait on tmux: it records the wanted state and applies it from a background job, writing only when tmux says otherwise — never from a remembered last write, since the screen and a send's question write the state too — and outside a tmuxy pane it does nothing. `tmuxy agent status` says if each item is current ([AGENT-SETUP.md](AGENT-SETUP.md)).

**Dialogs, from the screen.** Antigravity has no hook for a permission prompt, and Claude Code and Codex fire none when one is answered — the next hook is the tool finishing. So the host — the web server or the desktop app, whichever is up — reads the bottom of every agent pane a hook has marked, every 1.5 s, and corrects the state on one sign: an approval dialog (a numbered menu with its cursor, a dialog's question over a "Yes", a `(y/n)`). A dialog on screen is `needs-input`; one it saw go away is `working`. Nothing else on a screen is trusted, and a pane holding a send's question is left alone (`tmuxy-core/src/host/socket_watch/agent_screen.rs`, fed by the one `list-panes -a` poll in `host/socket_watch.rs`). The same split — hooks for the turn, the screen for dialogs — is what other tmux tools for agents use. Remaining gap: a turn interrupted with Esc fires no Claude Code hook, so the pane reads `working` until the next prompt. Agents with no hooks get a state from their screens too ([SCREEN-RULES.md](SCREEN-RULES.md)).

**Closing a `working` or `needs-input` pane asks first** (`@tmuxy-confirm-close`, [STATE-MANAGEMENT-ACTORS.md](STATE-MANAGEMENT-ACTORS.md)).

**A finished agent is idle.** An agent only ever says `idle` when it stops, and that is what its pane shows, whether or not the user was looking: the state mark goes and the process icon comes back, with nothing left to dismiss. `unread` is a send's: one that skips its question (`@tmuxy-send-ask off`, `@tmuxy-send-allow`) marks the target `unread`, so keys never land in a pane unseen, and the client clears it once that pane is in front. The value rides the ordinary `list-panes` subscription (it is a fixed tail field, like `@tmuxy-group-id`) and is carried verbatim. The words are core's `PaneStateName` (`tmuxy-core/src/state_types.rs`), and everything reads them the same exact way: `tmuxy pane state` refuses any other word with exit 2, and a word written past the CLI with a raw `set-option` is `idle` in the tab and no state at all to the push notification and the screen corrector. As with every user option, tmux emits no notification when it changes — the value lands on the next metadata sync, which any pane producing output triggers continuously.

`@tmuxy-pane-widget` is what makes a widget a widget. The `__TMUXY_WIDGET__:<name>` marker a widget prints is ordinary pane **output**, and anything a pane prints carries the same weight — a crafted file passed to `cat`, a commit message in `git log`, an ssh MOTD. So the marker alone renders nothing: the client honours it only when this option, written out of band by `tmuxy-widget` through `run-shell`, names the same widget. It rides the `list-panes` tail like `@tmuxy-pane-state`, and `tmuxy-widget` unsets it on the way out, so a pane that has gone back to being a shell cannot print its way into a widget again.

On a float the parent is also **which tab the float belongs to**. A float is an overlay over the tab it was opened from, not over the session: the client shows only the floats whose parent is the active window (`selectVisibleFloats`), so one opened on tab 1 is off screen on tab 2 and comes back when that tab does. A float with no parent, or whose parent window has since closed, is shown on every tab — an orphan nothing could bring on screen could not be closed either. Its backdrop is rendered inside the pane container rather than portaled to the document body, so it dims that tab's content and leaves the sidebars, the tab strip and the status line usable.

Drawer direction, backdrop style, and the no-header flag live in their own options rather than being encoded in the window name — float names are user-facing labels (the running command, or a user-set title).

See [TMUX-SIDEBARS.md](TMUX-SIDEBARS.md) for these sections: The two sidebars; Sends into another pane (`tmuxy pane send -t`).

### Collapsible panes

A window tagged `@tmuxy-collapsible` keeps only the **first-level** row that holds the active pane expanded; every other first-level row collapses to one line per pane, which the UI draws as just the header. "First level" is the root of tmux's layout tree when it is a vertical stack (`[…]` in `#{window_layout}`): a row that is itself a nested split collapses as a unit and keeps its inner proportions, and navigating among panes inside the expanded row changes nothing.

The backend owns the reshaping (`tmuxy-core/src/layout.rs`, `collapsible_layout_commands` in `control_mode/state.rs`): it parses the layout string, edits the first-level heights, re-serialises it with tmux's checksum and sends `select-layout`. It runs on focus changes, layout changes and option changes, and is idempotent, so the `%layout-change` its own command causes never echoes another. Zoomed windows are left alone.

PANE mode's `s` (`tmuxy-stack`) sets the option and adds a full-width row below (`split-window -v -f`); its `S` (`tmuxy-stack-toggle`) flips it, and turning it off evens the first-level rows back out. The tab's context menu toggles the same option.

### The marked pane

tmux's marked pane (`select-pane -m`, cleared with `select-pane -M`; `prefix m` / `prefix M` by default) is carried on the wire as `#{pane_marked}` in the fixed tail of the monitor's `list-panes` format, so a mark set from any client — a plain `tmux` too — shows in every tmuxy client. The UI draws a flag in the pane header and the sidebar tree row and an outline on the pane (`--pane-marked-border`, themed). The pane context menu offers _Mark/Unmark Pane_, _Swap with Marked Pane_ and _Join Marked Pane Here_, which run bare `swap-pane` / `join-pane`: without `-s`, tmux takes the marked pane as the source.

### Pane groups and the stash session

In [TMUX-TAGS-GROUPS.md](TMUX-TAGS-GROUPS.md), this doc's companion: the group id and order tags, the stash session, and where the group rules live.

### How the tags are consumed

The backend (`tmuxy-core`) reads the options off `list-windows` and emits each window's `windowType` on the wire, defaulting an untagged window to `tab` (see `WindowState::to_tmux_window`). The setup pass (`window_setup_commands` in `control_mode/state/window_state.rs`) sets each window's options once (a window's type is only ever its tag: every float and sidebar is tagged in the command list that creates it, so a list never shows one untagged) — `window-size manual` and `aggressive-resize off` on every window, `pane-border-status top` on a tab (a session-level `set` reaches only the current window), the border row taken back off a window that turns out to be a sidebar — but it never writes a `tab` marker. Hidden group members are enumerated with a separate `list-panes` against the stash session (its own marked list, `TmuxList::Stash` in `constants/tmux_formats.rs`) and emitted as lightweight pane stubs carrying `group_id`.

The frontend filters on `windowType`:

- `selectVisibleWindows` (`packages/tmuxy-ui/src/machines/selectors/layout.ts`) keeps only `windowType === 'tab'` windows for the tab strip.
- the sidebar tree (`machines/actors/serversActor.ts`) hides `float` / `sidebar-left` / `sidebar-right` windows and the `__tmuxy_stash` session; everything else (including untagged foreign windows) shows as a tab.
- floats are rebuilt from `windowType === 'float'` windows and their `@tmuxy-float-*` metadata, and each group from the panes sharing a `group_id` (`machines/app/helpers.ts`).

Window/pane mutations go through the optimistic pipeline: each op predicts a local patch (`packages/tmuxy-ui/src/domain/store/ops.ts`), dispatches the tmux command, and reconciles against the next server snapshot (`packages/tmuxy-ui/src/infra/store/TmuxStore.ts`).
