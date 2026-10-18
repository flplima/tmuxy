# Window and Pane Tags (`@tmuxy-*`)

The `@tmuxy-*` tag schema and the pane-group model built on it. Part of [TMUX.md](TMUX.md).

## Window Tags (`@tmuxy-*`)

tmuxy marks the windows and panes it manages with tmux user-options under the `@tmuxy-*` namespace. This is the canonical reference for that schema and how the backend, frontend, and shell scripts consume it.

### Filtering rule

**Tabs carry no marker.** Any window in the attached session that is _not_ tagged `float`, `sidebar-left` or `sidebar-right` is a tab — including foreign windows a user creates with a raw `tmux neww`, which simply appear as tabs. Only the non-tab chrome windows are tagged, and only those are filtered out of the tab strip. Window names are purely cosmetic and never used to infer type.

So the attached session's window list maps 1:1 to the tab strip (minus any open floats), and a native `tmux attach` and tmuxy agree on what the tabs are. Hidden pane-group members live in a separate stash session, so they are not windows in the attached session at all.

### Schema

Window options are scoped per window (`set-option -w -t <window-id>`). The pane options (`@tmuxy-group-id`, `@tmuxy-group-pos`, `@tmuxy-pane-state`, `@tmuxy-ask`, `@tmuxy-ask-answer`, `@tmuxy-pane-widget`) are scoped per pane (`set-option -p -t <pane-id>`).

| Option | Scope | Values | Set on |
| --- | --- | --- | --- |
| `@tmuxy-window-type` | window | `float` \| `sidebar-left` \| `sidebar-right` | non-tab chrome windows only (tabs are untagged) |
| `@tmuxy-float-parent` | window | `@<window-id>` | floats |
| `@tmuxy-float-width` | window | integer (columns) | floats |
| `@tmuxy-float-height` | window | integer (rows) | floats |
| `@tmuxy-float-drawer` | window | `top` \| `bottom` \| `left` \| `right` \| unset | drawer-style floats |
| `@tmuxy-float-bg` | window | `blur` \| `dim` \| unset | floats with a backdrop |
| `@tmuxy-float-noheader` | window | `1` \| unset | floats that hide the header chrome |
| `@tmuxy-group-id` | pane | `g<n>`, e.g. `g5` | every member of a pane group |
| `@tmuxy-group-pos` | pane | integer (0 is first) \| unset | a member's place in its group, once the group was reordered or joined; members without one follow, by pane id |
| `@tmuxy-group-rev` | global | opaque \| unset | bumped by the group scripts after a change tmux does not announce, so the pane-metadata subscription fires (every pane inherits it) |
| `@tmuxy-pane-state` | pane | `idle` \| `working` \| `needs-input` \| `error` \| `unread` \| unset | what the pane says it is doing; set by whatever runs in it |
| `@tmuxy-ask` | pane | base64 of `{token, caller, keys}` or `{token, kind: "offer", command}` \| unset | a send into this pane waiting on the user (`tmuxy pane send -t`), or a command a session restore offers to run again (the client shows it as a one-line banner and runs or drops it itself) |
| `@tmuxy-ask-answer` | pane | `<token>:yes` \| `<token>:no` \| unset | the answer a client recorded for the pending `@tmuxy-ask` |
| `@tmuxy-pane-widget` | pane | a widget name, e.g. `browser` \| unset | which widget this pane may render; written by `tmuxy-widget` and cleared when it exits |
| `@tmuxy-pane-restore` | pane | a shell line \| unset | how to bring this pane back after a session restore (`tmuxy pane restore-cmd`); set by the program itself, wins over what `ps` finds. See `tmuxy_core::session_snapshot` |
| `@tmuxy-pane-url` | pane | a URL \| unset | the address a live browser pane (`tmuxy browser`) is showing, for the app's address bar over it; written by the pane program on every navigation, cleared when it exits. The pane title is the page's title |
| `@tmuxy-focus-request` | session | `left` \| `right` \| `panes` \| unset | a shell helper asking a client to move keyboard focus |
| `@tmuxy-sidebar-cols` | window | integer (columns) \| unset | a sidebar column the user has dragged off its default width — for the dock these are its own cells: the right column runs in the sidebar font (80% of the pane font), so its cell width is the pane grid's advance scaled to that size (`selectSidebarCellMetrics`) |
| `@tmuxy-sidebar-hidden` | window | `1` \| unset | a sidebar column the user has closed; its pane stays alive, no client draws it |
| `@tmuxy-collapsible` | window | `1` \| unset | collapsible panes: only the first-level row holding the active pane is expanded (see below) |
| `@tmuxy-sidebar-rows` | window | integer (rows) \| unset | rows the dock's pane is sized to; the client sets it from its own (shorter, sidebar-font) row height, so the column holds more rows than the viewport |

