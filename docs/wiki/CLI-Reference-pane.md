Every `tmuxy pane` subcommand and flag. The rest of the CLI is on [[CLI Reference]].

The flags common to every command (targets, `--json`, exit codes) are on [[CLI Reference]].

## pane

Manage panes: split, kill, select, resize, group, float.

| Command                                                  | What it does                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| `tmuxy pane list [--json] [--all]`                       | The panes of this tab (`--all`: of the session)               |
| `tmuxy pane split [-h\|-v]`                              | Split the current pane                                        |
| `tmuxy pane run [options] -- <cmd...>`                   | Run a command in a new pane and print its id                  |
| `tmuxy pane wait <target> [--for 10m]`                   | Wait for the program in a pane to exit                        |
| `tmuxy pane kill [target]`                               | Kill a pane                                                   |
| `tmuxy pane select [-U\|-D\|-L\|-R\|target]`             | Focus a pane                                                  |
| `tmuxy pane resize [-U\|-D\|-L\|-R] [n]`                 | Resize a pane                                                 |
| `tmuxy pane swap <src> <dst>`                            | Swap two panes                                                |
| `tmuxy pane zoom`                                        | Toggle zoom                                                   |
| `tmuxy pane break`                                       | Break the pane into its own tab                               |
| `tmuxy pane capture [target] [flags]`                    | What a pane shows                                             |
| `tmuxy pane listen [target] [flags]` **(main)**          | Print the lines a preview pane receives                       |
| `tmuxy pane send [flags] <keys...>`                      | Type keys into a pane                                         |
| `tmuxy pane ask <question> [flags]` **(main)**           | Ask the person a question                                     |
| `tmuxy pane queue [-t target] [--retract id]` **(main)** | The sends waiting for a busy pane                             |
| `tmuxy pane state <state> [target]`                      | Declare what the pane is doing                                |
| `tmuxy pane restore-cmd '<command>' [%id]`               | Say how to bring the pane back after a restore                |
| `tmuxy pane paste [-t target] <text>`                    | Paste text into a pane                                        |
| `tmuxy pane float [options] [cmd args...]`               | Create a float                                                |
| `tmuxy pane group <command>`                             | Pane group operations                                         |
| `tmuxy pane report <text\|->` **(main)**                 | Write this pane's report. `-t <target>` reads a pane's report |

`pane list --json` gives one object per pane: `id`, `tab`, `width`, `height`, `command`, `active`, `title`, `label`, `state` (`""` when unset) and `cwd`.

### pane run

Runs a command in a new pane, split from this one, and prints the pane's id. With `--wait`, it blocks and exits with the command's status.

| Flag                   | Meaning                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `--wait`               | Wait for the command and exit with its status                |
| `--for <duration>`     | With `--wait`: give up after `30s`, `10m`, `2h` (exit 1)     |
| `--split right\|below` | Where the new pane goes. Default: `below`                    |
| `--ratio <N>`          | The new pane's share of the split, in percent                |
| `--cwd <dir>`          | Start the command in this folder                             |
| `--label <L>`          | Name the pane, for `-t L` on every other command             |
| `--focus=false`        | Leave the focus where it is                                  |
| `--keep-open`          | Keep the pane open after the command exits                   |
| `--json`               | `{"ok":…,"paneId":"%N"}`, with `"status"` too under `--wait` |

### pane wait

`tmuxy pane wait <target> [--for <duration>]` waits for the program in a pane to exit and exits with its status. The pane is kept open so the status can be read. `tmuxy pane kill` closes it.

### pane capture

`tmuxy pane capture [-t <target>|<target>] [--trim] [--unwrap] [--format text|vt|html] [--json]`

| Flag                      | Meaning                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `--trim`                  | Drop trailing spaces and blank lines                                |
| `--unwrap`                | Join lines the pane wrapped                                         |
| `--format text\|vt\|html` | `vt` keeps colors as escape sequences, `html` renders them as spans |

### pane listen

`tmuxy pane listen [target] [--from-start] [--wait <duration>] [--json]` **(main)**

Prints the lines a preview (`tmuxy open`) receives, one JSON object per line: `{"emit":…}` from a page's `tmuxy.emit()` and `{"input":…}` from a markdown form control. It exits 0 when the preview ends.

| Flag                | Meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `--from-start`      | Also print what arrived before the listener started                      |
| `--wait <duration>` | How long to wait for a preview to show. Default `10s`, `0` does not wait |

Exit 3 means no such pane. Exit 1 means the pane shows no preview.

### pane send

`tmuxy pane send [-t <pane>] [--timeout SECONDS] [--queue] [--inbox] [--wait [--for 30m]] <keys...>`

Types keys into a pane, as `tmux send-keys` does. Each argument is literal text or a key name (`Enter`, `Escape`, `C-c`). Into your own pane the keys go at once. Into another pane they go only once you allow it there. Nothing is ever typed into a pane waiting at a prompt for you.

