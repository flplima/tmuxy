# Security: Untrusted Content and Recorded State

Previewed files, session snapshots and hostile pane output. Part of [SECURITY.md](SECURITY.md).

## A Preview Reads One File

`tmuxy open <file>` shows a local markdown document or HTML page in a pane (the `preview` widget, see [ARCHITECTURE-WIDGETS.md](ARCHITECTURE-WIDGETS.md)). A file is the least trusted thing tmuxy draws: a page downloaded from anywhere, a README from a cloned repository, a report a tool wrote from data it did not check. The design assumes the document is hostile and keeps two questions apart — what it may **read**, and what it may **do**.

**What may be read is decided by tmux, not by the client or the document.** The UI reads the file through a client command, `read_preview`, naming only the pane; the path is the pane's `@tmuxy-pane-preview`, honoured only while `@tmuxy-pane-widget` is `preview`. `tmuxy-widget-preview` writes both out of band through `run-shell` and the widget clears its tag on exit, so neither pane output nor a client can point a preview at another file, and a pane that has gone back to being a shell reads nothing. Both transports call the same check (`tmuxy_core::preview`), on every read. This replaced a file route that read any path the server process could; nothing serves an arbitrary path any more.

**A document's own references are held to its folder.** A resource the document links — a stylesheet, a script, an image, a font — is read only when its path, relative to the document, stays inside the document's folder once symlinks are resolved, passes through no hidden name (`.ssh`, `.env`, `.git`, `..`), and is a type a page loads (`RESOURCE_EXTENSIONS`). A hostile page in `~/Downloads` cannot name `../.aws/credentials` as a stylesheet, nor `notes.txt` beside it. Every read is a regular file under a size cap (8 MiB a document, 16 MiB a resource), done off the async workers. The client applies the same rules before it asks (`domain/preview.ts`) so that what the server would refuse costs no round trip, but the server's check is the one that holds.

**What a document may do depends on what it is.**

- **Markdown is rendered by the app**, in the app's own origin, so nothing in it may execute: raw HTML in the document is not rendered at all, a link opens in the system browser only when it is `http(s)` or `mailto` and never navigates the app, and a remote image is not loaded unless the preview was opened with `--net`, since loading it tells its host the document was read — and then without a referrer. A ```mermaid fence becomes an SVG on this side of the boundary, where anything that executes can drive the API.
  - **Mermaid never draws in the app's document.** It lays a diagram out by drawing it into a live document and measuring it, and only then returns the SVG, so whatever a label holds is in that document before anything downstream sees it. It runs in sandbox mode and draws into a frame of the app's origin that `widgets/preview/drawMermaid.ts` sandboxes before the frame's document exists (`allow-same-origin` only: mermaid can reach in to measure, nothing in it can run) and gives a policy that fetches nothing but `data:` pictures (and the web's with `--net`). Mermaid's own sandbox frame is not enough on its own: it gets its `sandbox` attribute only after insertion, which leaves its document an ordinary, scriptable one of the app's origin. A `$$…$$` formula is drawn as its text, because mermaid measures a formula, with the rest of its line, in the app's document. Mermaid still sanitizes each label it draws.
  - **What comes back is sanitized at the sink** (`widgets/preview/sanitizeSvg.ts`), by allowlist: parsed in an inert document; out of a label only the SVG elements a diagram is drawn with, in a label only HTML text formatting, and `<title>`/`<desc>` as their text alone (the HTML parser builds HTML inside them, as it does in a label); every `on*` attribute and every attribute that sends a request or opens a window (`ping`, `rel`, `target`, …) removed; `<style>` held to rules scoped to the id the block drew the diagram under, never one the markup claims; nothing in CSS or an attribute that fetches (`url(` other than a same-document `url(#…)`, `src(`, `image(`); a link's `href` narrowed to `http(s):` and same-document fragments, an `<image>`'s to `data:image/` (plus `http(s):` with `--net`), anything else to fragments.
  - **The block clips what it draws** (`contain: paint`), so no markup in a diagram can lay itself over the app. A link click, left or middle, opens the system browser and never navigates the app. Mermaid's theme options are locked (`secure`), so a diagram's `%%{init}%%` cannot bring CSS of its own. Two layers, because mermaid has had bypasses before and the blast radius here is a shell.