`@tmuxy-float-parent` is the **window id** of the window the float was launched from; focus returns there when the float closes. A float's backdrop is a style of the float (`@tmuxy-float-bg`), not a window of its own.

`@tmuxy-pane-state` is the one tag tmuxy never writes itself: whatever runs in a pane declares its own state through `tmuxy pane state <value>`, which the sidebar tree draws at the row's right edge. An agent sets it from its hooks, a shell from a `precmd`/`preexec` pair, a build script on failure. Nothing infers it — tmux's activity flag means "bytes arrived", which a spinner produces continuously, so activity cannot tell working from waiting.

**Coding agents.** `tmuxy agent install [claude|codex|agy]` puts tmuxy into an agent's own lifecycle hooks — Claude Code's `settings.json`, Codex's `hooks.json`, Antigravity's `hooks.json`; the home directory's by default, the project's with `--project` — and installs the tmuxy skill beside them. Every installed hook is the same bare command, `tmuxy agent hook <agent> <event>`, called through `tmuxy` on PATH and guarded so that settings synced to a machine without tmuxy do nothing there: what an event means (`working` on a prompt or a finished tool call, `needs-input` on a permission request, `idle` on stop, `error` on a failed turn, unset when the session ends) is decided by the server binary when the hook fires (`tmuxy-server/src/agents.rs`), so an upgrade changes behaviour without a reinstall and uninstall finds tmuxy's entries by that command alone. The hook script (`bin/tmuxy/agent-hook`) never makes the agent wait on tmux: it records the wanted state and applies the latest one from a background job, and outside a tmuxy pane it does nothing. Known gaps: Antigravity has no hook for a permission prompt, so it never reads `needs-input`; and a Claude Code permission prompt dismissed with Esc fires no hook, so the pane stays `needs-input` until the next prompt.

**Unread is the client's.** An agent only ever says `idle` when it stops. A pane that goes from `working` or `needs-input` to `idle` while another pane is active is drawn `unread` until the user activates it (`nextUnreadPaneIds` in `packages/tmuxy-ui/src/utils/paneState.ts`) — only the client knows which pane is in front of the user. The value rides the ordinary `list-panes` subscription (it is a fixed tail field, like `@tmuxy-group-id`) and is carried verbatim: the client owns the vocabulary and collapses anything it does not recognize to `idle`, so a writer is free to use its own status names without waiting for a release. As with every user option, tmux emits no notification when it changes — the value lands on the next metadata sync, which any pane producing output triggers continuously.

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

Pane groups are **not** a window type. A group is a set of panes sharing a `@tmuxy-group-id` pane option, minted from the anchor pane id (`%5` → `g5`) and unique for the group's life because tmux never reuses pane ids. The **visible** member is an ordinary pane in the attached session; the **hidden** members are parked one-per-window in a dedicated session, `__tmuxy_stash`, which is never attached and is filtered out of every session enumeration (the sidebar tree, `session switch`, the server picker).

Because a pane's options travel with it across a **cross-session `swap-pane`**, switching group tabs moves the target member into the visible slot and the previous one into the stash with no membership bookkeeping — verified behavior on tmux 3.7.

