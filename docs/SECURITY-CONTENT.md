# Security: Untrusted Content and Recorded State

The browser pane, session snapshots and hostile pane output. Part of [SECURITY.md](SECURITY.md).

## A Real Browser Driven From a Pane Changes Whose Network This Is

The browser widget frames LOCAL pages in the VIEWER's browser, so a file it
opens has the viewer's cookies, and tmuxy never sees them. A website does not
go there: `tmuxy open <website>` (and an address typed into the widget's bar)
hands the pane to `tmuxy browser`, which inverts all of that, and none of the
reasoning above carries over.

**It runs as whoever typed the command, not as the server.** This is the single
most important property, and it was not always true. The engine used to live in
the tmuxy server, driven by a client command and streamed back over an HTTP
route — which put the server's own network and the server's own uid behind a URL
a viewer could choose, and made "may a read-only viewer drive a browser?" a
question the code had to answer (SEC-11). Now the engine is launched by a
program in a pane, so it has exactly the powers of the person at that terminal.
There is no route, no client command, no read-only exemption to maintain, and
nothing a viewer can name. A viewer who can send keys to a pane can already run
any command; this is one of them. A read-only viewer sees the page as pane
output — one picture, fetched once by the session's own engine — and its
address bar is inert, since it would drive the pane by typing into it.

**The network position is still not the viewer's.** `goto http://10.0.0.5/admin`
from a pane on a machine reached over a tunnel is a request from inside THAT
machine's network — a database admin page, a metadata endpoint at
`169.254.169.254`, a service bound to loopback. That is true of `curl` in the
same pane, which is the point: the power comes from being able to run commands
there, not from this feature. What changed is only that it is no longer also
reachable by anything that can speak to the server.

**CDP is an unauthenticated full-control API, and the transport is now a
loopback port.** Anything that can speak to the engine's debugging endpoint can
read every cookie in the profile, run script in any page, and navigate to
`file://` URLs — i.e. read the disk. The engine is launched on `127.0.0.1` with
a **kernel-assigned** port, never `0.0.0.0` and never a fixed `9222` — the
number every scanner and every other automation tool on the machine already
tries, and the one that would let two tools collide into each other's browser.

This is weaker than what came before, and the trade is deliberate rather than
unnoticed. The previous engine used `--remote-debugging-pipe`, which speaks over
inherited file descriptors and opens no socket at all; a random loopback port
is reachable by any process on the machine that enumerates ports, which is a
lower bar than inheriting an fd. What it buys is the whole implementation: the
pipe transport was tmuxy's own code — the framing, the reply correlation, the fd
placement Chromium numbers from the child's point of view — and it is now
chromiumoxide's, which does not offer the pipe. On a single-user machine the
distinction is small; on a shared one it is real, and a session whose profile
holds logins (`--attach`, below) is where it starts to matter.

**The profile is a credential store on disk.** A launched session gets a
throwaway `--user-data-dir` of its own, removed when the session ends — waited
for, not just asked: Chromium flushes its profile on the way out, so a directory
removed before the process is gone is simply recreated. Nothing is retained and
no login survives.

`--attach` is the exception, and it is opt-in by its nature: it drives a browser
somebody else started, which may be the user's REAL profile with its logins.
Chrome will only expose that after an explicit consent prompt at
`chrome://inspect/#remote-debugging`, so the decision is the user's and is made
in their own browser rather than here. An attached browser is left running and
its profile untouched when the pane closes — tmuxy does not clean up something
it did not create.

**The engine is the user's, not tmuxy's.** tmuxy ships no browser; it finds one
(`TMUXY_CHROME`, then the platform's usual paths) and refuses the command when
there is none. That means the engine is patched on the user's own schedule
rather than pinned to a tmuxy release — the right side of that trade for a
component with a browser's attack surface — and it means a machine without one
simply does not have the feature.

**The page is a picture written to a pty.** Each frame is an inline image
(`OSC 1337`) emitted by the pane program, which is to say it is pane output and
is governed by everything in "Pane Output Threat Model" below — nothing new, and
no route of its own. A read-only viewer sees the picture because they can see
the pane, the same way they can see any other command's output.

**Input is a pty, not a protocol.** The pane program reads keystrokes and SGR
mouse reports off its own terminal and turns them into CDP `Input.*` calls
itself. The old shape had a client naming a CDP method, which needed an
allowlist to stop it being a general door into CDP; nothing names a method any
more, so there is nothing to allow or refuse. The tmux prefix never reaches the
page either, and for the plainest possible reason: tmux takes it first, as it
does for every program in a pane.

**What a page cannot reach.** The engine runs headless with a profile of its
own, no extensions and no access to the tmuxy API: a separate process whose only
channel is CDP, with the pane program holding the other end. A page cannot send
a tmux command, because nothing connects a page to `/commands` — unlike the
framed local-file case above, where the page and the app shared an origin until
the sandbox separated them.

## A Session Snapshot Is a Record of the Machine

`tmuxy_core::session_snapshot` writes, on every change to a session's shape,
what it would take to rebuild it: every pane's working directory, the argv of
the program it was running, whatever a program declared through
`@tmuxy-pane-restore`, and — only when asked with `--scrollback` — the text on
its screen. That is a map of what the user was doing, kept on disk.

Where it is kept follows from that. Snapshots live under the state directory
(`TMUXY_STATE_DIR`, else the XDG state dir), one directory per tmux socket
(`sessions/<socket>/`, since a `tmuxy` session on `tmuxy-dev` is not the one
on `tmuxy`), next to the trace and the browser profiles — deliberately nowhere `/api/browse` can reach — and
no route serves them. The commands that touch them (`list_snapshots`,
`restore_session`) are **write** commands: a `--read-only`
server does not answer them, for the same reason it does not serve the file
routes (SEC-11) — a viewer is shown one session's screen, not the directories
and commands of every pane on the machine.

A restore runs what a snapshot says only in the sense that each pane OFFERS
its shell line, never runs it, unless `--run` is given: the line is hung on the
pane as an `@tmuxy-ask` question of kind `offer`, shown as a one-line banner,
and runs only when the user presses Enter on it or clicks it. Nothing is typed
into the shell, so nothing reaches it before the user has read it. A program that
was running when the snapshot was taken is not evidence that it should run
again; `rm -rf …` was also running. The one exception is a window tmuxy draws
as its own chrome: a sidebar comes back running its widget (`tmuxy widget
tree`), because that is tmuxy's program, not the user's, and what `ps` finds
in such a window (the helper the widget sleeps in) is never recorded. A word a
program declared through `@tmuxy-pane-restore` is written back onto the
restored pane as well as offered, and an offer nobody has answered is saved
with the pane, so the next restore offers it again rather than losing it. What `ps` finds is also held to an age: a
foreground program younger than two seconds is a prompt's helper (`git
status`, `id -Gn`) as often as a program the user just started, so it is left
out and the keeper looks again once that age has passed. While a restore is rebuilding a session the autosave is held, and a shutdown in that window skips its last save: half a session must never become the latest snapshot. Snapshot files are
read with the same suspicion as anything on disk: a file that does not parse,
or claims a newer format, is logged and ignored, and the session starts fresh
— it can never stop the server from starting.

## Pane Output Threat Model

Bytes emitted by any command running in a pane reach parsers, image decoders, and link handlers in a browser or webview context. Unlike commands entered by the user, terminal output is frequently untrusted: displaying a file (`cat untrusted.txt`), running a test suite, fetching logs, or inspecting untrusted git repositories can output arbitrary byte streams to stdout or stderr.

### The Pipeline

```
+----------------+      +-------------+      +----------------+      +-----------------+
| Program in | ---> | tmux Server | ---> | tmuxy Server | ---> | Frontend Web/ |
| Pane (stdout) |  | (%output) |  | (core stream) |  | Desktop Webview |
+----------------+      +-------------+      +----------------+      +-----------------+
  Untrusted bytes        Control mode         Deltas / SSE           Parsers, decoders,
                                                                     DOM & Canvas render
```

### Trust Boundaries

| Component | Trust Level | Rationale |
| --- | --- | --- |
| The host machine & tmux server | Trusted | Runs with the authenticated user's permissions |
| The tmuxy backend server | Trusted | Local process mediating control-mode and state |
| Pane output byte streams | **Untrusted** | Any program or untrusted input file can write arbitrary escape sequences or payload bytes |
| Browser / Webview environment | Semi-trusted context | Has access to DOM, clipboard APIs, web workers, and backend API routes |

### Threat Vectors

1. **DOM Injection & Cross-Site Scripting (XSS)**
   - _Vector:_ Escape sequences or text runs attempting to inject HTML/SVG tags or execute script via DOM rendering.
   - _Policy:_ Terminal text must render as plain text nodes or canvas ink, never via unescaped `innerHTML`. Dynamic titles, tab labels, and pane annotations originating from terminal output must be escaped or treated as text content.

2. **Unsafe Hyperlinks (OSC 8 & Linkifiers)**
   - _Vector:_ Explicit OSC 8 hyperlinks (`\e]8;;<URL>\e\\`) or implicit URL regex linkifiers matching dangerous schemes (e.g. `javascript:`, `data:`, `file:`, `blob:`).
   - _Policy:_ URLs must pass an explicit allowlist of safe schemes (`http:`, `https:`, `mailto:`, `git:`). Any URL using a prohibited or unknown scheme must either be stripped or rendered as plain, unclickable text. Clicks must open in a new context with `rel="noopener noreferrer"`. The URL is also pane output as far as memory goes: one longer than `MAX_HYPERLINK_URL_BYTES` opens no link, and the cells one OSC 8 pair covers share a single copy of it (`control_mode/osc.rs`) rather than each holding its own.

3. **Image Decoder Exploits & Memory Exhaustion**
   - _Vector:_ Protocols supporting embedded graphics (OSC 1337 iTerm2 images, Kitty graphics protocol, Sixel) transmitting malformed base64 payloads, decompression bombs, or extreme dimensions (e.g. 65535x65535 canvas).
   - _Policy:_ Image dimensions and payload byte sizes must be strictly bounded before memory allocation or canvas creation (see [RICH-RENDERING.md](RICH-RENDERING.md)). Image decoding must occur in isolated sandboxes or off-thread decoders, and invalid image headers must fail fast without consuming excessive CPU or memory. A chunked Kitty transfer is bounded three ways (`control_mode/images.rs`): how many may be open at once, how large one may grow, and how long one may stay open without finishing — a transfer that stops sending is dropped after `MAX_CHUNKED_AGE` instead of living as long as the pane.

4. **Clipboard Poisoning (OSC 52)**
   - _Vector:_ A program writing malicious shell commands to the system clipboard via OSC 52, tricking the user into pasting and executing dangerous commands.
   - _Policy:_ OSC 52 clipboard writes obey bounds rather than a prompt — a confirmation on every yank would break the legitimate use (nvim or tmux yanking over ssh, which is the reason the sequence is honoured at all) and train the user to click through it. The bounds: only the **active pane** may write, so a tailed log or a stray ssh session cannot replace what the user is about to paste; the decoded payload is capped (`MAX_CLIPBOARD_BYTES`); one write per pane per `MIN_CLIPBOARD_INTERVAL`, so a program writing in a loop cannot keep the clipboard from the user; and every accepted write announces itself on the status line, naming the pane and the size, so a clipboard the user did not set is never silent. tmux paste buffers, which are global to the tmux server, are mirrored only when a pane of _this_ session is in copy mode, and never on a `--read-only` server — and tmux's own OSC 52 handling is turned off on the session (`set-clipboard off`, enforced with the other settings in `control_mode/monitor.rs`), so a pane's write cannot reach the buffer mirror and arrive past the active-pane gate that way. A plain `tmux attach` to the tmuxy socket therefore does not get OSC 52 to its own terminal; tmuxy's clients do, through tmuxy. The server or client must never allow unauthorized background clipboard reads.

5. **ReDoS & Parser Desynchronization**
   - _Vector:_ Pathological escape sequences designed to trigger exponential regex backtracking in parsers or desynchronize the terminal state machine.
   - _Policy:_ All sequence parsers and URL detectors must guarantee linear-time parsing. Malformed or truncated sequences must be discarded cleanly without locking the main rendering thread.

### What Fuzz Tests Must Guarantee

Automated fuzzing over terminal parsers and sequence handlers must verify:

- **No Panics or Unhandled Exceptions:** The Rust aggregator (`tmuxy-core`) and frontend terminal stream consumers must never panic, throw unhandled exceptions, or crash when fed completely random or adversarial byte streams.
- **Strict Scheme Filtering:** Fuzzing URI inputs against OSC 8 handlers and regex linkifiers must never emit an `<a>` tag with an href containing `javascript:`, `vbscript:`, or unvetted pseudo-protocols.
- **Bounded Resource Consumption:** Feeding arbitrarily large or invalid base64 image chunks must terminate within bounded memory and time budgets.
- **Parser Resynchronization:** An incomplete, nested, or corrupt escape sequence must not corrupt subsequent valid output lines or state updates.
