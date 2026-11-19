Drive tmuxy from a shell script: open panes, wait for them, read the result and branch on it. The `tmuxy` CLI is built for this. It has stable exit codes and JSON on every command.

Run `tmuxy --help` or `tmuxy <command> --help` for any flag. [[CLI Reference]] lists them all.

## The shape of the CLI

Commands are noun then verb: `tmuxy pane split`, `tmuxy tab create`, `tmuxy session save`. Mutations go through tmux's `run-shell`, so they are safe while tmuxy is attached.

| Noun      | Examples                                                            |
| --------- | ------------------------------------------------------------------- |
| `pane`    | `list`, `split`, `run`, `wait`, `capture`, `send`, `float`, `kill`  |
| `tab`     | `list`, `create`, `select`, `rename`, `layout`, `kill`              |
| `session` | `save`, `restore`, `snapshots`, `forget`, and on main `new`, `kill` |
| top level | `run`, `open`, `info`, `config`, `skill`                            |

## Targets

A pane is named by its tmux id (`%3`) or by a label. A label is the `@tmuxy-label` you set with `pane run --label`, or else the pane's title. With no target, a command acts on the pane it runs in.

A label that names no pane, or more than one, changes nothing and exits 3.

A tab is its `@id`, its index or its name.

## JSON everywhere

Add `--json` to any command.

- A query keeps its shape.
- A mutation answers `{"ok":true, ...}` with the ids it made.
- A failure answers `{"ok":false,"error":"...","code":N}`, and the exit code is `N`.

```sh
# one object per pane: id, tab, width, height, command, active, title, label, state, cwd
tmuxy pane list --all --json | jq -r '.[] | select(.state == "needs-input") | .id'

# a mutation says what it made
tmuxy pane run --json --label logs -- tail -f app.log
# {"ok":true,"paneId":"%7"}

# (session new is on main, not in a release yet)
tmuxy session new --json
# {"ok":true,"session":"quiet-meadow"}
```

## Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | OK                                                                         |
| 1    | Failed: tmux refused, the user declined, or a wait timed out               |
| 2    | Bad command line: unknown command, bad flag, missing argument              |
| 3    | Target not found, or a label that names more than one pane                 |
| 4    | No tmux server on the socket                                               |
| 5    | Sent, but what was waited for after it did not happen (`pane send --wait`) |
| 130  | Interrupted                                                                |

`pane run --wait` and `pane wait` exit with the program's own status instead.

## Wait, don't poll

Do not loop on `pane capture` to see if something finished. Ask tmuxy to wait.

```sh
# run in a new pane, block until it exits, exit with ITS status
tmuxy pane run --wait --for 20m -- npm test

# the same for a pane that already runs something
tmuxy pane wait logs --for 10m
```

`--for` takes `30s`, `10m` or `2h` and gives up with exit 1. `pane wait` keeps the pane open so it can read the status. Close it with `tmuxy pane kill`.

`pane send --wait` _(on main, not in a release yet)_ types into an agent's pane, then waits for the agent to take it up and finish. It needs the hooks from `tmuxy agent install`. It exits 5 if the agent never starts working (`--stall-after`, 5 seconds), stops at a prompt, errors or is replaced. Only an exit 1 is safe to retry. See [[AI Agents]].

The one thing worth polling is a server's ready line, with a time limit.

## Capture a screen

```sh
tmuxy pane capture %3 --trim --unwrap
```

| Flag            | What it does                          |
| --------------- | ------------------------------------- |
| `--trim`        | Drops trailing spaces and blank lines |
| `--unwrap`      | Joins lines the pane wrapped          |
| `--format text` | Plain text (default)                  |
| `--format vt`   | Keeps colours as escape sequences     |
| `--format html` | Renders colours as spans              |
| `--json`        | Answers in JSON                       |

## Run tmux commands: `tmuxy run`

```sh
tmuxy run swap-pane -s %0 -t %1
tmuxy run list-panes -F '#{pane_id} #{pane_current_command}'
tmuxy run copy-mode -q     # leave copy mode
```

It runs only a fixed list of tmux commands that read, arrange or close panes and windows, by full name or alias. `tmuxy run --help` prints the list. It refuses the rest:

- Keys into a pane, yours too (`send-keys`, `paste-buffer`, `pipe-pane`). Use `tmuxy pane send`.
- Commands that run a shell or keep a command for later (`run-shell`, `if-shell`, `split-window`, `new-session`, `bind-key`, `display-popup`). Use `pane split`, `pane run` or `tab create`.
- Writes to an option, hook or the environment (`set-option`, `set-hook`, `set-environment`, `source-file`).
- An argument ending in `;`, and a format that runs a shell: `#(...)`, or the `E:` and `T:` modifiers.
- `new-window`. It is turned into `tmuxy tab create`.
- `resize-window`. It is unreliable with control mode attached.

Every argument reaches tmux quoted, so formats are expanded by the command and never by a shell.

## Five recipes

### Run tests in a pane and branch on the result

```sh
status=0
tmuxy pane run --wait --for 20m --label tests --keep-open -- npm test || status=$?

if [ "$status" -eq 0 ]; then
  echo "tests passed"
else
  echo "tests failed ($status)"
  # the pane stayed open, so read why
  tmuxy pane capture tests --trim --unwrap | tail -30
fi

tmuxy pane kill tests
```

### Tail logs in a labelled pane

```sh
# a pane on the right, focus stays where it is
tmuxy pane run --label logs --split right --focus=false -- tail -f /var/log/app.log

# look at it later
tmuxy pane capture logs --trim | tail -20

# done with it
tmuxy pane kill logs
```

### Save a screen as text or HTML

```sh
tmuxy pane capture %3 --trim --unwrap > screen.txt
tmuxy pane capture %3 --format html > screen.html
```

### Open a float that closes itself

```sh
# a float with a command closes when the command exits
tmuxy pane float --width 100 --height 25 htop
```

Without `--detach`, a float with a command waits for it and prints its output. Add `--detach` to get the float's pane id back at once. Other options: `--left`, `--right`, `--top`, `--bottom` for a drawer, `--bg dim|blur|none`, `--hide-header`.

### Save a session

```sh
# also keep the last 500 lines of every pane
tmuxy session save work --scrollback 500

tmuxy session snapshots

# later, rebuild it (refused while it runs)
tmuxy session restore work
```

tmuxy saves a session's shape on every change, so `save` is for taking a snapshot now. A restore brings back programs typed at the prompt, not run. Add `--run` to run them. `tmuxy session forget work` deletes the snapshots.

## Ask a person

_On main, not in a release yet._

A script can stop and ask you. The question shows on every app connected to the session.

```sh
[ "$(tmuxy pane ask 'Delete the old builds?')" = Yes ] && rm -rf old-builds
branch=$(tmuxy pane ask "Branch name?" --text --for 10m)
```

It exits 1 if you dismiss it or it times out. Treat that as no.

## See also

- [[CLI Reference]]
- [[AI Agents]]
- [[Sub-agents]]
- [[Send Permissions]]
