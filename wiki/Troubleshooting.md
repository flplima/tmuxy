Find your symptom in the table, then read the fix. If nothing matches, the last sections show how to collect what an issue needs.

## Symptom, cause, fix

| Symptom                                                                                                   | Cause                                                                                             | Fix                                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| At launch, a message says tmux is missing or too old                                                      | tmuxy needs tmux 3.2 or newer                                                                     | Check `tmux -V`, then install or update tmux. Homebrew and the `.deb` install it for you           |
| The Linux AppImage does not start                                                                         | It needs FUSE at runtime                                                                          | On Debian and Ubuntu, `sudo apt install libfuse2`. Or use the `.deb`                               |
| My existing tmux sessions are not there                                                                   | tmuxy runs on its own socket (`tmuxy`), not your default one                                      | Desktop: pick **my tmux** in the session menu. Web: `TMUX_SOCKET=default tmuxy server`             |
| `tmuxy connect default` does nothing in the browser                                                       | The web server binds its socket at launch                                                         | Restart it with `TMUX_SOCKET=<name> tmuxy server`. `connect` only moves the desktop app            |
| My prefix, status line and plugins are gone                                                               | tmuxy does not read `~/.tmux.conf` by default                                                     | `tmuxy config use-tmux-conf on`, then reconnect                                                    |
| Part of my config has no effect                                                                           | A `source-file` line points at a missing file, and tmux stops reading there                       | `tmuxy config doctor` lists them. `tmuxy config doctor --fix` comments them out and keeps a backup |
| `Ctrl+Shift+K` does not open the palette                                                                  | Your browser keeps that key                                                                       | Use `prefix P` instead                                                                             |
| Cmd+F or Ctrl+F does not find text                                                                        | tmuxy has no find box, on purpose                                                                 | Copy mode: `prefix [`, then `/` or `?`. See [[Copy Mode and Scrollback]]                           |
| The page loads but nothing works behind my reverse proxy, and it says the request Host is not this server | The proxy passes its public name, which the server does not know                                  | Start the server with `--allowed-host tmux.example.com`. Repeat the flag for more names            |
| The server will not listen on `0.0.0.0`                                                                   | A routable address needs a password                                                               | Set `TMUXY_PASSWORD`, or pass `--no-auth` only on a network where everyone may have a shell as you |
| A "reconnecting" notice shows                                                                             | The link to the server dropped                                                                    | It retries by itself, from 1 second up to 30. Press **Retry now** to skip the wait                 |
| No new pane can be created, or panes die at once                                                          | Shells left hanging by a pane that died during startup are using up the machine's pseudoterminals | Run `tmuxy cleanup --dry-run` to look, then `tmuxy cleanup`                                        |
| New shells print `getcwd: cannot access parent directories`                                               | An older build started the tmux server inside the AppImage's mount, which has since gone          | Restart that tmux server. Current builds start it elsewhere                                        |
| Text after an emoji is a column or two off, on tmux 3.2 or 3.6                                            | Those versions size some emoji differently from tmuxy                                             | A known limitation. tmux 3.4, 3.7 and newer size them the way tmuxy does                           |
| `tmuxy pane send` exits 1 and types nothing                                                               | The target pane is waiting at a prompt for you, or the question was declined                      | Answer in that pane. tmuxy never types into a prompt that waits for you. See [[Send Permissions]]  |
| A pane showing a pager closes with a notice                                                               | tmux 3.4 prints some command output in view mode, which tmuxy cannot draw                         | Nothing to do. tmuxy closes the view and tells you                                                 |

## Check your config

```sh
tmuxy config doctor      # missing source-file targets, exit 1 if any
tmuxy config paths       # every file tmuxy reads or writes, and where
tmuxy keymap             # every binding, and the file and line it came from
```

_On main, not in a release yet:_ `tmuxy config check` reports what tmux cannot parse, with the file and line, without applying anything. `tmuxy keymap` is also main only.

## Free up stuck shells

```sh
tmuxy cleanup --dry-run   # list what would be reaped
tmuxy cleanup             # reap them
```

## Read the logs

| Where you run it | Where to look                                                         |
| ---------------- | --------------------------------------------------------------------- |
| Web app          | The browser's developer tools (`F12`), the **Console** tab            |
| `tmuxy server`   | Its terminal output. `RUST_LOG=debug` adds detail                     |
| Desktop app      | `tmuxy.log` in tmuxy's state folder. `tmuxy config paths` shows where |
| A plugin         | `tmuxy plugin log <name>`                                             |

Logs can quote a command line or a folder name. Read them before you share them.

## Take a trace

A trace is a local file of what tmuxy did, in order. It is off by default and never leaves your machine. At the default `shape` level it records the shape of each action and never what you typed or what a pane printed.

1. Turn it on. In the app, open the **Debug** menu and pick **Enable Traces**. For the server, start it with `tmuxy server --trace`.
2. Reproduce the problem. Right after, mark the moment:

   ```sh
   tmuxy trace --mark "the pane froze here"
   ```

3. Take the last few actions. In the app (_on main, not in a release yet_), the **Debug** menu's **Copy Trace…** shows what it will copy. From a shell (also _on main_):

   ```sh
   # --redact swaps names and paths for placeholders
   tmuxy trace --last 20 --redact > tmuxy-trace-slice.ndjson
   ```

4. Read it before you share it.

`tmuxy trace --health` prints a short summary of reconnects, rejected commands and anomalies. To switch tracing off everywhere, set `DO_NOT_TRACK=1` or `TMUXY_NO_TRACE=1`.

### What a trace holds

| Recorded                                     | Never recorded                   |
| -------------------------------------------- | -------------------------------- |
| Which action ran and how long each step took | What you typed or pasted         |
| Pane and window ids (`%3`, `@1`)             | Anything a pane printed          |
| Names and paths, hashed                      | Clipboard contents               |
| The verb of a tmux command                   | Command arguments and error text |

It does reveal when you used tmuxy, how many panes and tabs you had, and the rhythm of your typing. If that matters, share a short slice or none.

### Read it before you share it

A trace is plain text, one JSON object per line. Redaction is a rule, not a reviewer. Every line below should print nothing:

```sh
grep -i -e "$USER" -e "$(hostname)" tmuxy-trace-slice.ndjson
grep -i -e "my-project" -e "my-company" tmuxy-trace-slice.ndjson
```

Put your own project and client names in the second one. If something prints, do not attach the slice. Tell us in the issue what got through, since that is a bug in the redaction. Never share a slice taken from a `Labeled` or `Full` trace without redacting it.

## File an issue

Open an issue on the [tmuxy repository](https://github.com/flplima/tmuxy/issues) and include:

- what you did, what you expected and what happened, in order
- `tmuxy --version` and `tmux -V`, which matters most
- your OS, and your browser if you use the web app
- how you run tmuxy: desktop (and how you installed it), web on the same machine, or web from another one
- a trace slice, if you can

_On main, not in a release yet:_ the **Debug** menu's **Copy Bug Report Snippet** puts the versions and settings on your clipboard as Markdown. It holds no names, commands, paths or hosts. Read it, then paste it.

A security problem does not go in a public issue. See [[Contributing]] for where to send it.

## See also

- [[FAQ]]
- [[Installation]]
- [[Configuration]]
- [[Remote Access]]
