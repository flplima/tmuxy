# Reporting an issue

A good report is one we can reproduce. This page says what to put in it, how to attach an action trace (tmuxy's own record of what happened), and how to check that trace before you share it. The [bug report form](../.github/ISSUE_TEMPLATE/bug.yml) asks for the same things.

## What to include

1. **What you did, what you expected, what happened.** Steps, in order, from a fresh start if you can.
2. **The versions:**
   - `tmuxy --version`
   - `tmux -V`. This one matters most: tmux 3.2 and later are supported, and each version has control-mode bugs of its own that tmuxy works around ([TMUX-VERSION-BUGS.md](TMUX-VERSION-BUGS.md)).
   - Your OS, and for the web app your browser.
3. **How you run tmuxy:** the desktop app (and how you installed it: Homebrew, a `.dmg`, an AppImage, a `.deb`), the web app on the same machine, or the web app from another machine (over a VPN, an SSH tunnel, a reverse proxy).
4. **A trace slice**, if you can. It is the fastest way to see what tmuxy did, in order, across the browser, the server and tmux.

## Taking a trace

<!-- TO UPDATE when the Debug menu's "Copy Bug Report Snippet" (menu id
debug-copy-report) and "Copy Trace…" land on main. The snippet is Markdown with
`### Environment` (tmuxy version and web or desktop, tmux version, OS) and
`### Settings` (theme and mode, cursor blink, ask before sending keys,
transparency, traces and level, tab and pane counts), and nothing else: no
names, commands, paths or hosts. Then: step 2 above says to paste the snippet
(and to read it first, as its notice asks); the issue template gets an optional
"Bug report snippet" field beside the version fields; steps 3 and 4 and the
manual check below give way to the redacted trace and its preview. Until then,
this section is what works on main. -->

Tracing is off by default. Nothing is sent anywhere: the trace is a file on the machine that runs tmuxy ([TELEMETRY.md](TELEMETRY.md)).

1. **Turn it on, at the `Shape` level.** In the app: the **Debug** menu, `Enable Traces`, then `Shape`. For `tmuxy server`: start it with `--trace`, and `TMUXY_TRACE_LEVEL=shape` (the default).
2. **Reproduce the problem.** Right after it happens, mark the moment:

   ```
   tmuxy trace --mark "the pane froze here"
   ```

3. **Take a slice**, not the whole file. The last few actions are usually enough:

   ```
   tmuxy trace --last 20 > tmuxy-trace-slice.ndjson
   ```

4. **Check the slice** (below), then attach `tmuxy-trace-slice.ndjson` to the issue.

The file itself is `trace.ndjson` in tmuxy's state directory: `~/.local/state/tmuxy` on Linux, `~/Library/Application Support/tmuxy` on macOS, or wherever `TMUXY_STATE_DIR` points. The Debug menu's `Copy trace.ndjson Path` gives it to you. With the web app, the file is on the machine running the server, not the one running the browser.

`tmuxy trace check` also gives a short health summary (reconnects, rejected commands, errors). From a `Shape` trace it is safe to paste as text.

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

The level applies to the lines written while it is on, so a trace file can hold lines from an earlier, more detailed level. Take the slice after reproducing at `Shape`, never from an old file.

## Checking a slice before you share it

A slice is plain text, one JSON object per line. Read it before attaching it:

```
jq -c '{t: .ts_wall, layer, name, op, session}' tmuxy-trace-slice.ndjson | head -40
```

Then look for anything of yours by name. Every line here should print nothing:

```
grep -i -e "$USER" -e "$(hostname)" tmuxy-trace-slice.ndjson
grep -i -e "my-project" -e "my-company" tmuxy-trace-slice.ndjson
```

Put your own project, client or folder names in the second line. And check the level tracing is at: `trace.json`, beside the trace, says `"level": Shape`.

If any of them prints something, do not attach the slice: delete it, switch the Debug menu to `Shape`, reproduce, and take a new one. If you are unsure, describe the problem without a trace. We will ask for what we need.

To stop tracing afterwards: the Debug menu's switch, or `DO_NOT_TRACK=1` / `TMUXY_NO_TRACE=1`, which force it off everywhere.

## Logs and the browser console

- **Web app:** the browser's developer tools (`F12`, or right-click and `Inspect`), the `Console` tab. Copy any red error and its stack.
- **`tmuxy server`:** what it prints to its terminal, or your process manager's log. `RUST_LOG=debug` makes it more detailed.
- **Desktop app:** `tmuxy.log` in the same state directory as the trace. The desktop app has no developer tools in a release build.

Logs can quote a command line or a folder name. Read them as you read a slice, and cut what you would not post.

## Security issues

A security problem does not go in a public issue. The [security policy](../SECURITY.md) says how to report one privately; [docs/SECURITY.md](SECURITY.md) describes the risks tmuxy guards against.
