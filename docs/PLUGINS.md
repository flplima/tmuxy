# Plugins

A plugin adds **actions** to tmuxy's menus and **verbs** to its CLI (`tmuxy plugin <verb>`). It is a
directory with a `tmuxy-plugin.toml` manifest and the commands it names,
usually a GitHub repository.

```sh
tmuxy plugin install someone/tmuxy-chrome-devtools     # shows what it can do, asks, installs
tmuxy plugin list                                     # what is installed, at which commit
tmuxy plugin action chrome-devtools:open              # run an action on this pane
tmuxy plugin update [name]                            # move to the latest commit; asks again
tmuxy plugin remove chrome-devtools [--purge]
```

What a plugin can rely on from tmuxy (CLI verbs, environment variables, the
context JSON, exit codes) is listed in [PLUGIN-API.md](PLUGIN-API.md).

## Security model

**The trust boundary is the install gate.** A plugin's commands run
**unsandboxed, as you, with the tmux socket**: they can read and type into
every pane (see [SECURITY.md](SECURITY.md)). Nothing tmuxy sets in the
environment or in a pane option can confine them, so tmuxy does not pretend
to. Herdr, Neovim and VS Code make the same call; only Zellij sandboxes, at
the cost of a WASM runtime.

What tmuxy does guarantee:

- **Nothing a plugin ships runs before you say yes.** The fetch is a fresh
  repository fetched at the exact commit the gate shows, with every way git
  runs code switched off: no system or global git config (so no
  `insteadOf`, credential helper, hooks path or fsmonitor of yours applies),
  HTTPS only, hooks and LFS filters disabled, no submodules, symlinks checked
  out as plain files. The checkout's `.git` is dropped once its commit is
  verified (`tmuxy_core::plugins::fetch`).
- **The gate asks a person.** It shows the commit, every action, verb and
  required command, and the warning above, and reads the answer from
  `/dev/tty`, never stdin. Without a terminal it fails closed unless given
  `--yes --sha <commit>`: a script names the commit it reviewed, never
  "whatever is there now". `update` shows what changed and asks again.
- **Commands stay inside the plugin.** Every `command` is an argv whose
  program is a path inside the plugin, resolved and checked again at every
  launch (a symlink out of the directory is refused), and run directly,
  never by a shell.
