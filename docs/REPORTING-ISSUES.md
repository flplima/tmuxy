# Reporting an issue

A good report is one we can reproduce. This page says what to put in it, how to attach an action trace (tmuxy's own record of what happened), and how to check that trace before you share it. The [bug report form](../.github/ISSUE_TEMPLATE/bug.yml) asks for the same things.

## What to include

1. **What you did, what you expected, what happened.** Steps, in order, from a fresh start if you can.
2. **The versions and your setup.** The quickest way: the **Debug** menu's `Copy Bug Report Snippet` puts them on the clipboard as Markdown (tmuxy's and tmux's versions, web or desktop, the OS, the theme and the menu's switches, how many tabs and panes), and nothing else: no names, commands, paths or hosts. Read it, then paste it. Without the app at hand:
   - `tmuxy --version`
   - `tmux -V`. This one matters most: tmux 3.2 and later are supported, and each version has control-mode bugs of its own that tmuxy works around ([TMUX-VERSION-BUGS.md](TMUX-VERSION-BUGS.md)).
   - Your OS, and for the web app your browser.
3. **How you run tmuxy:** the desktop app (and how you installed it: Homebrew, a `.dmg`, an AppImage, a `.deb`), the web app on the same machine, or the web app from another machine (over a VPN, an SSH tunnel, a reverse proxy).
4. **A trace slice**, if you can. It is the fastest way to see what tmuxy did, in order, across the browser, the server and tmux.

## Taking a trace

Tracing is off by default. Nothing is sent anywhere: the trace is a file on the machine that runs tmuxy ([TELEMETRY.md](TELEMETRY.md)).

1. **Turn it on.** In the app: the **Debug** menu, `Enable Traces`. For `tmuxy server`: start it with `--trace`.
2. **Reproduce the problem.** Right after it happens, mark the moment:

   ```
   tmuxy trace --mark "the pane froze here"
   ```

3. **Take a redacted slice**, not the whole file. In the app: the **Debug** menu's `Copy Trace…` shows the last 20 actions, redacted, in full, and its `Copy` button copies exactly what it shows. From a terminal:

   ```
   tmuxy trace --last 20 --redact > tmuxy-trace-slice.ndjson
   ```

   Redaction applies whatever level the trace was taken at. Session names, paths, error text, command arguments and marker labels become placeholders numbered by first appearance (`session-1`, `path-2`), the same value always the same placeholder; ids, operations, timing and numbers stay.
4. **Read it** (below), then paste it or attach the file to the issue.

The file itself is `trace.ndjson` in tmuxy's state directory: `~/.local/state/tmuxy` on Linux, `~/Library/Application Support/tmuxy` on macOS, or wherever `TMUXY_STATE_DIR` points. The Debug menu's `Copy trace.ndjson Path` gives it to you. With the web app, the file is on the machine running the server, not the one running the browser.

`tmuxy trace --check` also gives a short health summary (reconnects, rejected commands, errors). From a `Shape` trace it is safe to paste as text.

## What a trace holds

At the `Shape` level, a trace records the shape of each action, never its content ([TRACING.md](TRACING.md)):

| Recorded | Never recorded |
| --- | --- |
| Which action ran (`SendText`, `Split`, a reconnect) and how long each step took | What you typed or pasted |
| Pane and window ids (`%3`, `@1`) | Anything a pane printed: output, the screen, scrollback |
| Session and window names, folders, file paths, **hashed** (an opaque id, with a salt that changes every run) | Clipboard contents |
| The verb of a tmux command (`send-keys`), never its arguments | Command lines and their arguments |
| Typed error codes | Error text, which can quote a command or its output |

What it does reveal, even at `Shape`: when you used tmuxy and for how long, how many panes and tabs you had, and the rhythm of your typing (that a key was sent and when, not which key). If that matters to you, share a short slice, or none.

The other levels are for your own debugging, not for a public issue:

- `Labeled` writes names, folders and error text in the clear.
- `Full` writes whole command lines, cut at the first one that carries keystrokes.

The level applies to the lines written while it is on, so a trace file can hold lines from an earlier, more detailed level. A redacted slice replaces those names whatever the level; an unredacted one does not, so never share one taken from a `Labeled` or `Full` trace.

## Reading a slice before you share it

A slice is plain text, one JSON object per line, and redaction is a rule, not a reviewer: read what you are about to share. Then look for anything of yours by name. Every line here should print nothing:

```
grep -i -e "$USER" -e "$(hostname)" tmuxy-trace-slice.ndjson
grep -i -e "my-project" -e "my-company" tmuxy-trace-slice.ndjson
```

Put your own project, client or folder names in the second line. If either prints something, do not attach the slice, and tell us in the issue what got through: that is a bug in the redaction. If you are unsure, describe the problem without a trace. We will ask for what we need.

To stop tracing afterwards: the Debug menu's switch, or `DO_NOT_TRACK=1` / `TMUXY_NO_TRACE=1`, which force it off everywhere.

## Logs and the browser console

- **Web app:** the browser's developer tools (`F12`, or right-click and `Inspect`), the `Console` tab. Copy any red error and its stack.
- **`tmuxy server`:** what it prints to its terminal, or your process manager's log. `RUST_LOG=debug` makes it more detailed.
- **Desktop app:** `tmuxy.log` in the same state directory as the trace. The desktop app has no developer tools in a release build.

Logs can quote a command line or a folder name. Read them as you read a slice, and cut what you would not post.

## Security issues

A security problem does not go in a public issue. The [security policy](../SECURITY.md) says how to report one privately; [docs/SECURITY.md](SECURITY.md) describes the risks tmuxy guards against.
