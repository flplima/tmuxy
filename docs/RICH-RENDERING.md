# Rich Terminal Rendering

Tmuxy intercepts terminal escape sequences that would otherwise be passed through to (or dropped by) tmux and renders them as real DOM elements. The browser shows actual `<a>` for hyperlinks, `<img>` for inline images, and clipboard requests round-trip through `navigator.clipboard`.

This document covers what's supported, how the pipeline works, and how to test each protocol.

## Supported protocols

| Protocol | DCS / OSC / APC | Backend | Frontend | Notes |
|----------|----------------|---------|----------|-------|
| **OSC 8 — Hyperlinks** | `ESC ] 8 ; … ; <url> ST` | `control_mode/osc.rs` (style on cell) | `TerminalLine.tsx` → `<a href>` | Requires `terminal-features "*:hyperlinks"` in tmux |
| **OSC 1337 — iTerm2 Inline Images** | `ESC ] 1337 ; File=… : <base64> BEL` | `control_mode/images.rs::try_parse_iterm2` | `Terminal.tsx` → `<img src="/api/images/…">` | Base64 of any browser-renderable format |
| **APC _G — Kitty Graphics** | `ESC _ G <keys> ; <payload> ESC \` | `control_mode/images.rs::try_parse_kitty` | same | Supports chunked transfer (`m=1`/`m=0`) and formats `f=24`/`f=32`/`f=100` |
| **DCS Pq — Sixel** | `ESC P q … ESC \` | `control_mode/images.rs::try_parse_sixel` | same | Decoded by `icy_sixel`, re-encoded as PNG before serving |
| **OSC 52 — Clipboard** | `ESC ] 52 ; c ; <base64> ST` | `control_mode/osc.rs` parser → `StateEmitter::write_clipboard` → SSE `clipboard` event (web) / `tmux-clipboard` (Tauri) | `TmuxAdapter.onClipboard` → `TMUX_CLIPBOARD` event → `navigator.clipboard.writeText` in appMachine | Outbound only — pasting back is not implemented. Storybook coverage: `App/Resilience > ClipboardOSC52`. |

OSC 8 has been supported for a long time. The image protocols landed together with the OSC 52 parser (see the `images.rs` and `osc.rs` parsers), but only the SSE `clipboard` event + `TMUX_CLIPBOARD` plumbing finished the round-trip into `navigator.clipboard.writeText`. The frontend `richContentParser.ts` / `RichContent.tsx` modules predate this work and are used only for widget markdown rendering, not for inline image decoding.

## How tmux preserves the sequences

Tmuxy speaks **tmux control mode** (`-CC`), and tmux forwards every escape sequence the running application emits inside `%output` events on stdout. That includes passthrough payloads. Earlier versions of this document claimed image escapes were stripped — that was wrong. The Rust parser sits on top of the control-mode byte stream and never needs to touch the pty directly.

Two tmux options matter:

- `set -g allow-passthrough on` — required so tmux doesn't refuse to relay the sequences. Tmuxy's bundled `~/.tmuxy.conf` sets this.
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

The frontend positions the `<img>` absolutely inside `.terminal-images` using `calc(<n> * var(--cell-width|height))`, so the image stays anchored to the same cell range as the surrounding text reflows. When `width=auto` / `height=auto` is requested, the parser converts pixels to cells using the pane's current cell size estimate.

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
