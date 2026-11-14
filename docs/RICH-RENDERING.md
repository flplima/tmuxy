# Rich Terminal Rendering

Tmuxy intercepts terminal escape sequences that would otherwise be passed through to (or dropped by) tmux and renders them as real DOM elements. The browser shows actual `<a>` for hyperlinks, `<img>` for inline images, and clipboard requests round-trip through `navigator.clipboard`.

This document covers what's supported, how the pipeline works, and how to test each protocol.

## Supported protocols

| Protocol | DCS / OSC / APC | Backend | Frontend | Notes |
| --- | --- | --- | --- | --- |
| **OSC 8 — Hyperlinks** | `ESC ] 8 ; … ; <url> ST` | `packages/vt100` (link on the cell) → `extract_cells_from_screen` (`CellStyle.url`) | `TerminalLine.tsx` → `<a href>` | Parsed from the control-mode stream; no `terminal-features` setting needed. Clicks open through `infra/openUrl.ts`, not the anchor's own navigation: `window.open` on the web, the `open_url` Tauri command (system browser, http(s)/mailto only) on the desktop, whose webview denies new windows. Auto-detected URLs (`components/terminal/urlDetect.ts`) use the same path and are live only while the platform link modifier is held |
| **OSC 1337 — iTerm2 Inline Images** | `ESC ] 1337 ; File=… : <base64> BEL` | `control_mode/images.rs::try_parse_iterm2` | `Terminal.tsx` → `<img src="/api/images/…">` | Base64 of any browser-renderable format |
| **APC \_G — Kitty Graphics** | `ESC _ G <keys> ; <payload> ESC \` | `control_mode/images.rs::try_parse_kitty` | same | Supports chunked transfers whose final packet sets `m=0` or omits `m`, formats `f=24`/`f=32`/`f=100` (the bytes of an `f=100` image are kept as they came and typed by their signature, so a GIF sent that way animates — what the demo's nyan cat does, `packages/tmuxy-demo/public/guest/icat`), ZLIB compression (`o=z`), and Unicode placeholders (`U=1`) used by Kitty's tmux passthrough mode |
| **DCS Pq — Sixel** | `ESC P q … ESC \` | `control_mode/images.rs::try_parse_sixel` | same | Decoded by `icy_sixel`, re-encoded as PNG before serving. Only a DCS whose bytes before `q` are digits and `;` is Sixel: other DCS strings holding a `q`, such as nvim's XTGETTCAP query (`ESC P + q`), are not pictures |
| **OSC 52 — Clipboard** | `ESC ] 52 ; c ; <base64> ST` | `packages/vt100` → `control_mode/osc.rs` (`OscRequests`, its callbacks) → `StateEmitter::write_clipboard` → the `clipboard` host event (an SSE frame on the web, a Tauri event on the desktop) | the transport's `Clipboard` event → `TMUX_CLIPBOARD` event → `navigator.clipboard.writeText` in appMachine | Outbound only — pasting back is not implemented. The status line says `Copied…` once the browser has taken the write, and says it could not when the browser refused: Firefox and Safari take a clipboard write only while a key press or a click is fresh, so a sequence that arrives on its own is turned down there (`infra/clipboard.ts`). What is dropped: vt100 forwards the sequence only when every payload byte is in `A-Za-z0-9+/=` (`packages/vt100/src/perform.rs`); core refuses raw base64 over 2 MiB (`MAX_CLIPBOARD_BASE64_BYTES`) and a payload that does not decode to UTF-8 (`control_mode/osc.rs`); the aggregator's active-pane, size and rate bounds are in [SECURITY-CONTENT.md](SECURITY-CONTENT.md#pane-output-threat-model). Covered end to end by `tests/3-rendering-protocols.test.js` Scenario 14, which reads the clipboard write. |
| **DEC Line Sizes — DECDHL / DECDWL** | `ESC # 3`, `ESC # 4`, `ESC # 5`, `ESC # 6` | `packages/vt100` (`LineSize` per row) + `extract_cells_from_screen` (`CellStyle.size`) | `components/terminal/cellPaint.ts` (both renderers) → `.terminal-scaled` (`dwl`, `dhl-top`, `dhl-bottom`) | `ESC # 3`/`# 4` render top/bottom halves of 2×2 double-height lines; `ESC # 6` renders 2×1 double-width; `ESC # 5` resets to single width. Preserved across `capture-pane` refreshes while the row's text matches |
| **OSC 66 — Kitty Text Sizing** | `ESC ] 66 ; s=<n>:w=<n> ; <text> ST` | `packages/vt100` (`TextSize` on the cell) + `extract_cells_from_screen` | same | `s=2` emits `dhl-top` on row `r` and mirrors `dhl-bottom` onto the blank cell below it on row `r+1`; `w=2` (`s=1:w=2`) emits `dwl`. Preserved across `capture-pane` refreshes while the cell's character matches |
| **OSC 7501: Program Status** | `ESC ] 7501 ; state=… : … ST` | `packages/vt100` → `control_mode/osc.rs` → `control_mode/program_status.rs` → `@tmuxy-pane-state` and `@tmuxy-pane-status`, written through control mode | the pane-state mark in the tree, the tab and the pane header | See [Program status](#program-status-osc-7501) |

**A link is an attribute of the cell its text was written to.** The vendored
vt100 (`packages/vt100`, see `packages/vt100/PATCHES.md`) reads OSC 8 itself and writes
each character under the link that was open, the way it writes colours, so a
link moves, reflows, scrolls and is overwritten with its text: an application
that repaints in place (Claude Code, vim, htop) leaves no link on the text it
redrew, and an erase paints none. The URLs live in a per-screen table that,
as tmux's does, forgets the oldest past 5000 links (or 1 MiB of URLs), so a
cell under a forgotten link reads as plain text. A colour reset (`SGR 0`)
does not close a link. A capture refresh, which follows every resize, reads
the capture through the same terminal, and `capture-pane -e` writes the
screen's OSC 8 links (tmux 3.4 and later), so a link survives the refill even
when its program drew it before the resize landed and never draws it again; a
link the capture leaves open is closed at its end, so it does not run on into
later output. tmux keeps no links in the history a reload pulls in, so a link
is not restored by reloading the page. The link lives on the cell rather than
in a separate map of cells to URLs because such a map has to follow every
scroll and check the text under each mark, and drifts.

**Auto-detected URLs stop where a URL must.** `components/terminal/urlDetect.ts` matches the
characters RFC 3986 allows in a URI, plus Unicode letters, digits and marks for
internationalised addresses. It is an allowlist on purpose: terminal UIs butt
their text against separators with no space in between, and a class defined by
what it excluded swallowed all of them — `…/bar│Files:12│Status:ok` came back
as one link covering most of the line. Detection runs over a _logical_ line:
rows that only soft-wrapped (the same full-width rule the copy path uses,
`isWrappedRow`) are joined first, so a URL longer than the pane is one link on
every row it covers, each opening the whole address. OSC 8 links already arrive
whole on every row from the server. Either kind is one `<a>` per row, so
hovering any row marks every anchor with the same target (`components/terminal/linkHover.ts`).

The images are parsed in `tmuxy-core/src/control_mode/images.rs`, the other sequences by the vendored vt100, whose title and clipboard callbacks are `tmuxy-core/src/control_mode/osc.rs`; the clipboard write reaches `navigator.clipboard.writeText` through the host's `clipboard` event and the `TMUX_CLIPBOARD` machine event. On the frontend, `components/terminal/Terminal.tsx` renders image placements and `components/terminal/TerminalLine.tsx` renders hyperlink cells.

## How tmux preserves the sequences

Tmuxy speaks **tmux control mode** (`-CC`), and tmux forwards every escape sequence the running application emits inside `%output` events on stdout. That includes passthrough payloads. The Rust parser sits on top of the control-mode byte stream and never needs to touch the pty directly.

Two tmux options matter:

- `allow-passthrough on` — required so tmux doesn't refuse to relay the sequences. It is a window option, and the setup pass sets it on each window when the window is first listed (`set-option -wq -t <id> allow-passthrough on`, `window_setup_commands` in `tmuxy-core/src/control_mode/state/window_state.rs`; `-q` so a tmux 3.2, which has no such option, stays silent). What that opens up, and how the payloads are then bounded, is in [SECURITY.md](SECURITY.md#upstream-tmux-hardening-recommendations).
- `default-terminal "tmux-256color"` — a terminfo entry without image capabilities, so tmux does not act on the sequences itself. `packages/tmuxy-core/assets/tmuxy.essentials.conf` sets it (see [TMUX-CONFIG.md](TMUX-CONFIG.md)).

The parser is permissive about line wrapping and stray printable bytes between chunked Kitty packets, since tmux re-flows output around its own column wrapping.

An application inside tmux wraps these escapes in **DCS passthrough** (`ESC P tmux; <payload, every ESC doubled> ESC \`), which is how they reach a terminal sitting behind tmux at all. tmuxy is not behind tmux — it reads the pane stream over control mode — so the wrapper arrives here intact and the parser undoes it before anything else (`unwrap_passthrough`). Sending the escapes bare works too, but wrapping is better even here: tmux reads a lone APC string as a **pane title** (`input_exit_apc`), so an unwrapped Kitty frame turns the pane's title into base64 while it draws.

A program can draw a moving picture this way: move the cursor to the picture's corner and emit one `OSC 1337` image per frame, with `preserveAspectRatio=0` when the picture should fill its cells exactly (so a clicked cell maps straight to one of its pixels). The same-anchor replacement below gives flicker-free frames, and the per-pane store cap (`MAX_PANE_IMAGE_BYTES` in `tmuxy-core/src/host/bindings.rs`) is what keeps a pane that publishes a picture several times a second from growing without limit.

A picture is retired in one of four ways. A screen clear takes it away: `ESC [ 2 J`, or `ESC [ J` straight after the cursor goes home (how `clear` and curses applications empty the screen), and a full reset (`ESC c`). A screen switch sets it aside: entering the alternate screen (`?1049` / `?1047` / `?47`) hides the main screen's pictures, anything drawn there is dropped on leaving, and the main screen's come back — a placement is anchored to cells rather than drawn into them, so vt100 clearing its grid never touched it, and an image outlived the command or the editor that showed it. Kitty's `a=d` deletes placements (the default `d=a` and `d=A` selectors, which mean "all of them"; the narrower ones address images by a kitty id tmuxy does not keep, so they are left alone). And a new placement anchored at the same cell **replaces** the one already there, so a preview that homes the cursor and repaints keeps exactly one frame on screen without stacking — and without the gap that deleting first would leave while the next frame crosses control mode. The frontend keys each `<img>` by that anchor rather than by the placement id, so a repaint reuses the element: the browser holds the previous picture until the new bytes have decoded, where building a fresh element painted nothing until they arrived and the preview blinked once a second.

## Where the bytes come from

The decoder hands the host two things: a placement (where on the grid, how big) and the picture's bytes. Placements travel with the pane state; the bytes do not, so each host serves them itself and the frontend asks for whichever URL that host understands.

| Host | Serves the bytes as | Registered in |
| --- | --- | --- |
| Web server | `/api/images/<pane>/<id>` | `tmuxy-server/src/state.rs` |
| Desktop app | `tmuxyimg://localhost/<pane>/<id>` | `tmuxy-tauri-app/src/gui.rs` |
| Storybook, tests | whatever `window.__tmuxyImageSrc` returns | the story or test |

A host that keeps no bytes renders no pictures, whatever the decoder did with them: `StateEmitter::store_images` defaults to discarding, so a host must both keep the bytes and serve the URL its frontend asks for. Neither URL is cached — placement ids restart with the process, so a cached response is the previous run's picture.

## End-to-end pipeline

```
running app
   │ writes escape bytes
   ▼
tmux (-CC, passthrough)
   │ wraps as %output %<pane> <bytes>
   ▼
tmuxy-core / control_mode/parser.rs
   │ %output's payload, octal-unescaped, to the pane's
   ▼
control_mode/state/pane_output.rs::process_output
   │ hands the bytes to
   ▼
control_mode/images.rs::ImageParser::process_with
   │ ─► strips the image sequences, decodes the pictures
   │ ─► clean_bytes go to vt100 (the pane's grid), with the
   │    placements shifted by any scroll those bytes cause
   │ ─► returns new_images: [(id, StoredImage)…] for the host to store
   ▼
ServerPane.images  (snake_case, serialized over SSE)
   │
   ▼
domain/store/snapshot.ts::transformServerState → domain/client.ts::toClientState
   │
   ▼
TmuxPane.images : ImagePlacement[]
   │
   ▼
TerminalPane.tsx → Terminal.tsx
   │ renders <img class="terminal-image"
   │              src="/api/images/<paneNum>/<imageId>"
   │              data-protocol="iterm2|kitty|sixel"
   │              style="top: …; left: …; width: …; height: …" />
   ▼
GET /api/images/{pane_id}/{image_id}
   │ served by tmuxy-server (see api_routes in state.rs)
   ▼
stored bytes (already in the format the browser expects: PNG/JPEG/WebP)
```

`ImageParser` keeps the raw bytes per `(pane_id, image_id)` so that re-renders, viewport changes, and reconnects all read the same content. Sixel input is converted to PNG once at parse time so the server doesn't repeat the decode on every fetch.

## Placement geometry

Each `ImagePlacement` carries:

- `id` — monotonic per-pane image counter, matches the URL path
- `row`, `col` — top-left cell coordinates (`row` is signed `i32`: `0..height-1` on the live viewport, negative when scrolled into scrollback history)
- `width_cells`, `height_cells` — bounding box in terminal cells
- `protocol` — one of `iterm2`, `kitty`, `sixel`

The frontend positions the `<img>` absolutely inside `.terminal-images` in cell units — `--cell-w` horizontally, `--line-height-terminal` vertically — so the image stays aligned to the same cell grid as the surrounding text. This is the same grid the rows and the cursor use; see [The cell grid invariant](RICH-RENDERING-CELL-GRID.md). When `width=auto` / `height=auto` is requested, the parser converts pixels to cells using the pane's current cell size estimate.

**Content-tracked scrolling and scroll/copy mode.** `PaneState::sync_image_scroll` reads `vt100::Screen::scroll_delta()` as terminal output is processed and calls `ImageParser::shift_rows_up` / `shift_rows_down` to shift each placement's `row` in lockstep with the surrounding text. Placements that scroll above the live viewport (`row < 0`) are retained until their bottom edge (`row + height_cells`) passes the scrollback limit (`IMAGE_HISTORY_ROWS`), and `ScrollbackTerminal.tsx` renders `.terminal-images` at `top: calc((historySize + row) * var(--line-height-terminal))` so images remain visible when scrolling back in scroll or copy mode. Primary-screen placements also survive pane zoom and resize (`ImageParser::reset_for_resize` only clears placements on the alternate screen, where full-screen apps redraw on `SIGWINCH`).

See [RICH-RENDERING-CELL-GRID.md](RICH-RENDERING-CELL-GRID.md) for this section: The cell grid invariant.

## Program status (OSC 7501)

A program can say what it is doing in its own output, with the [program status protocol](https://www.superlogical.com/rex/docs/build/program-status). No hook and no install: a `printf` is enough.

| Reported state | Pane state |
| --- | --- |
| `working` | `working` |
| `blocked` | `needs-input` |
| `done` | `unread` |
| `error` | `error` |
| `idle` | `idle` |
| `clear` | unset |

The pane keeps one record per `id` and shows the one that wants you most. That state is written to `@tmuxy-pane-state` through control mode, so the tabs, the tree and the push notification read it like a hook's ([TMUX-TAGS.md](TMUX-TAGS.md)). Both options live in tmux, so a host that never saw the report reads them too: the state at once, a change of the text alone at its next listing of the panes.

- A new shell prompt (`OSC 133 ; A`) ends `working` and `blocked`. `done` and `error` stay, and `unread` goes once the pane is in front. A shell that marks no prompts ends nothing: there a program has to report `clear` itself before it exits, on its error paths too.
- The limits are the specification's: 4096 bytes a report, 256 records a pane. A report past one, or with a control character in its text, is dropped whole.
- tmux gets one write per pane every 200 ms at most. A write held back goes out when the 200 ms are over, so the pane ends on the program's last word.
- Reports are read only while a client watches the pane's session, because tmux sends `%output` for the attached session only.
- The shown record goes to `@tmuxy-pane-status` as a report body (`state=blocked:kind=permission:msg=<base64>`), written just before the state. It travels with the pane (`pane_status`) and shows when you point at the mark (`tmuxy-ui/src/domain/paneStatus.ts`). A pane carries it only while its state is still the report's: a hook that moves the state on leaves the old text in tmux, unread.

**What a pane's output can do with this.** A report is pane output, so a file that is `cat`ed or a remote host can send one. It can mark its own pane (`needs-input` included), put one line of its own text in the mark's tooltip, and raise the push notice that state raises. The bounds: the text is one line with no control characters, drawn as text only, 240 characters at most, with invisible and direction-changing characters taken out. Every byte written to tmux comes from the protocol's value set, which has no quote, space or `;`. The two options are rewritten five times a second per pane at most.

**The feature-detection query (`OSC 7501 ; ?`) gets no reply.** A program that asks sends `CSI c` right behind the query, and takes the protocol as unsupported when the `CSI c` reply comes first. tmux answers `CSI c` itself, and a reply from tmuxy would have to go back through tmux, so it would come second. Claude Code 2.1.322 asks this way, so inside tmux it reports nothing: its state still comes from the hooks of `tmuxy agent install`.

## Testing

### Manual

```bash
# OSC 8 hyperlink
printf '\e]8;;https://example.com\e\\Click me\e]8;;\e\\\n'
ls --hyperlink=auto

# iTerm2 inline image (requires `imgcat` from iTerm2 utilities, or any
# tool that emits OSC 1337 File=…)
imgcat path/to/image.png

# Kitty graphics protocol
kitten icat path/to/image.png   # the official client
# or any application using zellij / ranger's kitty image preview

# Sixel
img2sixel path/to/image.png
chafa --format sixel path/to/image.png
```

Inside a real tmuxy session, each of these renders the image inline in the pane.

### Automated

- **Program status**: `tmuxy-core/src/control_mode/program_status/tests.rs` holds the parser, the records and the write to tmux. `tests/21-agent-states.test.js` prints each state in a real pane and checks the mark.
- **Rust unit tests** (`tmuxy-core/src/control_mode/images.rs`) cover the parsers and placement geometry — including chunked Kitty transfers, RGBA-to-PNG conversion, and Sixel decode.
- **E2E** runs a real tmux session, emits each protocol with a shell command, and asserts the `<img>` shows up in the page (see `tests/`).

## Other rich-rendering opportunities

These are documented because they reuse the same passthrough pipeline; whether to implement them is a product decision, not a technical one.

- **OSC 9 / OSC 777 — Desktop notifications**
- **OSC 9;4 — ConEmu progress bars**
- **OSC 133 — FinalTerm semantic zones** (prompt / command / output markers)
- **OSC 7 — Working-directory hints**

## Related

- [TMUX.md](TMUX.md) — control-mode protocol and version quirks
- [DATA-FLOW.md](DATA-FLOW.md) — SSE/HTTP delivery of placements and image bytes
- [NON-GOALS.md](NON-GOALS.md) — what we still deliberately don't render
