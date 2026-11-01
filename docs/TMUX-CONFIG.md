# tmux Server, Configuration and Key Tables

The dedicated socket, the config chain, session groups and client-side key tables. Part of [TMUX.md](TMUX.md).

## Dedicated Server Socket

Tmuxy never talks to the user's default tmux server. Every component targets a **dedicated socket**, resolved the same way everywhere:

| Priority | Source | Used by |
| --- | --- | --- |
| 1 | `TMUX_SOCKET` env var | all components — see the per-environment table below |
| 2 | Socket derived from `$TMUX` | shell scripts running inside a pane (`packages/tmuxy-cli/bin/tmuxy-cli`, `packages/tmuxy-cli/bin/tmuxy/_lib`) — so they always target the server hosting them |
| 3 | `tmuxy` (the default) | everything else — in practice a released build |

One socket per environment, so a dev server, a test run and an installed build
never collide:

| Environment | Socket | Set by |
| --- | --- | --- |
| Release bundle | `tmuxy` | nothing — the `DEFAULT_TMUX_SOCKET` fallback in `tmuxy-core/src/session.rs` |
| Development | `tmuxy-dev` | `bin/dev-server`, which exports it so the server it spawns agrees |
| E2E tests | `tmuxy-test` | `tests/jest.setup.js` via `tests/helpers/tmux-socket.js` |

The development socket is identical across bare metal, the local devcontainer
and Codespaces: all three reach it through `bin/dev-server`, so none of them hardcodes
a socket of its own.

A `TMUX_SOCKET` value containing a slash is treated as a **full socket path** (`tmux -S <path>`); any other value is a **socket name** in tmux's default socket directory (`tmux -L <name>`). The Rust side resolves via `tmux_socket()` / `tmux_socket_args()` in `tmuxy-core/src/session.rs` and always passes the socket flag explicitly, which also overrides an inherited `$TMUX` — the server behaves identically whether launched from a terminal, a tmux pane, or Finder. Every bundled shell script sources the same resolution from `packages/tmuxy-cli/bin/tmuxy/_lib` (or defines it inline in `packages/tmuxy-cli/bin/tmuxy-cli`); none may call bare `tmux`.

### Live socket switch (desktop app)

The **web server** binds its socket once at process launch (from the env), so it cannot change sockets without a restart. The **desktop (Tauri) app** can switch servers live: `tmuxy connect <socket> [session]` publishes the request as two tmux global env vars (`TMUXY_CONNECT_TO`, `TMUXY_CONNECT_SESSION`) on the current server; a watcher task in the app (`packages/tmuxy-tauri-app/src/monitor.rs`, `poll_connect_requests`) reads them, sets `TMUX_SOCKET`/`TMUXY_SESSION` in-process, and drives the monitor loop to reconnect (a graceful `MonitorCommand::Shutdown` interrupts the live connection). Because every tmux call — the control-mode connection and the one-off executor commands alike — resolves its socket from the env, updating those two vars retargets the whole app. Adopting an existing server applies tmuxy's config and window-type tagging to it, so this is an explicit opt-in, distinct from the isolated default.

### Remote servers over SSH (desktop app)

A "server" in the desktop app is a tmux server tmuxy drives — the local machine or a **remote host reached over SSH**. Saved servers live in `servers.json` in the state dir (`tmuxy-core/src/servers.rs`; machine state, not config: an ssh host is saved as this machine reaches it); the sidebar footer's **server picker** lists them, and `tmuxy session connect` (`packages/tmuxy-cli/bin/tmuxy/session-connect`, which the switcher's "Connect over SSH…" opens in a float) adds new ones. Attaching to a server sets `TMUX_SOCKET` and, for a remote, `TMUXY_SSH` (an ssh argv tail like `-p 2222 user@host`); the Tauri `connect_server` command routes both through the same `request_reconnect` path as a local socket switch.

`TMUXY_SSH` is resolved centrally by `ssh_target()` / `tmux_argv(pty)` in `session.rs`: when set, every tmux invocation is wrapped as `ssh [-tt] <tail> tmux -L <socket> …` (the `-tt` pty flag is used for the `-CC` control-mode connection, omitted for one-off reads so captured output stays clean; the remote binary is bare `tmux`, resolved by the remote login shell). The local `-f <config>` flag is skipped over SSH — that path is local-only. This means the whole app (control mode + executor reads) drives the remote tmux server transparently.