The group rules live once, in `tmuxy_core::groups`: pure functions that take the members read from one `list-panes -a` and return the tmux command list for each operation (add, park, close, switch, next, prev, move, join, leave). That one read is a `list-panes -a -F` whose fields are separated by a **space**, the session name last, because tmux 3.4 prints a control character in a format as `_` — a tab-separated row came back as one field there, and every verb refused with "no pane". The `tmuxy-group` crate runs them from inside `run-shell`, the same safe path the session CLI uses — as `tmuxy-server group <verb>`, and as a `tmuxy-group` binary of its own for the v86 guest, which has no server — and the `bin/tmuxy/pane-group-*` scripts are thin wrappers around it, so their names and arguments (which the UI, the key bindings and snapshot restore call) stay put. A script uses `tmuxy-group` when it is on `PATH`, and otherwise finds the server binary through `TMUXY_SERVER_BIN` / `TMUXY_SERVER_SUBCOMMAND`, which every tmuxy process publishes to its tmux server's global environment on attach (a read-only viewer does not), then `tmuxy-server` on `PATH`, the repo's `target/`, and the desktop launcher. The stash session is created lazily (`new-session -d -s __tmuxy_stash`, control-mode safe). Closing a member sweeps orphaned stash members, and so does each add, so hidden members orphaned by a wholesale tab-kill are reaped on the next group operation. Even before that sweep they are invisible: the backend prunes any stash member whose group has no visible pane from the emitted state, so an orphan never renders as a phantom tab.

A group's **order** is `@tmuxy-group-pos` on each member, ascending, with members that carry none after them in pane-id order — so a group nobody rearranged reads in creation order, and the backend (`groups::order_key`, also used by snapshots) and the client (`groupMembers` in `tmuxy-ui/src/domain/client.ts`) apply the same rule. `nav` steps between members with `group next|prev --no-wrap` (exit 3 means no member that way, and the step falls through to the neighbouring pane or sidebar). Move, join and leave rewrite every member's place 0..n-1. `join` breaks the pane out of its window into the stash like a new member; `leave` first hands an on-screen member's slot to the next member in order, then moves the pane out as a tab of its own (`move-window` of its stash window) or splits it in beside a target (`join-pane`), and a group left with one member stops being one. None of these produce a notification tmux sends for options, so each ends by bumping the global `@tmuxy-group-rev`, which the monitor's pane-metadata subscription sees within a second. The order is saved with the session snapshot (a visible member's place as a pane option, a parked member's as its `position`) and restored by `pane-group-park`.

### How the tags are consumed

The backend (`tmuxy-core`) reads the options off `list-windows` and emits each window's `windowType` on the wire, defaulting an untagged window to `tab` (see `WindowState::to_tmux_window`). The setup pass (`collect_window_tag_commands` in `control_mode/state.rs`) re-tags a float/sidebar window whose option went missing, takes the `pane-border-status` row back off a window that turns out to be a sidebar, and enforces `pane-border-status top` per tab window (a session-level `set` is not inherited by windows), but it never writes a `tab` marker. Hidden group members are enumerated with a separate `list-panes` against the stash session (rows carry a `stashmember,` sentinel) and emitted as lightweight pane stubs carrying `group_id`.

The frontend filters on `windowType`:

- `selectVisibleWindows` (`packages/tmuxy-ui/src/machines/selectors/layout.ts`) keeps only `windowType === 'tab'` windows for the tab strip.
- the sidebar tree (`machines/actors/serversActor.ts`) hides `float` / `sidebar-left` / `sidebar-right` windows and the `__tmuxy_stash` session; everything else (including untagged foreign windows) shows as a tab.
- floats are rebuilt from `windowType === 'float'` windows and their `@tmuxy-float-*` metadata, and each group from the panes sharing a `group_id` (`machines/app/helpers.ts`).

Window/pane mutations go through the optimistic pipeline in `packages/tmuxy-ui/src/domain/store/` — each op predicts a local patch, dispatches the tmux command, and reconciles against the next server snapshot (`ops.ts`, `TmuxStore.ts`).
