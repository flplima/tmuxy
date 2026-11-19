A plugin adds menu items, keys, links, themes and `tmuxy plugin` commands to tmuxy. This page shows how to find, install and run one, and how to write your own.

## What a plugin can add

A plugin is a folder with a `tmuxy-plugin.toml` and the commands it names. Most live in a GitHub repository.

| It can add        | Where you see it                                                     |
| ----------------- | -------------------------------------------------------------------- |
| **Actions**       | The app menu, the pane menu or the selection menu, under **Plugins** |
| **Commands**      | `tmuxy plugin <verb>` in your shell                                  |
| **Link handlers** | Cmd/Ctrl+click on a link or on text in a pane                        |
| **Keys**          | A key in the prefix or root table                                    |
| **Settings**      | `tmuxy plugin config`                                                |
| **Themes**        | The theme menu                                                       |

## Know what you install

A plugin's commands run **unsandboxed, as you, with the tmux socket**. They can read and type into every pane. tmuxy does not try to confine them, so the install gate is the one check you get.

Before anything a plugin ships runs, the gate shows:

- the exact commit it will install
- every action, command, link handler, key, setting and theme
- every dependency and every command it requires on your `PATH`
- the warning above

It reads your answer from the terminal, never from stdin. The install is pinned to the commit you saw. `update` shows what changed and asks again.

Read the plugin's code before you say yes. The index only helps you find a repository. It is not a seal of approval.

## Find and install a plugin

```sh
# Search the index (public repos with the tmuxy-plugin topic)
tmuxy plugin search chrome

# Install by index name, or from GitHub
tmuxy plugin install hello
tmuxy plugin install owner/repo
tmuxy plugin install owner/repo@v1.2        # follows a tag or branch
tmuxy plugin install owner/repo@<40-hex>    # pins one commit
tmuxy plugin install owner/repo/plugins/one # a plugin in a subfolder
```

With no argument, `tmuxy plugin install` installs exactly what your `plugins.json` lists. That makes it easy to sync plugins through your dotfiles.

### Install without a terminal

A script has no one to ask, so it must name the commits it reviewed:

```sh
# --sha once per commit the gate shows (the plugin's and each dependency's)
tmuxy plugin install owner/repo --yes --sha 0123456789abcdef0123456789abcdef01234567
```

You can also pass several commits to one `--sha`, comma-separated. `--yes` without a `--sha` for every commit fails closed.

## Manage what is installed

```sh
tmuxy plugin list                  # installed plugins and their commits
tmuxy plugin update                # all of them; asks again
tmuxy plugin update hello          # one
tmuxy plugin remove hello          # keeps its settings
tmuxy plugin remove hello --purge  # deletes its settings too
tmuxy plugin remove hello --force  # also removes plugins that depend on it
```

A plugin you linked with `--path` shows as `dev` in the list. `tmuxy plugin list` also tells you when a key was skipped because your own binding holds it.

## Run an action

Open the pane menu and pick **Plugins**. Or run it from a shell:

```sh
tmuxy plugin action hello:hello              # on this pane
tmuxy plugin action hello:hello --pane %3    # on another pane
tmuxy plugin action hello:hello --wait       # block, exit with its status
tmuxy plugin action hello:hello -- extra args
```

Each action opens in the surface it declares: a split, a tab, a float, a popup or a zoomed split. The pane closes when the command exits. If the command fails, the pane stays open until you press Enter, so you can read the error.

## Settings and secrets

```sh
tmuxy plugin config hello                      # list the settings
tmuxy plugin config hello download_dir         # read one
tmuxy plugin config hello download_dir ~/Dl    # set one (checked against its type)
tmuxy plugin config hello download_dir --unset # back to the default
```

A **secret** setting has no value on the command line. Run `tmuxy plugin config hello token` and type it with echo off. It shows only as "set" or "empty" and never lands in a log. Values live in the plugin's config folder in an owner-only `settings.toml`. There is no settings screen yet.

## Logs

```sh
tmuxy plugin log hello       # what it ran, and how it exited
tmuxy plugin log hello -f    # keep following
```

`tmuxy config paths` prints where plugins, settings and logs live on your machine.

## Write your own

```sh
tmuxy plugin new hello                       # writes tmuxy-hello/
tmuxy plugin install --path tmuxy-hello --yes   # a live link: edits apply at once
tmuxy plugin action hello:hello              # or the pane menu's Plugins submenu
tmuxy plugin log hello
tmuxy plugin check tmuxy-hello               # reports every problem with its line
```