### The sidebar tree, and the sessions poll behind it

The live state the app holds is single-session (the attached session's windows/panes), and the sidebar's **tabs→panes tree** draws exactly that: this session's tabs and their panes, from live state, never the socket's other sessions. Rows for another session had no live state behind them — no content, no geometry, nothing the tree's own keys could act on — and "which session am I on" is asked and answered in the session switcher (`components/SessionMenu.tsx`), which is where the socket's other sessions are listed.

A poll (`serversActor`, `packages/tmuxy-ui/src/machines/actors/serversActor.ts`) shells `list-windows -a` / `list-panes -a` through `run_tmux_command` every ~4s while the tree is open. It feeds the switcher's session list and the tree's git context (below) — the pane cwds live state does not carry. It runs on both the web and desktop builds and is gated on the adapter's `enumeratesSessions` capability, so it stays inert on the single-session in-browser sandboxes (demo, v86). Switching session is `SWITCH_SESSION`; on web `switchSession` reconnects the SSE stream to the chosen session. The **server picker** (saved-server list via `list_servers`) remains desktop-only.

A pane row is **two lines**: `%id process` with the state indicator on the first, the pane's title on the second (`components/paneTabDisplay.ts`, `paneRowLines`). They answer different questions and truncate at different rates — a process name is short and stable, while a title is a path or a command with its arguments and is the one thing in the tree that routinely outgrows a 30-column column. Sharing one line, the title pushed the state indicator around and was the half that got cut. A pane whose title adds nothing (an unset one, or one that only repeats the process) draws a single line, so a column of plain shells stays compact.

The same poll gives the tree its **git context** (read for the attached session alone, the one the tree draws). Each pane row carries its `#{pane_current_path}`, and every ~15s (and on each forced refresh) the client asks the host for the worktrees those directories sit in — the `list_git_worktrees` command, served by `tmuxy-core/src/worktrees.rs` on both the web server and the desktop app. The host reads the pane paths from tmux itself (`list-panes -a -F '#{pane_current_path}'`) rather than from the request, so a web client can never point git at a directory of its choosing; discovery is read-only (`rev-parse --git-common-dir`, `worktree list --porcelain`), scrubs an inherited `GIT_DIR`/`GIT_WORK_TREE`, skips a repository git cannot read instead of failing the whole listing, falls back to newline porcelain on a git older than 2.36, and returns nothing for an SSH-backed server (its pane paths are remote). The result is published as `repositories`; `tmuxy-ui/src/components/gitContext.ts` matches each cwd to the longest worktree root (component-aware, so `/repo-copy` never matches `/repo`) and the tree shows the branch — or a detached checkout's short head — as a badge on the pane row, and on a tab row when every pane in the tab shares the worktree.

## Session groups: two GUI windows over one session

tmux's _current window_ belongs to a session, not to a client, so two clients on one session always
look at the same tab. The desktop app's second OS window therefore gets its own session in a session
**group**: `tmux -CC new-session -A -s <base>~<index> -t <base>`. Group members share every window
and pane — the same windows, linked, not copies — while each keeps its own current window, which is
what lets one OS window sit on one tab and another on a different one. `-A` makes the call idempotent,
so re-opening a window reattaches the session it had rather than failing.

Killing a group member is safe: its windows stay alive in the remaining members, so closing the second
GUI window (which kills `<base>~<index>`) takes nothing with it. A window close that the app does not
see — a crash, a `kill -9` — leaves the grouped session behind; the next window to take that index
reattaches it.

The keys stay distinct from the tab keys: `ctrl+1`…`ctrl+9` select a **tab**, while `cmd+1`…`cmd+9`
(`ctrl+shift+1`…`9` off macOS) select a **GUI window**, and `cmd+n` / `ctrl+shift+n` opens one. See
[DATA-FLOW.md](DATA-FLOW.md) for the per-window monitor and the event addressing that goes with it.

## tmux Configuration

No manual `~/.tmux.conf` changes are required — tmuxy enforces the options it needs automatically, and by default does not read `~/.tmux.conf` at all (see [the config chain](#the-config-chain-and-where-a-users-own-tmuxconf-fits)). On every session connect, the monitor's initial sync (`sync_initial_state` in `tmuxy-core/src/control_mode/monitor.rs`) sets `window-size manual` and `aggressive-resize off` (so multi-client viewport sizing stays under tmuxy's control), plus `allow-passthrough on`, `mouse on`, `focus-events on`, pane-border options, and title options. Settings are applied per-session rather than globally, to avoid a tmux 3.5a crash triggered by global settings under control mode.

OSC 8 hyperlinks are parsed by tmuxy's own control-mode parser (`tmuxy-core/src/control_mode/osc.rs`), so no `terminal-features` setting is required either.

### The config chain, and where a user's own `~/.tmux.conf` fits

tmux starts with `-f tmuxy.entry.conf`, a file the app generates in its data dir, so a user's `~/.tmux.conf` is NOT read by default. That is deliberate — it is also the single loudest first-hour complaint from a tmux user, because their prefix, their status line and their plugins all vanish on tmuxy's socket with nothing saying why.

The app builds the chain itself (`entry_conf` in `tmuxy-core/src/session/config.rs`), so the user's `tmuxy.conf` holds overrides only and needs no `source-file` line. In order:

| # | File | Dir | Owner | Refreshed |
| --- | --- | --- | --- | --- |
| 1 | `tmuxy.essentials.conf` | data | app | every launch |
| 2 | `tmuxy.defaults.conf` (prefix, status line, bindings) | data | app | every launch |
| 3 | `~/.tmux.conf` | — | user | opt-in only |
| 4 | `tmuxy.conf` | config | user | written on the first run only, never again |
| 5 | `tmuxy.essentials.conf` again | data | app | every launch |

`tmuxy config use-tmux-conf on` fills in step 3. The order is the whole design: the user's configs come after tmuxy's taste, so **their** prefix, status line and plugins win; `tmuxy.conf` comes after `~/.tmux.conf`, so the tmuxy-specific file has the last word on taste; and `tmuxy.essentials.conf` is sourced **again** on top, so the settings tmuxy cannot work without are restored whatever any config did to them. The essentials also come first because every binding in the defaults (and in a user's file) resolves through their command-aliases, which must exist before anything binds to them.

The entry file is rebuilt right before every use — the `-f` of a new server, the `source-file` of every connect and reload — from the `use-tmux-conf` choice in the state dir and the user's file, so it never goes stale. It is the one generated file whose content depends on the machine's state, and a second tmuxy process with another config dir that shares the data dir (a test server, say) rewrites it for itself before it sources it.

A `tmuxy.conf` written by an older build sources `~/.config/tmuxy/tmuxy.defaults.conf` itself. The first launch of this build drops that line (see [the config directory](ARCHITECTURE.md#the-users-config-directory)); when the file is a symlink the app may not rewrite, the chain sources a generated copy with the line commented out (`tmuxy.compat.conf` in the data dir) instead, until the user removes it.

### Menu choices, and the options `tmuxy.conf` pins

The menus change five options — `@tmuxy-theme`, `@tmuxy-theme-mode`, `@tmuxy-transparency`, `@tmuxy-cursor-blink`, `@tmuxy-send-ask` — and remember each choice in `tmuxy.state.json` in the state dir, which the monitor puts back after the chain on every connect, every reload and after a client's own `source-file` (a sourced defaults file would reset them).

Config beats menu state. An option the user's `tmuxy.conf` sets is **pinned**: the remembered choice is not put back over it, the menu cannot change it (the backend refuses a change made only of pinned options, and leaves a pinned one out of a mixed one), and the theme settings every client receives list it under `pinned`, so the menu greys it out and labels the item in effect "set in tmuxy.conf". A pinned theme also beats the theme a web client keeps in its own local storage.

The backend learns the pins by reading the user's file, not tmux: tmux cannot say which layer of the chain set an option. It reads the file the way tmux does — comments dropped, continued lines joined, commands split on `;`, `\;` and newlines (the command-list scanner the router uses) — and in order: a `set` or `set-option` of one of the five as a global session option (`-g`, with no `-w`, `-p` or `-s`, which name other tables the app does not read) pins it, whatever its value, and a later `-u` of it lets it go. A command in a `{ … }` block (a binding's) pins nothing, since it does not run when the file is read (`pinned_options_in` in `tmuxy-core/src/session/state.rs`). The file is read each time the settings are, so adding or removing a pin takes effect with the reload that saving the file triggers.

### What a user's config can break, and what protects it

Three layers protect the app, and they cover different things:

| Layer | Where | Covers |
| --- | --- | --- |
| `enforce_settings()` | `control_mode/monitor.rs`, every connect, per-session | `pane-border-status`/`-format`, `mouse`, `focus-events`, `allow-passthrough`, `allow-rename`, `set-titles`, `window-size manual`, `aggressive-resize off` |
| `tmuxy.essentials.conf` | sourced first and again last in the chain | the `tmuxy-*` command-aliases, `destroy-unattached off`, `exit-empty off`, `default-terminal`, `terminal-overrides`, `escape-time 0`, `history-limit` |
| nothing | — | everything else, which is taste |

The ones that actually bite, and why each is in the essentials file rather than left to chance:

- **`destroy-unattached on`** — a reasonable thing to have in a personal config, and fatal here. tmuxy's client is a control-mode connection that comes and goes with every page reload, so the session would be destroyed the moment a browser tab closed.
- **`default-terminal screen-256color`** — the renderer decodes 24-bit colour from the control-mode stream; a 256-colour TERM makes every truecolour application render in the wrong palette.
- **`history-limit 500`** — scrollback is a client-side reimplementation over tmux's history. A small limit reads to the user as "tmuxy lost my scrollback".
- **`command-alias[100…122]`** — every tmuxy binding and the whole CLI resolve through these. A config that sets the same indices silently replaces them, and nav, pane groups and stacks stop working with no error anywhere.
- **`escape-time`** — a non-zero value makes Escape feel broken in vim.

What is deliberately NOT protected, because protecting it would defeat the point: the prefix, the status line, `mode-keys`, `base-index`, key bindings, colours, and anything a plugin does. A user who opts in gets their own.

Because the essentials come last, the user's `tmuxy.conf` cannot change them either — a larger `history-limit` set there is put back to the essentials' value. That is the price of no config being able to take the app apart; a setting that belongs to taste does not belong in the essentials.

Two hazards that remain the user's to judge, and are called out in `tmuxy config use-tmux-conf --help` rather than silently handled:

- **tpm and plugins** load on tmuxy's socket too. `tmux-continuum` in particular will happily auto-save and auto-restore sessions there.
- **A status line that draws itself** may fight tmuxy's own chrome, which is cosmetic but ugly.

## Key Tables Are the Client's

tmuxy answers keys itself — the browser or webview holds the keyboard, and
control mode has no key handling to give it — so the prefix and every table
beyond it run in the client's keyboard actor
(`tmuxy-ui/src/machines/actors/keyboardActor.ts`), from the bindings the server
reads with one `list-keys` and sends whole (`KeyBindings` in
`tmuxy-core/src/transport.rs`: prefix, root, and every other table by name;
copy mode's tables stay out, copy mode being the client's too).

A binding enters a table the tmux way, with `switch-client -T <table>`
(`bind p switch-client -T pane` in `tmuxy.defaults.conf`). The client reads the
switch out of the binding and keeps the table as its own state; only the rest
of the binding goes to tmux (`tmuxy-ui/src/domain/keyTables.ts`). A table is
**sticky** for as long as each key's binding enters it again
(`bind -T pane x kill-pane \; switch-client -T pane`) — again exactly how tmux
does it — and `Esc`, a key the table does not bind, or a binding that names no
table leaves it. So the same config drives a raw `tmux attach` the same way.

The defaults:

```
  prefix (ctrl+a)          the short menu
    -  |   split           c   new tab        s / S   the left / right sidebar
    p      PANE mode       t   TAB mode       ?       every key, table by table

  PANE (sticky)                             TAB (sticky)
    h j k l   focus          H J K L  resize    h l   prev / next     c   new
    - |       split          x        close     ,     rename          x   close
    z         zoom           s / S    stack     1-9   go              < > move (client)
    = group   < > swap       f float  b break   o     overview (client)
    m mark    , rename       g join
```

A few keys have no tmux command behind them and are answered by the client in
whichever table they belong to: `prefix s` / `S` (open a sidebar over the
panes; the same key again while it is open docks it, and again frees it — the
prefix stays armed for that one key, tmux's repeat, and any other key goes on
as if no prefix came first), `prefix w` and TAB's `o` (the Tab Overview),
`prefix ?` (the keys view), and TAB's `<` / `>` (move the tab along the strip,
which skips the windows floats and sidebars occupy where a relative
`swap-window` would not). The status line names the mode in force and shows a
handful of its keys, each line fitting 80 columns
(`tmuxy-ui/src/components/statusLineHints.ts`).
