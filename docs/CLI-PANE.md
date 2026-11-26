# `tmuxy pane` reference

Generated from `--help` by `node bin/ci/cli-reference.mjs`; the other commands are in [CLI.md](CLI.md).

## `tmuxy pane`

```text
Usage: tmuxy pane <command> [args...]

Commands:
  list          List all panes [--json] [--all]
  split         Split current pane [-h|-v]
  run           Run a command in a new pane [--wait] [--label L] -- <cmd...>
  wait          Wait for the program in a pane to exit <target> [--for 10m]
  kill          Kill a pane [target]
  select        Select/focus a pane [-U|-D|-L|-R|target]
  resize        Resize a pane [-U|-D|-L|-R] [n]
  swap          Swap two panes <src> <dst>
  zoom          Toggle pane zoom
  break         Break pane into own tab
  capture       Capture pane content [target] [--trim] [--unwrap] [--format text|vt|html]
  listen        Print the lines a preview pane receives, as they arrive [target] [--from-start]
  send          Send keys to pane <keys...>
  ask           Ask the person a question <question> [--choice T]... [--text]
  queue         Sends waiting for a busy pane [-t target] [--retract id]
  state         Declare what the pane is doing <state> [target]
  restore-cmd   Say how to bring the pane back after a restore '<command>' [%id]
  paste         Paste text into pane <text>
  float         Create a float pane [cmd args...]
  group         Pane group operations (see 'tmuxy pane group --help')

A target is a pane id (%3) or a label (see 'tmuxy --help'); the default is
the pane this runs in. Run 'tmuxy pane <command> --help' for details.
```

### `tmuxy pane list`

```text
Usage: tmuxy pane list [--json] [--all]

The panes of this tab (--all: of the session). With --json, one object a
pane: id, tab, width, height, command, active, title, label, state (the
pane's @tmuxy-pane-state word, "" when unset) and cwd (its folder).
```

### `tmuxy pane split`

```text
Usage: tmuxy pane split [-h|-v] [--json]
```

### `tmuxy pane run`

```text
Usage: tmuxy pane run [options] -- <command...>

Run a command in a new pane, split from this one, and print the pane's id.
With --wait, block until the command exits and exit with ITS status, so a
script can branch on it (`if tmuxy pane run --wait -- npm test; then …`).

Options:
  --wait            Wait for the command; exit with its status
  --for DURATION    With --wait: give up after 30s, 10m, 2h… (exit 1)
  --split right|below   Where the new pane goes (default: below)
  --ratio N         The new pane's share of the split, in percent
  --cwd DIR         Start the command in DIR
  --label L         Name the pane, for `-t L` on every other command
  --focus=false     Leave the focus where it is
  --keep-open       Keep the pane open after the command exits
  --json            {"ok":…,"paneId":"%N"} (with --wait: "status" too)
```

### `tmuxy pane wait`

```text
Usage: tmuxy pane wait <target> [--for DURATION]

Wait for the program in a pane to exit, and exit with its status. The pane
is kept open (remain-on-exit) so the status can be read; `tmuxy pane kill`
closes it. --for gives up after 30s, 10m, 2h… with exit 1.
```

### `tmuxy pane kill`

```text
Usage: tmuxy pane kill [target]
```

### `tmuxy pane select`

```text
Usage: tmuxy pane select [-U|-D|-L|-R|target]
```

### `tmuxy pane resize`

```text
Usage: tmuxy pane resize [-U|-D|-L|-R] [n]
```

### `tmuxy pane swap`

```text
Usage: tmuxy pane swap <src> <dst>
```

### `tmuxy pane zoom`

```text
Usage: tmuxy pane zoom
```

### `tmuxy pane break`

```text
Usage: tmuxy pane break
```

### `tmuxy pane capture`

```text
Usage: tmuxy pane capture [-t <target>|<target>] [--trim] [--unwrap] [--format text|vt|html] [--json]

What is on a pane's screen. --trim drops trailing spaces and blank lines;
--unwrap joins lines the pane wrapped; --format vt keeps the colours as
escape sequences, html renders them as spans.
```