| Flag                   | Meaning                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `-t <pane>`            | The pane to type into. Default: your own                                                                |
| `--timeout <seconds>`  | Give up on an unanswered question after this long                                                       |
| `--queue` **(main)**   | Wait in line while the pane is busy, then send. Prints the send's id                                    |
| `--inbox` **(main)**   | Post the text to the agent's inbox instead of typing. A spike, off unless `set -g @tmuxy-send-inbox on` |
| `--wait` **(main)**    | Then wait for the agent in the pane to take the keys up and finish. Needs `tmuxy agent install`         |
| `--for <duration>`     | With `--wait` **(main)**: how long it may work. Default `30m`                                           |
| `--stall-after <secs>` | With `--wait` **(main)**: default `5`                                                                   |
| `--`                   | Everything after it is keys, even one starting with `-`                                                 |

Exit codes for `send`: `0` sent (and finished, with `--wait`). `1` nothing sent. `2` bad usage. `3` no such pane. `5` sent, but the wait ended badly. Only a `1` is safe to retry.

The question can be skipped with tmux options: `set -g @tmuxy-send-ask off`, `set -g @tmuxy-send-allow claude,%3` and `set -g @tmuxy-send-allow-into claude,agy`. See [[Send Permissions]].

### pane ask

`tmuxy pane ask <question> [--choice TEXT]... [--text] [-t <pane>] [--for <duration>] [--json]` **(main)**

Asks the person a question over a pane and waits. Every connected app shows it, and the first answer ends it on all of them.

| Flag               | Meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `--choice <text>`  | A button. Repeat for more (at most 6, 60 characters each). Prints the chosen text |
| `--text`           | A line of text to type instead. Prints it                                         |
| `-t <pane>`        | The pane to ask over. Default: your own                                           |
| `--for <duration>` | Take the question down unanswered after this long                                 |
| `--`               | Everything after it is the question                                               |

With neither `--choice` nor `--text`, the buttons are Yes and No. The question is at most 500 characters on one line. Exit `0` answered, `1` dismissed or timed out, `2` bad usage, `3` no such pane, `130` interrupted.

### pane state

`tmuxy pane state <needs-input|error|unread|working|idle|clear> [target]`, or `tmuxy pane state explain [target] [--json]` **(main)**.

### pane restore-cmd

`tmuxy pane restore-cmd '<command>' [%id]`, or `tmuxy pane restore-cmd --clear [%id]`.

### pane float

`tmuxy pane float [options] [cmd args...]`

| Flag                                     | Meaning                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--left`, `--right`, `--top`, `--bottom` | Drawer docked to that edge                                                                                 |
| `--width <N>`                            | Width in columns. Default 60. A top or bottom drawer spans the full width                                  |
| `--height <N>`                           | Height in rows. Default 15, never more than the tab's height. A left or right drawer spans the full height |
| `--bg dim\|blur\|none`                   | Backdrop. Default `dim`                                                                                    |
| `--hide-header`                          | Hide the title bar                                                                                         |
| `--detach`                               | With a command: print the float's pane id at once instead of waiting for the command                       |

### pane group

Pane groups turn panes into header tabs. Every subcommand takes `--json`.

| Command                                                        | What it does                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmuxy pane group add [PANE] [WIDTH] [HEIGHT]`                 | A new pane in PANE's group (a new group when it has none)                                                                                   |
| `tmuxy pane group park <ANCHOR> <GROUP> <CWD> [POS]`           | A new pane in GROUP, parked out of view beside ANCHOR. Prints the new pane's id                                                             |
| `tmuxy pane group close [PANE]`                                | Close PANE. A member on screen hands its place to the next first                                                                            |
| `tmuxy pane group gc`                                          | Kill the stash windows of groups with no member on screen                                                                                   |
| `tmuxy pane group switch <PANE>`                               | Show PANE in its group's slot                                                                                                               |
| `tmuxy pane group next [PANE] [--no-wrap]`                     | Show the next member. `--no-wrap` exits 3 instead of wrapping                                                                               |
| `tmuxy pane group prev [PANE] [--no-wrap]`                     | Show the previous member                                                                                                                    |
| `tmuxy pane group move <PANE> <INDEX>`                         | Put PANE at INDEX in its group's order (0 is first)                                                                                         |
| `tmuxy pane group join <PANE> <ANCHOR> [INDEX]`                | Make PANE a member of ANCHOR's group, out of view                                                                                           |
| `tmuxy pane group leave [PANE] [--tab\|--beside <PANE> [DIR]]` | Take PANE out of its group: as a tab (default) or split beside another pane. DIR is `left`, `right`, `up` or `down` (`right` when left out) |
| `tmuxy pane group all [PANE]`                                  | Every other pane of PANE's tab joins PANE's group                                                                                           |
| `tmuxy pane group ungroup [PANE]`                              | The group comes apart: each member back as a split, and the tab tiled                                                                       |

## See also

- [[CLI Reference]]
- [[Scripting with the CLI]]
- [[Panes Groups and Floats]]
