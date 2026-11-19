The default keys, by table. The prefix is `Ctrl+a`. These are tmux bindings from tmuxy's defaults file, plus a few keys the app answers itself.

To see where any key comes from in your setup:

```bash
# Every binding, with the file and line it comes from.
tmuxy keymap

# One key table.
tmuxy keymap --table prefix

# One key in one table: says where `prefix t` comes from.
tmuxy keymap --table prefix t

# For a script.
tmuxy keymap --json
```

`prefix ?` shows every key in the app, table by table. `tmuxy keymap` also lists the defaults your `tmuxy.conf` replaced, and the actions and verbs of your plugins. _`tmuxy keymap` is on main, not in a release yet._

## No prefix (root keys)

| Key                                 | Action                               |
| ----------------------------------- | ------------------------------------ |
| `Ctrl+h` `Ctrl+j` `Ctrl+k` `Ctrl+l` | Focus the pane left, down, up, right |
| `Ctrl+←` `Ctrl+↓` `Ctrl+↑` `Ctrl+→` | The same, with arrows                |
| `Ctrl+Tab` / `Ctrl+Shift+Tab`       | Next / previous tab                  |

Navigation goes through group members first, then splits, then sidebar columns. These four letter chords never reach your program. To get one back, see the second example below.

## Prefix keys

Press `Ctrl+a`, release, then the key.