### `tmuxy pane listen`

```text
Usage: tmuxy pane listen [target] [--from-start] [--wait DURATION] [--json]

Print the lines the preview in a pane (tmuxy open) receives, one JSON object
per line, as they arrive: {"emit":…} from a page's tmuxy.emit(), and
{"input":…} from a markdown form control. Exits 0 when the preview ends.

The target defaults to this pane. A listener started before its preview
waits for it (--wait, 10s by default; 0 does not wait) and then prints
every line the preview receives. One started while a preview shows prints
what arrives from then on; --from-start prints what came before first.

Exit codes: 3 no such pane, 1 the pane shows no preview.
```

### `tmuxy pane send`

```text
Usage: tmuxy pane send [-t <pane>] [--timeout SECONDS] [--queue] [--inbox] [--wait [--for 30m]] <keys...>

Type keys into a pane, as tmux send-keys does: each argument is literal text
or a key name (Enter, Escape, C-c, ...), with nothing between them.

Into your own pane (no -t) the keys go at once. Into another pane they go
only once the user allows it there: the pane shows who wants to send what,
and this blocks until they answer.

Nothing is ever typed into a pane waiting at a prompt for the user (its
state says it needs the user, or its screen shows an approval dialog), asked
or not: a key there could answer it. Such a send exits 1 and types nothing.

Options:
  -t <pane>            The pane to type into. Default: your own.
  --timeout SECONDS    Give up on an unanswered question after this long.
  --inbox              Post the text to the agent's inbox instead of typing
                       it: a spike, off unless set -g @tmuxy-send-inbox on
                       (see docs/AGENT-INBOX.md in the tmuxy repository).
                       The words are one message; a final Enter is dropped.
  --queue              Wait in line while the pane is busy (working, or at
                       a prompt), then send as above. Sends in line go one
                       turn at a time, first come first served; this prints
                       the send's id, and `tmuxy pane queue -t <pane>
                       --retract <id>` takes it back (exit 1, nothing sent).
  --wait               Then wait for the agent in the pane to take the keys
                       up and finish (it needs tmuxy's hooks: tmuxy agent
                       install). Exits 5 if it has not started working
                       within --stall-after seconds (stalled), stops at a
                       prompt, reports an error, or another program takes
                       its place.
  --for DURATION       With --wait: how long it may work (30s, 10m, 2h).
                       Default 30m.
  --stall-after SECS   With --wait: default 5.
  --                   Everything after it is keys, even one starting with -.

Skipping the question:
  set -g @tmuxy-send-ask off            never ask
  set -g @tmuxy-send-allow claude,%3    don't ask these callers or panes
  set -g @tmuxy-send-allow-into claude,agy
                                        don't ask into panes running these

Rules of your own: permissions.json in the config dir can refuse a command
(deny) or have it asked whatever the options above say. It skips no question.
`tmuxy config permissions` checks the file and says what a send would get.

Exit status: 0 sent (and, with --wait, finished); 1 nothing sent (denied, declined,
unanswered, at a prompt, taken out of the queue, or --wait into an agent
already working); 2 bad
usage; 3 no such pane; 5 sent, but with --wait it stalled, stopped at a
prompt, reported an error, was replaced, or ran out of time. Under --json a
5 says "sent": true. Only a 1 is safe to retry.

Examples:
  tmuxy pane send ls Enter
  tmuxy pane send -t %3 'npm test' Enter
```

### `tmuxy pane ask`