- **A page runs in a sandboxed frame**, served under a policy of its own (`page_csp`): `sandbox allow-scripts` without `allow-same-origin`, so the page has an opaque origin — no cookies, no storage, no access to the app's DOM or API; it cannot open windows, submit forms, or navigate the app — and, unless the preview was opened with `--net`, nothing may be fetched at all (`connect-src 'none'`, images and fonts from `data:` only). The resources beside it are inlined into the page by the client, through `read_preview` under the rules above, before it is staged; `<base>` and `<meta http-equiv>` are taken out, so the page can neither re-aim its references nor add a policy that overrules the served one. The page reaches tmuxy's API no more than any other site does: its requests come from an opaque origin, which the [request guard](SECURITY-NETWORK.md#cross-origin-requests) refuses.

  The policy is a response header rather than a `srcdoc`, because a `srcdoc` frame inherits the embedding app's policy — the desktop app forbids inline script, which would stop the page and the bridge alike — and because a meta tag is the document's to precede. So the client stages the composed page (`POST /api/preview/{pane}` on the web, `stage_preview` on the desktop), the server checks with tmux that the pane is previewing a page and takes `--net` from tmux too, never from the client, and the frame loads it from `GET /api/preview/{pane}` or the `tmuxypreview:` scheme with the policy as a header. Both routes exist only on a writable server.

**The page talks to the app through one narrow bridge** (`widgets/preview/previewBridge.ts`): a script put first in the page posts where it is scrolled to (so a reload after the file changes opens in the same place), its `<title>`, a link the user followed (opened in the system browser when it is `http(s)` and leaves tmuxy), and a Ctrl or Alt chord pressed in the page — without which Ctrl+C would never reach the widget and the prefix never reach the app. Anything can post a message, so the app accepts one only from its own frame, in one of those four shapes, and replays a chord only while that frame holds the keyboard; it then moves the keyboard to the pane, so a page cannot follow one replayed chord with another, and a plain key is never replayed at all. Ctrl/Cmd+Enter is never replayed either, and the app answers waiting `pane send` questions with it only from a trusted (user-made) key event. The worst a hostile page can do through it is press one Ctrl or Alt chord each time the user clicks into it. An inlined stylesheet cannot close its `<style>` (`</style` is escaped as CSS), so a local `.css` file cannot add markup after the page's `<base>` and `<meta http-equiv>` were removed.

**What a preview does not protect.** A document opened with `--net` can tell a remote host anything it can read — which, by the rules above, is its own folder's pages, styles, scripts and pictures. A page's scripts run, in an opaque origin, which is what local reports and charts need. And a preview shows the user what the file says: a convincing fake prompt drawn by a page is a page, in a pane whose header names the file.

## A Session Snapshot Is a Record of the Machine

`tmuxy_core::session_snapshot` writes, on every change to a session's shape,
what it would take to rebuild it: every pane's working directory, the argv of
the program it was running, whatever a program declared through
`@tmuxy-pane-restore`, and — only when asked with `--scrollback` — the text on
its screen. That is a map of what the user was doing, kept on disk.

Where it is kept follows from that. Snapshots live under the state directory
(`TMUXY_STATE_DIR`, else the XDG state dir), one directory per tmux socket
(`sessions/<socket>/`, since a `tmuxy` session on `tmuxy-dev` is not the one
on `tmuxy`), next to the trace, and no route serves them. The directory is
`0700` and every snapshot `0600` (`tmuxy_core::private_files`), as are the
trace, the desktop log and the app's managed state, whatever the umask. The commands that
touch them are `list_snapshots` and `restore_session`.

A restore runs what a snapshot says only in the sense that each pane OFFERS
its shell line, never runs it, unless `--run` is given: the line is hung on the
pane as an `@tmuxy-ask` question of kind `offer`, shown as a one-line banner,
and runs only when the user presses Enter on it or clicks it. Nothing is typed
into the shell, so nothing reaches it before the user has read it. A program that
was running when the snapshot was taken is not evidence that it should run
again; `rm -rf …` was also running. The one exception is tmuxy's own chrome:
the left sidebar comes back running its widget (`tmuxy widget tree`), and only
that exact command, because that is tmuxy's program, not the user's; anything
else a snapshot names for a sidebar is offered like any other command. A
restore puts back only the options capture writes (the float and sidebar
`@tmuxy-*` window options, a pane's group id and place), never another option
a hand-edited file names, and a pane's scrollback reaches `run-shell` with its
`#` doubled, so no `#(…)` in it runs. `tmuxy session restore --run` needs a
terminal; a script or an agent gets every command offered. What `ps` finds in
a sidebar (the helper the widget sleeps in) is never recorded. A word a
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
   - _Policy:_ Image dimensions and payload byte sizes must be strictly bounded before memory allocation or canvas creation (see [RICH-RENDERING.md](RICH-RENDERING.md)). Image decoding must occur in isolated sandboxes or off-thread decoders, and invalid image headers must fail fast without consuming excessive CPU or memory. A Sixel image's canvas is bounded before it is decoded, from the raster attributes it declares and the columns and bands it draws (`sixel_extent`), to the same `MAX_DECODED_IMAGE_BYTES` as a Kitty or iTerm2 image. An escape split across many `%output` chunks is buffered without its earlier chunks being scanned again, and a run of unterminated escapes in one chunk is scanned once, so neither turns into quadratic work. A chunked Kitty transfer is bounded three ways (`control_mode/images.rs`): how many may be open at once, how large one may grow, and how long one may stay open without finishing — a transfer that stops sending is dropped after `MAX_CHUNKED_AGE` instead of living as long as the pane.

4. **Clipboard Poisoning (OSC 52)**
   - _Vector:_ A program writing malicious shell commands to the system clipboard via OSC 52, tricking the user into pasting and executing dangerous commands.
   - _Policy:_ OSC 52 clipboard writes obey bounds rather than a prompt — a confirmation on every yank would break the legitimate use (nvim or tmux yanking over ssh, which is the reason the sequence is honoured at all) and train the user to click through it. The bounds: only the **active pane** may write, so a tailed log or a stray ssh session cannot replace what the user is about to paste; the decoded payload is capped (`MAX_CLIPBOARD_BYTES`, applied by the aggregator to a mirrored paste buffer too, so the in-browser engine gets it as well as the server and the desktop); one write per pane per `MIN_CLIPBOARD_INTERVAL`, so a program writing in a loop cannot keep the clipboard from the user; and every accepted write announces itself on the status line, naming the pane and the size, so a clipboard the user did not set is never silent. tmux paste buffers, which are global to the tmux server, are mirrored only when a pane of _this_ session is in copy mode — and tmux's own OSC 52 handling is turned off on the session (`set-clipboard off`, enforced with the other settings in `control_mode/monitor.rs`), so a pane's write cannot reach the buffer mirror and arrive past the active-pane gate that way. A plain `tmux attach` to the tmuxy socket therefore does not get OSC 52 to its own terminal; tmuxy's clients do, through tmuxy. The server or client must never allow unauthorized background clipboard reads.

5. **ReDoS & Parser Desynchronization**
   - _Vector:_ Pathological escape sequences designed to trigger exponential regex backtracking in parsers or desynchronize the terminal state machine.
   - _Policy:_ All sequence parsers and URL detectors must guarantee linear-time parsing. Malformed or truncated sequences must be discarded cleanly without locking the main rendering thread.

### What Fuzz Tests Must Guarantee

Automated fuzzing over terminal parsers and sequence handlers must verify:

- **No Panics or Unhandled Exceptions:** The Rust aggregator (`tmuxy-core`) and frontend terminal stream consumers must never panic, throw unhandled exceptions, or crash when fed completely random or adversarial byte streams.
- **Strict Scheme Filtering:** Fuzzing URI inputs against OSC 8 handlers and regex linkifiers must never emit an `<a>` tag with an href containing `javascript:`, `vbscript:`, or unvetted pseudo-protocols.
- **Bounded Resource Consumption:** Feeding arbitrarily large or invalid base64 image chunks must terminate within bounded memory and time budgets.
- **Parser Resynchronization:** An incomplete, nested, or corrupt escape sequence must not corrupt subsequent valid output lines or state updates.