- **Data travels as data.** What reaches a plugin (the selected text, the
  pane's cwd) is in a file or in JSON, never on a shell or tmux command line
  (see [How an action runs](#how-an-action-runs)).

## The manifest

```toml
[plugin]
api = 1                                   # the plugin API (breaking changes bump it)
min_tmuxy = "0.2.0"                       # additions: refused by an older tmuxy
name = "chrome-devtools"                  # lowercase letters, digits, '-'
version = "0.1.0"
description = "Chrome DevTools in a pane"
platforms = ["linux", "macos"]            # leave out for every platform
requires = ["node"]                       # commands checked on PATH at install

[[actions]]
id = "open"
title = "Open DevTools"                   # the menu label
menu = "pane"                             # "app" | "pane" | "selection", or leave out
surface = "popup"                         # "split" | "tab" | "float" | "popup" | "zoomed"
size = { width = "80%", height = 30 }     # float and popup only; numbers are cells
command = ["bin/open", "--port", "9222"]  # an argv inside the plugin, never a shell line

[[cli]]
verb = "devtools"                         # `tmuxy plugin devtools …`, run in the caller's shell
description = "Attach DevTools to a URL"
command = ["bin/cli"]
```

Unknown keys are errors, the file is capped at 64 KiB, and `tmuxy plugin
check <dir>` reports every problem with its line (`tmuxy-plugin.toml:12:1:
unknown field 'surfce'`).

| Key | Meaning |
| --- | --- |
| `menu = "app"` | The app menu's **Plugins** submenu; acts on the active pane. |
| `menu = "pane"` | Every pane menu's **Plugins** submenu (header, right-click, sidebar tree); acts on that pane. |
| `menu = "selection"` | The menu over selected text; the text reaches the command in `TMUXY_SELECTION_FILE`. |
| `surface = "split"` | A pane split beside the target. |
| `surface = "tab"` | A tab of its own, brought to the front. |
| `surface = "float"` | A float over the target's tab, with its header. |
| `surface = "popup"` | A float without a header over a dimmed tab; it closes when its command exits. |
| `surface = "zoomed"` | A split, zoomed to fill the tab. |

Every surface's pane closes when its command exits. A command that exits
with a failure keeps its pane open until Enter, so its error stays readable.

A `[[cli]]` verb runs as `tmuxy plugin <verb> [args…]`, so it may not be one
of `tmuxy plugin`'s own commands (`install`, `list`, … `new`) or another
plugin's. If a later tmuxy adds a `plugin` command a plugin already uses as a
verb, the built-in wins and `tmuxy plugin list` says the verb is shadowed.

### Your own plugin

`~/.config/tmuxy/tmuxy-plugin.toml` with `name = "user"` is your own plugin:
the same schema, no install and no gate, its commands relative to the config
dir. `tmuxy config reload` puts its actions in the menus.

## Where things live

| What | Where |
| --- | --- |
| What is installed, at which commit | `<config_dir>/plugins.json` (owner-only). Sync it with your dotfiles: `tmuxy plugin install` with no argument installs exactly what it lists. |
| Checkouts | `<state_dir>/plugins/<name>@<commit>/`, one per commit. `update` installs the new commit beside the old one; a checkout is deleted only once the lockfile no longer names it and no process runs from it (checked after `update` and `remove`, and when a server starts). A running action never loses its files. |
| A plugin's config and credentials | `<config_dir>/plugins/<name>/` (`TMUXY_PLUGIN_CONFIG_DIR`). Kept on update, and on `remove` unless `--purge`. Credentials belong here, never in the checkout. |
| A plugin's caches and log | `<state_dir>/plugins/<name>.state/` (`TMUXY_PLUGIN_STATE_DIR`). `tmuxy plugin log <name> [-f]` prints the log. |

`tmuxy config paths` prints the real locations on this machine.

## How an action runs

```
 menu item / tmuxy plugin action p:a
        │
        ▼
 tmuxy plugin action (inside tmux run-shell)
   reads the manifest, checks the command, describes the pane,
   writes .run/<token>.json (owner-only: pane, cwd, selection),
   opens the declared surface running:
        tmuxy plugin exec <plugin> <action> <token>      ← names and a token only
        │
        ▼
 tmuxy plugin exec (the new pane's process)
   reads the token once and deletes it,
   writes the selection to TMUXY_SELECTION_FILE (owner-only, removed on exit),
   sets the plugin's environment, runs the argv in the plugin's directory,
   logs the start and the exit status
```

A selected text goes from the client to the tmuxy server
(`prepare_plugin_action`), which writes it into the token: the client's tmux
command names only the token. A Tauri app attached over SSH has no local
plugins of the remote's, so selection actions need tmuxy on the machine the
tmux server runs on.

The menus learn of plugins from the tmux server, not from a file: install,
update, remove, `tmuxy config reload` and every server as it attaches write the
inventory into the global options `@tmuxy-plugins` (base64 JSON) and
`@tmuxy-plugins-rev` ([TMUX-TAGS.md](TMUX-TAGS.md)). The rev rides the state
stream; a new one has the client read the inventory once. So a web client, a
local desktop app and one attached over SSH all show the plugins of the tmux
server they are on.

## Writing one

```sh
tmuxy plugin new hello              # writes tmuxy-hello/: a manifest, bin/hello, a README
tmuxy plugin install --path tmuxy-hello --yes   # a live link: edits apply without reinstalling
tmuxy plugin action hello:hello     # or the pane menu's Plugins submenu
tmuxy plugin log hello
tmuxy plugin check tmuxy-hello
```

A linked plugin shows as `dev` in `tmuxy plugin list`; installing over it is
refused until it is removed.

**Naming.** Call the repository `tmuxy-<name>` (`tmuxy-chrome-devtools`, with
`name = "chrome-devtools"` in the manifest); `tmuxy plugin new` does. The name
is a convention, not how plugins are found: give the repository the GitHub
topic **`tmuxy-plugin`**, which is what a plugin index looks for, together with
a manifest that passes `tmuxy plugin check`. One repository may hold several
plugins in subdirectories: `tmuxy plugin install owner/repo/plugins/one`.

**A compiled plugin** ships a launcher script as its `command`, which picks the
binary for the platform (`uname -s`, `uname -m`); `tmuxy plugin new` writes one
into its README.

**Ref and commit.** `owner/repo@v1.2` follows a tag or branch: `update` moves
to its latest commit. `owner/repo@<40-hex>` pins a commit.

## Not yet

Planned, and not in this release: link handlers (a plugin opening matching
URLs or `file:line` text), key bindings, a settings schema, themes, plugin
dependencies, a plugin index with install by name and `tmuxy plugin search`,
reactive plugins (`tmuxy events`, `[[services]]`) and two-way plugin pages.