```text
Usage: tmuxy pane ask <question> [--choice TEXT]... [--text] [-t <pane>] [--for DURATION]

Ask the person a question over a pane and wait for the answer. Every app
connected to the session shows it (desktop, browser, phone); the first
answer given ends it on all of them. While it is up the pane says it needs
the person, and gets its own state back after.

Options:
  --choice TEXT     A button; repeat for more (at most 6, 60 characters
                    each). Prints the chosen one's text.
  --text            A line of text to type instead, with Submit. Prints it.
                    With neither: the choices are Yes and No.
  -t <pane>         The pane to ask over. Default: your own.
  --for DURATION    Take the question down unanswered after this long
                    (30s, 10m, 2h). Default: wait for the answer.
  --json            {"ok":true,"answer":"..."}
  --                Everything after it is the question, even a word
                    starting with -.

The question is at most 500 characters of one line: no newline, tab or
other control character. A pane already showing a question (a send's, or
another ask) is asked once that one is answered.

Exit status: 0 answered (the answer on stdout); 1 dismissed (Escape), no
answer within --for, or the pane was still asking another question then;
2 bad usage; 3 no such pane; 130 interrupted (the question comes down).

Examples:
  tmuxy pane ask "Deploy to production?" --choice deploy --choice cancel
  [ "$(tmuxy pane ask 'Delete the old builds?')" = Yes ] && rm -rf old-builds
  branch=$(tmuxy pane ask "Branch name?" --text --for 10m)
```

### `tmuxy pane queue`

```text
Usage: tmuxy pane queue [-t <target>] [--retract <id>]

The sends waiting in line for a pane (tmuxy pane send --queue), first
first; --retract takes one back before any of it is sent.
```

### `tmuxy pane state`

```text
Usage: tmuxy pane state <needs-input|error|unread|working|idle|clear> [target]
       tmuxy pane state explain [target] [--json]
```

### `tmuxy pane restore-cmd`

```text
Usage: tmuxy pane restore-cmd '<command>' [%id]
       tmuxy pane restore-cmd --clear [%id]
```

### `tmuxy pane paste`

```text
Usage: tmuxy pane paste [-t <target>] [--] <text>
```

### `tmuxy pane float`

```text
Usage: tmuxy pane float [options] [cmd args...]

Options:
  --left          Drawer docked to left edge
  --right         Drawer docked to right edge
  --top           Drawer docked to top edge
  --bottom        Drawer docked to bottom edge
  --width N       Width in columns, default 60 (a top/bottom drawer spans the
                  full width, so it ignores this)
  --height N      Height in rows, default 15 and never more than the tab's own
                  height (a left/right drawer spans the full height, so it
                  ignores this)
  --bg MODE       Backdrop: dim (default), blur, none
  --hide-header   Hide the title bar
  --detach        With a command: print the float's pane id at once instead
                  of waiting for the command and printing its output
```

### `tmuxy pane group`

```text
Pane-group operations, run inside `tmux run-shell` (`tmuxy pane group`, the `pane-group` script)

Usage: tmuxy-server group [OPTIONS] <COMMAND>

Commands:
  add      A new pane in PANE's group (a new group when it has none), shown in PANE's place, WIDTH by HEIGHT (PANE's size when left out)
  park     A new pane in GROUP, parked out of view beside ANCHOR (any tmux target) in CWD, at POS in the order. Prints the new pane's id
  close    Close PANE; a member on screen hands its place to the next first
  gc       Kill the stash windows of groups left with no member on screen (the parked members of a tab that was killed outright)
  switch   Show PANE in its group's slot
  next     Show the member after the one on screen (wrapping). With `--no-wrap`, exit 3 instead of wrapping or when PANE is in no group
  prev     Show the member before the one on screen (wrapping). With `--no-wrap`, exit 3 instead of wrapping or when PANE is in no group
  move     Put PANE at INDEX in its group's order (0 is first)
  join     Make PANE a member of ANCHOR's group, out of view, at INDEX
  leave    Take PANE out of its group, as a tab of its own (the default) or split in beside another pane
  all      Every other pane of PANE's tab joins PANE's group, in tab order
  ungroup  PANE's group comes apart: each other member back as a split beside PANE, in group order, PANE out of the group, and the tab tiled
  help     Print this message or the help of the given subcommand(s)

Options:
      --json  Answer in JSON
  -h, --help  Print help
```

#### `tmuxy pane group add`