`new` writes a manifest, `bin/hello` and a README. A complete minimal `tmuxy-plugin.toml`:

```toml
[plugin]
api = 1                          # the plugin API version
min_tmuxy = "0.1.6"              # older tmuxy refuses it
name = "hello"                   # lowercase letters, digits, '-'
version = "0.1.0"
description = "Says hello from a popup"
platforms = ["linux", "macos"]   # leave out for every platform

[[actions]]
id = "hello"
title = "Say hello"              # the menu label
menu = "pane"                    # "app" | "pane" | "selection", or leave out
surface = "popup"
size = { width = "60%", height = "50%" }
command = ["bin/hello"]          # an argv inside the plugin, never a shell line
```

Unknown keys are errors. The file is capped at 64 KiB.

### Surfaces

| `surface` | What opens                                                |
| --------- | --------------------------------------------------------- |
| `split`   | A split beside the target pane                            |
| `tab`     | A tab of its own, brought to the front                    |
| `float`   | A float over the tab, with its header (`size` applies)    |
| `popup`   | A float with no header over a dimmed tab (`size` applies) |
| `zoomed`  | A split, zoomed to fill the tab                           |

`size` takes cells (`30`) or percentages (`"80%"`). `menu = "selection"` puts the action in the menu over selected text.

### Commands for your shell

```toml
[[cli]]
verb = "devtools"                # runs as: tmuxy plugin devtools
description = "Attach DevTools to a URL"
command = ["bin/cli"]
```

A verb cannot reuse one of the built-in `tmuxy plugin` commands.

### Link handlers, keys, settings and themes

```toml
[[link_handlers]]
id = "artifact"
match = "url"                    # or "text" with a pattern
hosts = ["example.com"]
path_regex = "/public/[A-Za-z0-9-]+"
action = "hello"

[[keys]]
key = "M-a"
table = "prefix"                 # "prefix" (default) or "root"
action = "hello"

[[settings]]
key = "token"
type = "string"                  # string | bool | int | enum (+ values)
secret = true

[[themes]]
id = "night"
file = "themes/night.css"
```

Hold Shift while you click to skip a handler and go straight to the browser. Your own key bindings always win over a plugin's. A plugin theme's CSS runs in the app's page, so the gate lists it.

### What a command gets

| Variable                    | Value                                                         |
| --------------------------- | ------------------------------------------------------------- |
| `TMUXY_PLUGIN_NAME`         | The plugin's name                                             |
| `TMUXY_PLUGIN_DIR`          | Its folder, also the working directory. Treat it as read-only |
| `TMUXY_PLUGIN_CONFIG_DIR`   | Settings and credentials, kept across updates                 |
| `TMUXY_PLUGIN_STATE_DIR`    | Caches, and the plugin's log                                  |
| `TMUXY_TARGET_PANE`         | The pane the action is about (`%N`)                           |
| `TMUXY_PLUGIN_CONTEXT_JSON` | The pane, tab, session, trigger, link and settings, as JSON   |
| `TMUXY_SELECTION_FILE`      | Selection actions only: the selected text, in a file          |

Ignore JSON fields you do not know. Your command can call any `tmuxy` command, for example `tmuxy pane list --json`.

### Your own actions, no install

Put a `tmuxy-plugin.toml` with `name = "user"` in `~/.config/tmuxy/`. It uses the same schema. There is no gate and no install, and its commands are relative to that folder. Saving the file applies it. `tmuxy keymap` lists its actions, commands and keys.

### Pages that talk back

_On main, not in a release yet._

A plugin's UI can be an HTML page shown with `tmuxy open page.html`. The page calls `tmuxy.emit(value)`, and `tmuxy pane listen` prints each value as one JSON line. Treat those lines as untrusted data. Parse them, never run them. The [plugin docs](https://github.com/flplima/tmuxy/blob/main/docs/PLUGINS.md#two-way-pages) have the full pattern.

### Publish it

Name the repository `tmuxy-<name>` and add the GitHub topic `tmuxy-plugin`. The index scans every six hours and lists the ones whose manifest passes `tmuxy plugin check`.

## Stability

The plugin API only grows. Removing or changing anything in it needs `api = 2`. New variables, commands and JSON fields can land in any release, and a plugin that needs one says so with `min_tmuxy`. Everything not in the [plugin API doc](https://github.com/flplima/tmuxy/blob/main/docs/PLUGIN-API.md) can change.

Still planned: reactive plugins and a settings screen.

## See also

- [[Security]]
- [[Send Permissions]]
- [[Scripting with the CLI]]
- [[Themes and Appearance]]
