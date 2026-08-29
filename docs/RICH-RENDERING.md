# Rich Terminal Rendering

Tmuxy intercepts terminal escape sequences that would otherwise be passed through to (or dropped by) tmux and renders them as real DOM elements. The browser shows actual `<a>` for hyperlinks, `<img>` for inline images, and clipboard requests round-trip through `navigator.clipboard`.

This document covers what's supported, how the pipeline works, and how to test each protocol.

## Supported protocols

| Protocol | DCS / OSC / APC | Backend | Frontend | Notes |
|----------|----------------|---------|----------|-------|
| **OSC 8 — Hyperlinks** | `ESC ] 8 ; … ; <url> ST` | `control_mode/osc.rs` (style on cell) | `TerminalLine.tsx` → `<a href>` | Parsed from the control-mode stream; no `terminal-features` setting needed |
| **OSC 1337 — iTerm2 Inline Images** | `ESC ] 1337 ; File=… : <base64> BEL` | `control_mode/images.rs::try_parse_iterm2` | `Terminal.tsx` → `<img src="/api/images/…">` | Base64 of any browser-renderable format |
| **APC _G — Kitty Graphics** | `ESC _ G <keys> ; <payload> ESC \` | `control_mode/images.rs::try_parse_kitty` | same | Supports chunked transfer (`m=1`/`m=0`) and formats `f=24`/`f=32`/`f=100` |
| **DCS Pq — Sixel** | `ESC P q … ESC \` | `control_mode/images.rs::try_parse_sixel` | same | Decoded by `icy_sixel`, re-encoded as PNG before serving |
| **OSC 52 — Clipboard** | `ESC ] 52 ; c ; <base64> ST` | `control_mode/osc.rs` parser → `StateEmitter::write_clipboard` → SSE `clipboard` event (web) / `tmux-clipboard` (Tauri) | `TmuxAdapter.onClipboard` → `TMUX_CLIPBOARD` event → `navigator.clipboard.writeText` in appMachine | Outbound only — pasting back is not implemented. Storybook coverage: `App/Resilience > ClipboardOSC52`. |

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

OSC 8 has been supported for a long time. The image protocols landed together with the OSC 52 parser — all parsing lives in `tmuxy-core/src/control_mode/images.rs` and `tmuxy-core/src/control_mode/osc.rs` — but only the SSE `clipboard` event + `TMUX_CLIPBOARD` plumbing finished the round-trip into `navigator.clipboard.writeText`. On the frontend, `Terminal.tsx` renders image placements and `TerminalLine.tsx` renders hyperlink cells.

## How tmux preserves the sequences

Tmuxy speaks **tmux control mode** (`-CC`), and tmux forwards every escape sequence the running application emits inside `%output` events on stdout. That includes passthrough payloads. Earlier versions of this document claimed image escapes were stripped — that was wrong. The Rust parser sits on top of the control-mode byte stream and never needs to touch the pty directly.

Two tmux options matter:

- `set -g allow-passthrough on` — required so tmux doesn't refuse to relay the sequences. The monitor sets this automatically on every session at connect time (see `sync_initial_state` in `tmuxy-core/src/control_mode/monitor.rs`).
- `set -g default-terminal "tmux-256color"` (or another terminfo entry that does **not** include image capabilities) — keeps tmux from trying to act on the sequences itself.

The parser is permissive about line wrapping and stray printable bytes between chunked Kitty packets, since tmux re-flows output around its own column wrapping.

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
- `row`, `col` — top-left cell coordinates within the pane grid
- `width_cells`, `height_cells` — bounding box in terminal cells
- `protocol` — one of `iterm2`, `kitty`, `sixel`

The frontend positions the `<img>` absolutely inside `.terminal-images` in cell units — `--cell-w` horizontally, `--line-height-terminal` vertically — so the image stays anchored to the same cell range as the surrounding text reflows. This is the same grid the rows and the cursor use; see [The cell grid invariant](#the-cell-grid-invariant). When `width=auto` / `height=auto` is requested, the parser converts pixels to cells using the pane's current cell size estimate.

**Known limitation — placements are viewport-cell anchored, not content-tracked.** The `row`/`col` anchor is the cursor position at decode time and never moves afterwards: the core's vt100 emulator runs with zero scrollback, so there is no scroll signal to shift placements when later output scrolls the screen. An image therefore stays pinned to its original viewport cell while text scrolls underneath it (iTerm2, by contrast, scrolls images with content). Content-tracked placements would require a scrolled-lines counter in the vt100 layer plus row adjustment and off-screen culling in `control_mode/images.rs`. The `ImageAnchoredDuringScroll` story guards the current anchored behavior.

## The cell grid invariant

A terminal is a grid of cells, but a browser lays out text by glyph advance. Everything tmuxy paints into a pane must therefore be addressed in **cell coordinates**, never allowed to inherit a position from the surrounding text flow. Three rules follow, and each has already been violated once:

**0. One measurement, one cell width.** The font's natural advance is a fraction of a pixel (FiraCode at 15px measures 9.23px), and boxes laid out at multiples of a fractional advance land on fractional pixel edges that the compositor snaps — so a wide pane's text ends a pixel away from where its box does, and adjacent pane outlines stop coinciding. The size actor therefore measures the advance once (inside the pane container, with the real `.terminal-content` styles), snaps it to a whole device pixel, and publishes two custom properties on the app root: `--cell-w`, the snapped cell width every cell-addressed box is a multiple of, and `--cell-gap`, the `letter-spacing` that pads the natural advance up to `--cell-w` so text really advances one cell per character. That same snapped width is the `charWidth` the pane rectangles and the cols→tmux calculation use, so the grid, the text, the cursor and the images all derive from a single number. `ch` is deliberately **not** the grid unit: it is the advance of "0" *without* letter-spacing, so once the advance is snapped `1ch` is no longer a cell. `cellsToCss` in `terminalShared.ts` is the only place that spells the unit out; it falls back to `1ch` outside the app (component stories) — see `utils/cellMetrics.ts`, `stories/cellGrid.tsx`.

**1. Position by cell, not by flow.** Style-group spans are pinned to an exact cell count (`width: calc(<n> * var(--cell-w))`), so a glyph whose advance differs from a cell paints within or over its own box instead of displacing the rest of the line. The cursor obeys the same rule: it is an absolutely positioned overlay at the cursor's cell in grid units (`--cell-w` and `--line-height-terminal`), in both renderers. It was previously spliced inline into the line's text, which made its position depend on the advance of every glyph before it; a webfont that had not finished loading, an RTL script, or a dingbat then pushed it off the grid.

**2. Index by cell, not by UTF-16 offset.** One cell may hold several code units — a variation selector (`U+FE0F`), a combining mark, a ZWJ or skin-tone sequence. Any code that joins a line's cells into a string and then indexes that string with a column number is wrong: the two diverge at the first multi-unit cell and stay diverged for the rest of the line. This is why the cursor character comes from the cell array and why auto-detected URL ranges are translated through a per-cell offset map before being compared against cell indices.

`isWideChar` (in `terminalShared.ts`, shared by both renderers) decides which cells get their own box. It inspects the whole cell string, not just the first code point, because emoji presentation is requested by a trailing `U+FE0F` that the base code point knows nothing about. It deliberately over-detects — a one-cell glyph in its own one-cell box renders identically, so the only cost of a false positive is an extra span. Regional indicators are in its ranges because a flag cell starts with one (see below).

### Cell widths must agree with tmux

tmux reports cursor positions and lays out everything on **its** grid; tmuxy re-emulates the raw output with the vendored `vt100` crate. Any character whose width the two disagree on shifts every later cell on that line — the line looks fine on its own but the cursor lands two cells off, and the next absolute cursor move writes over the wrong columns. Per-code-point East Asian Width (what `unicode-width` gives) is not enough: tmux 3.4+ combines sequences into one cell in `screen_write_combine`, and the vendored `vt100` (`vendor/vt100/src/screen.rs`) mirrors those rules exactly:

| Input | tmux / tmuxy cell | Naive per-code-point width |
|-------|-------------------|----------------------------|
| ZWJ sequence `👩‍💻` | one 2-column cell (the character after a ZWJ joins the previous cell) | 4 columns |
| emoji + skin tone `👍🏽` | one 2-column cell (only for tmux's list of 66 base emoji; the modifier alone is its own 2-column character) | 4 columns |
| two regional indicators `🇺🇸` | one 2-column cell (a third indicator starts a new cell) | 2 × 1 column |
| text symbol + VS16 `❤️` | one 1-column cell (tmux default: `variation-selector-always-wide` off) | 1 column |
| combining mark `é` | joins the previous cell, through a wide character's continuation half | 1 column |
| `U+3164` Hangul filler | dropped | 1 column |
| ZWJ / VS16 at column 0 | dropped | — |
| sequence longer than the cell buffer (22 bytes; tmux 21) | the overflowing character starts a new cell | — |

The E2E test in `tests/3-rendering-protocols.test.js` ("Wide glyphs stay on the tmux cell grid") is the contract: it prints each case, parks the shell in `read`, and compares the *rendered* cursor and marker positions against tmux's own `#{cursor_x}`. Add a row to that test whenever a width rule changes.

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
