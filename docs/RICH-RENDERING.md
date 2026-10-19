# Rich Terminal Rendering

Tmuxy intercepts terminal escape sequences that would otherwise be passed through to (or dropped by) tmux and renders them as real DOM elements. The browser shows actual `<a>` for hyperlinks, `<img>` for inline images, and clipboard requests round-trip through `navigator.clipboard`.

This document covers what's supported, how the pipeline works, and how to test each protocol.

## Supported protocols

| Protocol | DCS / OSC / APC | Backend | Frontend | Notes |
| --- | --- | --- | --- | --- |
| **OSC 8 — Hyperlinks** | `ESC ] 8 ; … ; <url> ST` | `control_mode/osc.rs` (style on cell) | `TerminalLine.tsx` → `<a href>` | Parsed from the control-mode stream; no `terminal-features` setting needed. Clicks open through `utils/openUrl.ts`, not the anchor's own navigation: `window.open` on the web, the `open_url` Tauri command (system browser, http(s)/mailto only) on the desktop, whose webview denies new windows. Auto-detected URLs (`utils/urlDetect.ts`) use the same path and are live only while the platform link modifier is held |
| **OSC 1337 — iTerm2 Inline Images** | `ESC ] 1337 ; File=… : <base64> BEL` | `control_mode/images.rs::try_parse_iterm2` | `Terminal.tsx` → `<img src="/api/images/…">` | Base64 of any browser-renderable format |
| **APC \_G — Kitty Graphics** | `ESC _ G <keys> ; <payload> ESC \` | `control_mode/images.rs::try_parse_kitty` | same | Supports chunked transfer (`m=1`/`m=0`) and formats `f=24`/`f=32`/`f=100` |
| **DCS Pq — Sixel** | `ESC P q … ESC \` | `control_mode/images.rs::try_parse_sixel` | same | Decoded by `icy_sixel`, re-encoded as PNG before serving. Only a DCS whose bytes before `q` are digits and `;` is Sixel: other DCS strings holding a `q`, such as nvim's XTGETTCAP query (`ESC P + q`), are not pictures |
| **OSC 52 — Clipboard** | `ESC ] 52 ; c ; <base64> ST` | `control_mode/osc.rs` parser → `StateEmitter::write_clipboard` → SSE `clipboard` event (web) / `tmux-clipboard` (Tauri) | the transport's `Clipboard` event → `TMUX_CLIPBOARD` event → `navigator.clipboard.writeText` in appMachine | Outbound only — pasting back is not implemented. Storybook coverage: `App/Resilience > ClipboardOSC52`. |

**Where the cell -> URL mapping comes from.** The link is recorded against the
cells vt100 reports as it writes them: `OscParser::process` strips the escapes
and hands back the byte ranges a link was open over, and `PaneState` feeds those
ranges to vt100 one character at a time, marking whatever cell the cursor
actually landed on. The marks then travel with their line, driven by the vt100
screen's own scroll counter. (The parser used to derive coordinates from a
private cursor it advanced on newlines and printable ASCII only — blind to every
CSI cursor move, so the URL drifted onto unrelated text.) Because tmux strips
OSC 8 from `capture-pane` history, the map is cleared on a capture refresh and
repopulates from live output — a link is not restored by reloading the page.

**A mark is only good while its text is.** Each mark also records the character
that was under it, and the map is read back a row at a time
(`OscParser::row_urls`), never by coordinate alone: a run of adjacent cells
sharing one URL was written as one label, so it is validated as one — if any
character under it has changed, the whole run goes. vt100 carries no per-cell
hyperlink attribute, so a cell being overwritten is invisible to a coordinate
map; without the check, an application that repaints in place (Claude Code,
vim, htop) scrolled nothing and cleared nothing, and every frame's text
inherited the last frame's link — a long underline over unrelated text. The
run, not the cell, is the unit, or a redraw that happens to refill a cell with
the same character leaves a stray underline under it.

**Auto-detected URLs stop where a URL must.** `utils/urlDetect.ts` matches the
characters RFC 3986 allows in a URI, plus Unicode letters, digits and marks for
internationalised addresses. It is an allowlist on purpose: terminal UIs butt
their text against separators with no space in between, and a class defined by
what it excluded swallowed all of them — `…/bar│Files:12│Status:ok` came back
as one link covering most of the line. Detection runs over a _logical_ line:
rows that only soft-wrapped (the same full-width rule the copy path uses,
`isWrappedRow`) are joined first, so a URL longer than the pane is one link on
every row it covers, each opening the whole address. OSC 8 links already arrive
whole on every row from the server. Either kind is one `<a>` per row, so
hovering any row marks every anchor with the same target (`utils/linkHover.ts`).

OSC 8 has been supported for a long time. The image protocols landed together with the OSC 52 parser — all parsing lives in `tmuxy-core/src/control_mode/images.rs` and `tmuxy-core/src/control_mode/osc.rs` — but only the SSE `clipboard` event + `TMUX_CLIPBOARD` plumbing finished the round-trip into `navigator.clipboard.writeText`. On the frontend, `Terminal.tsx` renders image placements and `TerminalLine.tsx` renders hyperlink cells.

## How tmux preserves the sequences

Tmuxy speaks **tmux control mode** (`-CC`), and tmux forwards every escape sequence the running application emits inside `%output` events on stdout. That includes passthrough payloads. Earlier versions of this document claimed image escapes were stripped — that was wrong. The Rust parser sits on top of the control-mode byte stream and never needs to touch the pty directly.

Two tmux options matter:

- `set -g allow-passthrough on` — required so tmux doesn't refuse to relay the sequences. The monitor sets this automatically on every session at connect time (see `sync_initial_state` in `tmuxy-core/src/control_mode/monitor.rs`).
- `set -g default-terminal "tmux-256color"` (or another terminfo entry that does **not** include image capabilities) — keeps tmux from trying to act on the sequences itself.

The parser is permissive about line wrapping and stray printable bytes between chunked Kitty packets, since tmux re-flows output around its own column wrapping.

An application inside tmux wraps these escapes in **DCS passthrough** (`ESC P tmux; <payload, every ESC doubled> ESC \`), which is how they reach a terminal sitting behind tmux at all. tmuxy is not behind tmux — it reads the pane stream over control mode — so the wrapper arrives here intact and the parser undoes it before anything else (`unwrap_passthrough`). Sending the escapes bare works too, but wrapping is better even here: tmux reads a lone APC string as a **pane title** (`input_exit_apc`), so an unwrapped Kitty frame turns the pane's title into base64 while it draws.

The biggest consumer of all of this is the browser pane. `tmuxy browser` is an ordinary terminal program that draws a page by moving the cursor to the picture's corner (row 2 — row 1 is left for the app's address bar) and emitting one `OSC 1337` JPEG per frame, with `preserveAspectRatio=0` so the picture fills its cells exactly and a clicked cell maps straight to a page pixel — no route, no widget, no Tauri command, which is exactly why it works the same on the web and on the desktop. Everything the inline-image path already did is what makes that possible: the same-anchor replacement below gives flicker-free frames, and the per-pane store cap (`tmuxy-server/src/sse.rs`) is what keeps a pane that publishes a picture several times a second from growing without limit. The frame budget and the measured bandwidth are in [PERFORMANCE.md](PERFORMANCE.md).

A picture is retired in one of four ways. A screen clear takes it away: `ESC [ 2 J`, or `ESC [ J` straight after the cursor goes home (how `clear` and curses applications empty the screen), and a full reset (`ESC c`). A screen switch sets it aside: entering the alternate screen (`?1049` / `?1047` / `?47`) hides the main screen's pictures, anything drawn there is dropped on leaving, and the main screen's come back — a placement is anchored to cells rather than drawn into them, so vt100 clearing its grid never touched it, and an image outlived the command or the editor that showed it. Kitty's `a=d` deletes placements (the default `d=a` and `d=A` selectors, which mean "all of them"; the narrower ones address images by a kitty id tmuxy does not keep, so they are left alone). And a new placement anchored at the same cell **replaces** the one already there, so a preview that homes the cursor and repaints keeps exactly one frame on screen without stacking — and without the gap that deleting first would leave while the next frame crosses control mode. The frontend keys each `<img>` by that anchor rather than by the placement id, so a repaint reuses the element: the browser holds the previous picture until the new bytes have decoded, where building a fresh element painted nothing until they arrived and the preview blinked once a second.

## Where the bytes come from

The decoder hands the host two things: a placement (where on the grid, how big) and the picture's bytes. Placements travel with the pane state; the bytes do not, so each host serves them itself and the frontend asks for whichever URL that host understands.

| Host | Serves the bytes as | Registered in |
| --- | --- | --- |
| Web server | `/api/images/<pane>/<id>` | `tmuxy-server/src/state.rs` |
| Desktop app | `tmuxyimg://localhost/<pane>/<id>` | `tmuxy-tauri-app/src/gui.rs` |
| Storybook, tests | whatever `window.__tmuxyImageSrc` returns | the story or test |

A host that keeps no bytes renders no pictures, whatever the decoder did with them: `StateEmitter::store_images` defaults to discarding, and the desktop app took that default for a long time while its frontend asked for the web server's route, so every image protocol silently drew nothing there. Neither URL is cached — placement ids restart with the process, so a cached response is the previous run's picture.

## End-to-end pipeline

```
running app
   │ writes escape bytes
   ▼
tmux (-CC, passthrough)
   │ wraps as %output %<pane> <bytes>
   ▼
tmuxy-core / control_mode/parser.rs
   │ feeds raw payload to
   ▼
control_mode/images.rs::ImageParser::process
   │ ─► extracts payload, decodes, stores image bytes in pane state
   │ ─► returns ImageProcessResult { stripped: bytes_to_render,
   │                                  new_placements: [(id, StoredImage)…] }
   ▼
ServerPane.images  (snake_case, serialized over SSE)
   │
   ▼
appMachine.helpers::transformServerState  (snake → camel via camelize())
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

**Content-tracked scrolling and scroll/copy mode.** `PaneState::sync_url_scroll` reads `vt100::Screen::scroll_delta()` as terminal output is processed and calls `ImageParser::shift_rows_up` / `shift_rows_down` to shift each placement's `row` in lockstep with the surrounding text. Placements that scroll above the live viewport (`row < 0`) are retained until their bottom edge (`row + height_cells`) passes the scrollback limit (`VIEWER_SCROLLBACK_ROWS`), and `ScrollbackTerminal.tsx` renders `.terminal-images` at `top: calc((historySize + row) * var(--line-height-terminal))` so images remain visible when scrolling back in scroll or copy mode. Primary-screen placements also survive pane zoom and resize (`ImageParser::reset_for_resize` only clears placements on the alternate screen, where full-screen apps redraw on `SIGWINCH`).

See [RICH-RENDERING-CELL-GRID.md](RICH-RENDERING-CELL-GRID.md) for this section: The cell grid invariant.

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

- **Rust unit tests** (`tmuxy-core/src/control_mode/images.rs`) cover the parsers and placement geometry — including chunked Kitty transfers, RGBA-to-PNG conversion, and Sixel decode.
- **Storybook interaction tests** in `tmuxy-ui/src/components/ImageProtocols.stories.tsx` use the demo adapter's `tmuxy-image-attach` helper to inject placements and verify the rendered `<img>` element (one story per protocol plus a multi-protocol story and a split-pane story). The byte source is stubbed via `window.__tmuxyImageSrc`.
- **E2E** runs a real tmux session, emits each protocol with a shell command, and asserts the `<img>` shows up in the page (see `tests/`).

## Other rich-rendering opportunities

These are documented because they reuse the same passthrough pipeline; whether to implement them is a product decision, not a technical one.

- **OSC 9 / OSC 777 — Desktop notifications**
- **OSC 9;4 — ConEmu progress bars**
- **OSC 133 — FinalTerm semantic zones** (prompt / command / output markers)
- **OSC 7 — Working-directory hints** (already partially wired for tab titles)

## Related

- [TMUX.md](TMUX.md) — control-mode protocol and version quirks
- [DATA-FLOW.md](DATA-FLOW.md) — SSE/HTTP delivery of placements and image bytes
- [NON-GOALS.md](NON-GOALS.md) — what we still deliberately don't render
