tmuxy is a view on top of tmux, so your tmux knowledge carries over. This page covers what moves: sockets, keys, words and your config.

## Where are my sessions?

They are still there. tmuxy just is not looking at them yet.

tmuxy runs tmux on a socket of its own, called `tmuxy`. Your bare `tmux` command uses a different one. That is on purpose. A tmuxy update or crash cannot take your real work with it.

To look at your own tmux server instead:

- **Desktop app:** open the session menu. Under _Servers_ it lists **my tmux** whenever that server has sessions. Pick it and the app reconnects in place.
- **Web:** the server binds its socket at launch, so say so at launch.

```bash
# Point the web server at your own tmux server
TMUX_SOCKET=default tmuxy server
```

The first time tmuxy starts while your own server has sessions, it tells you once. _The notice is on main, not in a release yet._

### What tmuxy changes on your server

Attaching to your own server applies only what tmuxy cannot work without. Your prefix, status line and bindings stay as they are.

- It sets eight options: `escape-time`, `history-limit`, `default-terminal`, `terminal-overrides`, `destroy-unattached`, `exit-empty`, `focus-events` and `set-clipboard`.
- It turns `mouse` and `set-titles` on for the session it shows.
- It adds its command aliases.

## Use your own `~/.tmux.conf`

tmuxy does not read `~/.tmux.conf` by default. Your prefix and status line would vanish with no hint why, so this is the first thing to turn on.

```bash
# Source ~/.tmux.conf on tmuxy's socket (takes effect the next time tmuxy connects)
tmuxy config use-tmux-conf on

# Print the current setting
tmuxy config use-tmux-conf

# Re-apply the config to the running app
tmuxy config reload
```

The order is: tmuxy's defaults, then your `~/.tmux.conf`, then your `tmuxy.conf`, then tmuxy's essentials again. Your prefix, status line and plugins win over tmuxy's defaults. Put tmuxy-only taste in `tmuxy.conf` (`tmuxy config init` writes a starter).

Things to know once it is on:

- **tpm and plugins load** on tmuxy's socket too. A session manager like `tmux-continuum` will save and restore sessions there.
- **A status line that draws itself** may fight tmuxy's own chrome.
- **The essentials win.** tmuxy puts back `destroy-unattached off`, `exit-empty off`, `default-terminal`, `terminal-overrides`, `escape-time 0` and `history-limit` after any config. A bigger `history-limit` in your file is reset.

Check a file without applying it:

```bash
tmuxy config check     # a line tmux cannot parse, an option it lacks, a missing source-file (on main, not in a release yet)
tmuxy config doctor    # source-file lines whose file is missing (--fix comments them out)
```

## Keys: tmux to tmuxy

The prefix is `Ctrl+a`, as in screen. Press `Ctrl+a` twice, or `Ctrl+a` then `a`, to send a literal `Ctrl+a` to a program.

| In tmux                    | In tmuxy                               |
| -------------------------- | -------------------------------------- |
| `Ctrl+b` prefix            | `Ctrl+a`                               |
| `prefix %` split right     | `prefix %`, `prefix \|` or `prefix \`  |
| `prefix "` split below     | `prefix "` or `prefix -`               |
| `prefix c` new window      | `prefix c` (a tab)                     |
| `prefix ,` rename window   | `prefix t` then `,`                    |
| `prefix &` kill window     | `prefix t` then `x`                    |
| `prefix x` kill pane       | `prefix p` then `x`                    |
| `prefix z` zoom            | `prefix z`                             |
| `prefix !` break pane      | `prefix p` then `b`                    |
| `prefix {` and `}` swap    | `prefix <` and `prefix >`              |
| `prefix w` choose window   | `prefix w` (every tab at once)         |
| `prefix arrow` change pane | `Ctrl+h` `j` `k` `l`, or `Ctrl+arrow`  |
| `prefix [` copy mode       | `prefix [`, or scroll with the wheel   |
| `prefix d` detach          | Session menu, Detach Session (desktop) |

Other things to know:

- `prefix p` is PANE mode here, not previous window. Use `Ctrl+Tab`, `Ctrl+Shift+Tab`, or `prefix t` then `h` or `l`.
- `Ctrl+h`, `Ctrl+j`, `Ctrl+k` and `Ctrl+l` are bound at the root. A program in the pane does not get them. Give them back with `unbind -n C-h` (and `j`, `k`, `l`) in `tmuxy.conf`.
- Windows and panes start at 1. Copy mode and the status line use vi keys. Windows renumber when one closes.
- `prefix s`, `S`, `g`, `P` and `?` belong to the tmuxy client (tree, dock, go to, palette, key list).

## Words: tmux to tmuxy

| tmux            | tmuxy                                                |
| --------------- | ---------------------------------------------------- |
| window          | tab                                                  |
| session         | session                                              |
| pane            | pane                                                 |
| `display-popup` | float                                                |
| `choose-tree`   | the tree sidebar (`prefix s`)                        |
| status line     | status line (tmuxy draws it)                         |
| key table       | mode (PANE, TAB)                                     |
| client          | the app or the browser tab                           |
| no equivalent   | pane group: panes stacked in one slot, shown as tabs |

## What tmuxy leaves out

tmuxy is a tmux UI, not a terminal emulator. These are choices, not gaps.

- **No Ctrl+F find-in-page.** Search in copy mode with `/` and `?`.
- **No local echo.** Every keystroke goes through tmux, so there is no mosh-style prediction.
- **One session in view at a time.** You can switch quickly, but there is no split view across sessions.
- **No resuming processes after a restart.** A snapshot rebuilds the shape: tabs, splits, floats, directories and the program each pane ran. Programs come back typed at the prompt, not running.
- **SSH servers only in the desktop app.** The web server drives the tmux on its own host.
- **No Windows build.**

The full list is in [docs/NON-GOALS.md](https://github.com/flplima/tmuxy/blob/main/docs/NON-GOALS.md).

## Raw tmux commands

While tmuxy is attached, a separate `tmux` process that changes things can crash tmux 3.5a. Everything tmuxy does goes through one control-mode connection. Do the same:

```bash
# Safe: runs through tmuxy's connection
tmuxy run list-panes -F '#{pane_id} #{pane_current_command}'
tmuxy run swap-pane -s %0 -t %1

# These have their own commands
tmuxy pane split -h     # not split-window
tmuxy tab create        # not new-window
tmuxy pane send -t %3 make Enter
```

`tmuxy run` refuses what it cannot make safe: keys into a pane, `split-window`, `new-session`, `set-option`, `source-file` and others. Its `--help` lists them all. The same rule applies to your scripts and your AI agents.

## See also

- [[Quick Start]]
- [[Configuration]]
- [[Keybindings]]
- [[Scripting with the CLI]]