| Key              | Action                                   |
| ---------------- | ---------------------------------------- |
| `Ctrl+a`         | Send a literal `Ctrl+a` to the program   |
| `a`              | The same                                 |
| `-` or `"`       | Split below                              |
| `\|`, `\` or `%` | Split right                              |
| `c`              | New tab                                  |
| `H` `J` `K` `L`  | Resize the pane by 5 (repeats)           |
| `<` / `>`        | Swap with the previous / next pane       |
| `=`              | Add a pane to the current pane's group   |
| `j`              | Join a pane from another tab (a chooser) |
| `p`              | PANE mode                                |
| `t`              | TAB mode                                 |
| `z`              | Zoom or unzoom                           |
| `[`              | Copy mode                                |
| `!`              | Break the pane out to its own tab        |

`z`, `[` and `!` are tmux's own defaults and still work. Other tmux defaults you have not rebound are kept too.

## Keys the app answers itself

These have no tmux command behind them.

| Key                | Action                                                    |
| ------------------ | --------------------------------------------------------- |
| `prefix s`         | Open the tree sidebar. Again docks it, and again frees it |
| `prefix S`         | The same for the right sidebar, a shell                   |
| `prefix w`         | The tab overview                                          |
| `prefix ?`         | Every key, table by table                                 |
| `prefix A`         | The activity inbox                                        |
| `prefix U`         | Go to the pane that needs you                             |
| `prefix P`         | Command palette                                           |
| `prefix g`         | Go to a session, tab or pane                              |
| TAB mode `<` / `>` | Move the tab left / right                                 |
| TAB mode `o`       | The tab overview                                          |

`prefix A`, `U` and `P` are on main, not in a release yet.

tmux 3.8 binds `g` for something else. The defaults unbind `g`, `s`, `S` and `T` so the app can use them. A binding you set on one of these in your own config wins.

## PANE mode (`prefix p`)

The status line names the mode. One plain key runs an action and returns to normal mode. `Esc` leaves without doing anything.

| Key             | Action                                    |
| --------------- | ----------------------------------------- |
| `h` `j` `k` `l` | Focus left, down, up, right               |
| `H` `J` `K` `L` | Resize by 5                               |
| `-` / `\|`      | Split below / right                       |
| `x`             | Close the pane                            |
| `z`             | Zoom                                      |
| `s`             | Add a stacked row and turn stacking on    |
| `S`             | Switch stacking on or off                 |
| `=`             | Add to the group                          |
| `>` / `<`       | Swap with the next / previous pane        |
| `f`             | New float                                 |
| `b`             | Break out to a tab                        |
| `m`             | Mark the pane                             |
| `,`             | Rename the pane                           |
| `g`             | Gather: join a pane from another tab here |

## TAB mode (`prefix t`)

| Key        | Action                    |
| ---------- | ------------------------- |
| `h` / `l`  | Previous / next tab       |
| `c`        | New tab                   |
| `x`        | Close the tab             |
| `,`        | Rename                    |
| `1` to `9` | Go to tab 1 to 9          |
| `<` / `>`  | Move the tab left / right |
| `o`        | The tab overview          |

## Copy mode (vi keys)

Enter with `prefix [`. See [[Copy Mode and Scrollback]] for how to use it.

| Key                                 | Action                        |
| ----------------------------------- | ----------------------------- |
| `h` `j` `k` `l`, arrows             | Move                          |
| `0` / `$`                           | Start / end of line           |
| `w` `b` `e`                         | Words                         |
| `H` `M` `L`                         | Top, middle, bottom of screen |
| `g g` / `G`                         | Top / bottom of history       |
| `Ctrl+u` `Ctrl+d` `Ctrl+b` `Ctrl+f` | Pages                         |
| `v` / `Space`                       | Start selection               |
| `V`                                 | Select lines                  |
| `Ctrl+v`                            | Rectangle selection           |
| `y`                                 | Copy and leave                |
| `/` / `?`                           | Search down / up              |
| `n` / `N`                           | Next match / the other way    |
| `q` or `Escape`                     | Leave                         |

Search, and `[` and `]` for prompts, are on main, not in a release yet.

## App keys, and macOS equivalents

| Action                               | Linux and web                                 | macOS                |
| ------------------------------------ | --------------------------------------------- | -------------------- |
| Go to tab 1 to 9                     | `Ctrl+1` to `Ctrl+9`                          | `Ctrl+1` to `Ctrl+9` |
| Tab overview                         | `Ctrl+0`                                      | `Ctrl+0`             |
| Command palette                      | `Ctrl+Shift+K`                                | `Cmd+K`              |
| Bigger / smaller text                | `Ctrl` and `+` / `-`, or `Ctrl` and the wheel | `Cmd` and `+` / `-`  |
| Reset text size                      |                                               | `Cmd+0`              |
| Select the scrollback                | `Ctrl+Shift+A`                                | `Cmd+A`              |
| Copy the selection                   | `Ctrl+Shift+C`                                | `Cmd+C`              |
| Paste                                | `Ctrl+Shift+V`                                | `Cmd+V`              |
| New window (desktop)                 | `Ctrl+Shift+N`                                | `Cmd+N`              |
| Focus window 1 to 9 (desktop)        | `Ctrl+Shift+1` to `9`                         | `Cmd+1` to `Cmd+9`   |
| Allow every pending send in this tab | `Ctrl+Enter`                                  | `Cmd+Enter`          |
| Quit (desktop)                       | `Ctrl+Q`                                      |                      |

Plain `Ctrl+C` stays the interrupt. The command palette keys are on main, not in a release yet.

When a pane asks "Allow?" (see [[Send Permissions]]), `↑` `↓` or `1` `2` move, `Enter` answers and `Escape` declines.

## Rebind a key

Put bindings in `~/.config/tmuxy/tmuxy.conf`. Saving applies them. It is normal tmux syntax.

### Example: add your own split key

```bash
# prefix v splits right, in the current pane's directory.
bind v split-window -h -c "#{pane_current_path}"

# The same key inside PANE mode.
bind -T pane v split-window -h -c "#{pane_current_path}"
```

### Example: get Ctrl+l back for your program

```bash
# Ctrl+l, Ctrl+k and the rest go to the program again.
unbind -n C-h
unbind -n C-j
unbind -n C-k
unbind -n C-l
```

Move between panes with `prefix p`, then `h` `j` `k` `l`, or the arrow versions, which stay bound.

### Change the prefix

```bash
unbind C-a
set -g prefix C-Space
bind C-Space send-prefix
```

Check the result with `tmuxy keymap --table prefix`. If a key does nothing, `tmuxy config check` names the line tmux could not parse. _Both are on main, not in a release yet._

## See also

- [[Configuration]]
- [[Panes Groups and Floats]]
- [[Tabs and Sessions]]
- [[Coming from tmux]]