```text
A new pane in PANE's group (a new group when it has none), shown in PANE's place, WIDTH by HEIGHT (PANE's size when left out)

Usage: tmuxy-server group add [OPTIONS] [PANE] [WIDTH] [HEIGHT]

Arguments:
  [PANE]
  [WIDTH]
  [HEIGHT]

Options:
      --json  Answer in JSON
  -h, --help  Print help
```

#### `tmuxy pane group park`

```text
A new pane in GROUP, parked out of view beside ANCHOR (any tmux target) in CWD, at POS in the order. Prints the new pane's id

Usage: tmuxy-server group park [OPTIONS] <ANCHOR> <GROUP> <CWD> [POS]

Arguments:
  <ANCHOR>
  <GROUP>
  <CWD>
  [POS]

Options:
      --json  Answer in JSON
  -h, --help  Print help
```

#### `tmuxy pane group close`

```text
Close PANE; a member on screen hands its place to the next first

Usage: tmuxy-server group close [OPTIONS] [PANE]

Arguments:
  [PANE]

Options:
      --json  Answer in JSON
  -h, --help  Print help
```

#### `tmuxy pane group gc`

```text
Kill the stash windows of groups left with no member on screen (the parked members of a tab that was killed outright)

Usage: tmuxy-server group gc [OPTIONS]

Options:
      --json  Answer in JSON
  -h, --help  Print help
```

#### `tmuxy pane group switch`

```text
Show PANE in its group's slot

Usage: tmuxy-server group switch [OPTIONS] <PANE>

Arguments:
  <PANE>

Options:
      --json  Answer in JSON
  -h, --help  Print help
```

#### `tmuxy pane group next`

```text
Show the member after the one on screen (wrapping). With `--no-wrap`, exit 3 instead of wrapping or when PANE is in no group

Usage: tmuxy-server group next [OPTIONS] [PANE]

Arguments:
  [PANE]

Options:
      --json     Answer in JSON
      --no-wrap
  -h, --help     Print help
```

#### `tmuxy pane group prev`

```text
Show the member before the one on screen (wrapping). With `--no-wrap`, exit 3 instead of wrapping or when PANE is in no group

Usage: tmuxy-server group prev [OPTIONS] [PANE]

Arguments:
  [PANE]

Options:
      --json     Answer in JSON
      --no-wrap
  -h, --help     Print help
```

#### `tmuxy pane group move`

```text
Put PANE at INDEX in its group's order (0 is first)

Usage: tmuxy-server group move [OPTIONS] <PANE> <INDEX>

Arguments:
  <PANE>
  <INDEX>

Options:
      --json  Answer in JSON
  -h, --help  Print help
```

#### `tmuxy pane group join`

```text
Make PANE a member of ANCHOR's group, out of view, at INDEX

Usage: tmuxy-server group join [OPTIONS] <PANE> <ANCHOR> [INDEX]

Arguments:
  <PANE>
  <ANCHOR>
  [INDEX]

Options:
      --json  Answer in JSON
  -h, --help  Print help
```

#### `tmuxy pane group leave`

```text
Take PANE out of its group, as a tab of its own (the default) or split in beside another pane

Usage: tmuxy-server group leave [OPTIONS] [PANE]

Arguments:
  [PANE]

Options:
      --json                 Answer in JSON
      --tab                  A tab of its own
      --beside <PANE> [DIR]  Split in beside PANE, on the DIR side (left, right, up or down; right when left out)
  -h, --help                 Print help
```

#### `tmuxy pane group all`

```text
Every other pane of PANE's tab joins PANE's group, in tab order

Usage: tmuxy-server group all [OPTIONS] [PANE]

Arguments:
  [PANE]

Options:
      --json  Answer in JSON
  -h, --help  Print help
```

#### `tmuxy pane group ungroup`

```text
PANE's group comes apart: each other member back as a split beside PANE, in group order, PANE out of the group, and the tab tiled

Usage: tmuxy-server group ungroup [OPTIONS] [PANE]

Arguments:
  [PANE]

Options:
      --json  Answer in JSON
  -h, --help  Print help
```
