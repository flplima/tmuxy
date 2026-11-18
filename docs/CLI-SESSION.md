# `tmuxy session` reference

Generated from `--help` by `node bin/ci/cli-reference.mjs`; the other commands are in [CLI.md](CLI.md).

## `tmuxy session`

```text
Usage: tmuxy session <command> [args...]

Commands:
  new           Create a detached session [name] [--cwd DIR] [-- command...]
  rename        Rename a session [session] <new-name>
  kill          Kill a session <session> (its snapshot stays)
  switch        Interactive session switcher
  connect       Connect to a server and attach <dest> [--socket NAME]
  save          Snapshot a session now [name] [--scrollback N]
  restore       Rebuild a session from its snapshot <name> [--run]
  snapshots     The sessions that have a snapshot, and whether they run
  forget        Delete a session's snapshots <name> [--force]

A session's shape — tabs, splits, floats, sidebars, groups, each pane's
directory and program — is saved on every change and brought back when the
server starts and the session is gone. Programs come back typed at the
prompt, not run; `--run` runs them. A pane says how to bring itself back with
`tmuxy pane restore-cmd '<command>'`.
```

### `tmuxy session new`

```text
Usage: tmuxy session new [name] [--cwd DIR] [--json] [-- command...]

Create a session, detached: your own client stays where it is. With no name
it gets a memorable one (`quiet-meadow`). A name a session already has exits
1 and creates nothing. Prints the session's name.

Options:
  --cwd DIR    Start the first pane in DIR (exit 2 when it is no directory)
  --json       {"ok":true,"session":"<name>"}
  -- command   Run this in the first pane instead of the shell
```

### `tmuxy session rename`

```text
Usage: tmuxy session rename [session] <new-name> [--json]

Rename a session; with one argument, the one you are in. A name another
session has exits 1. --json answers {"ok":true,"session":"<new-name>"}. The
session's snapshot, if any, keeps the old name until the session is saved
again.
```

### `tmuxy session kill`

```text
Usage: tmuxy session kill <session> [--json]

Kill a session and every pane in it. The session is always named: there is
no default, so a script cannot kill the one it runs in by leaving the name
out. A session that does not exist exits 3. --json answers
{"ok":true,"session":"<name>"}.

The session's snapshot stays, marked exited, so `tmuxy session restore`
brings it back; `tmuxy session forget <name>` deletes it.
```

### `tmuxy session switch`

```text
Usage: tmuxy session switch

Interactive session switcher.
```

### `tmuxy session connect`

```text
Usage: tmuxy session connect [<dest>] [--socket <name>] [--session <name>]

Connect to a tmux server on <dest> ([user@]host, or "localhost" / empty for
this machine) and attach to a session on its socket (default: tmuxy).

Stages:
  1. ssh <user@host> (or localhost)
  2. tmux <version> on the socket <name>
  3. listing sessions
  4. attach

Options:
  --socket <name>   tmux socket name (-L) or path (-S) (default: tmuxy)
  --session <name>  Session to attach to on the target server
  -h, --help        Show this help
```

### `tmuxy session save`

```text
Snapshot a running session now (the autosave does this on every change)

Usage: tmuxy-server session save [OPTIONS] [NAME]

Arguments:
  [NAME]  The session. Defaults to `TMUXY_SESSION`, then `tmuxy`

Options:
      --scrollback <N>  Also keep the last N lines of every pane, replayed on restore
      --json            Answer in JSON
  -h, --help            Print help
```

### `tmuxy session restore`

```text
Rebuild a session from its latest snapshot. Refuses a running session

Usage: tmuxy-server session restore [OPTIONS] <NAME>

Arguments:
  <NAME>

Options:
      --run   Run each pane's program instead of offering it in a banner
      --json  Answer in JSON
  -h, --help  Print help
```

### `tmuxy session snapshots`

```text
The sessions that have a snapshot, and when it was taken

Usage: tmuxy-server session snapshots [OPTIONS]

Options:
      --json  Answer in JSON
  -h, --help  Print help
```

### `tmuxy session forget`

```text
Delete a session's snapshots. A running session keeps running unless `--force`, which kills it first

Usage: tmuxy-server session forget [OPTIONS] <NAME>

Arguments:
  <NAME>

Options:
      --force
      --json   Answer in JSON
  -h, --help   Print help
```
