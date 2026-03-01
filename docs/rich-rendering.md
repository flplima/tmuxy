# Rich Terminal Rendering in Tmuxy

This document summarizes research on terminal image protocols and rich content rendering capabilities that can be implemented in tmuxy.

## Overview

Since tmuxy captures terminal output before rendering in the browser, we can intercept escape sequences that would be ignored/stripped by tmux and handle them specially. The browser can render actual `<img>` elements, `<a>` hyperlinks, and custom components.

## Image Protocols Comparison

| Protocol | Quality | Speed | Support | Notes |
|----------|---------|-------|---------|-------|
| **Kitty Graphics** | Excellent (full color) | Fast | kitty, Ghostty, WezTerm | Most modern, supports animations |
| **iTerm2** | Excellent | Fast | iTerm2, WezTerm, many others | Simpler than Kitty, widely adopted |
| **Sixel** | Limited (palette-based, 0-100 color range) | Slower | Oldest, broadest support | tmux has `--enable-sixel` support |

**Recommendation**: Support Kitty Graphics Protocol as primary (most capable) with iTerm2 as fallback (simpler, good compatibility). Sixel is primitive and wasteful compared to the others.

## Protocol Specifications

### 1. OSC 8 Hyperlinks

Clickable links with custom text. Widely supported by modern terminals.

**Format:**
```
ESC ] 8 ; params ; <url> ST <link text> ESC ] 8 ; ; ST
```

- `ESC ]` = OSC (Operating System Command) introducer
- `8` = hyperlink command
- `params` = optional parameters (e.g., `id=xyz` for grouping)
- `url` = the target URL
- `ST` = String Terminator (`ESC \` or `BEL`)
- Text between the two sequences becomes the clickable link

**Example:**
```
\x1b]8;;https://example.com\x1b\\Click here\x1b]8;;\x1b\\
```

**Applications using OSC 8:**
- GCC 10+ (error messages linking to docs)
- `ls --hyperlink`
- `grep` with `--color`
- Rich (Python library)
- Many CLI tools

**References:**
- [OSC 8 Specification](https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda)
- [OSC 8 Adoption Tracker](https://github.com/Alhadis/OSC8-Adoption)

### 2. iTerm2 Inline Images Protocol

Simple protocol for displaying images inline.

**Format:**
```
ESC ] 1337 ; File=<args> : <base64 data> BEL
```

**Arguments:**
- `name=<base64 filename>` - Optional filename
- `size=<bytes>` - File size in bytes
- `width=<n>` / `height=<n>` - Display dimensions (cells, pixels, or percentage)
- `preserveAspectRatio=1` - Maintain aspect ratio
- `inline=1` - Display inline (required for images)

**Example:**
```
\x1b]1337;File=inline=1;width=auto;height=auto:<base64_image_data>\x07
```

**References:**
- [iTerm2 Inline Images Documentation](https://iterm2.com/documentation-images.html)

### 3. Kitty Graphics Protocol

Most capable protocol with support for animations, image references, and efficient caching.

**Format:**
```
ESC _ G <control_data> ; <base64_payload> ESC \
```

**Control Data Keys:**
- `a` - Action: `t` (transmit), `p` (put/display), `d` (delete), `f` (frame), `a` (animate)
- `f` - Format: `24` (RGB), `32` (RGBA), `100` (PNG)
- `t` - Transmission: `d` (direct), `f` (file), `s` (shared memory)
- `s` / `v` - Width/height in pixels
- `c` / `r` - Width/height in cells
- `x` / `y` - Offset within cell
- `X` / `Y` - Position in cells
- `i` - Image ID (for referencing)
- `m` - More data: `1` (more chunks coming), `0` (final chunk)
- `q` - Quiet mode: `1` (suppress responses), `2` (suppress errors)

**Chunking:**
Data must be chunked into max 4096 byte segments:
```
ESC_G a=t,f=100,i=1,m=1;<chunk1>ESC\
ESC_G m=1;<chunk2>ESC\
ESC_G m=0;<final_chunk>ESC\
ESC_G a=p,i=1;ESC\
```

**Animation:**
- `a=f` - Transmit animation frame
- `a=a` - Control animation (start, stop, loop)

**References:**
- [Kitty Graphics Protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
- [Kitty Protocol Extensions](https://sw.kovidgoyal.net/kitty/protocol-extensions/)

## Other Rich Rendering Opportunities

### Desktop Notifications (OSC 9/777)
```
ESC ] 9 ; <message> ST        # Windows Terminal
ESC ] 777 ; notify ; <title> ; <body> ST  # rxvt-unicode
```

### Clipboard Operations (OSC 52)
```
ESC ] 52 ; c ; <base64_data> ST   # Set clipboard
ESC ] 52 ; c ; ? ST               # Query clipboard
```

### Progress Bars (ConEmu style)
```
ESC ] 9 ; 4 ; <state> ; <progress> ST
```
- state: 0=hidden, 1=default, 2=error, 3=indeterminate, 4=warning

### Semantic Zones (iTerm2/FinalTerm)
Mark prompt, command, output regions for navigation:
```
ESC ] 133 ; A ST  # Start of prompt
ESC ] 133 ; B ST  # End of prompt, start of command
ESC ] 133 ; C ST  # End of command, start of output
ESC ] 133 ; D ; <exit_code> ST  # End of output
```

### Current Directory (OSC 7)
```
ESC ] 7 ; file://<hostname>/<path> ST
```

## Implementation Architecture

```
┌─────────────────┐     ┌──────────────────────────────────────┐
│  tmux output    │────▶│  Rust Backend (escape parser)        │
│  (raw escapes)  │     │  - Detect image/OSC sequences        │
│                 │     │  - Extract & decode payloads         │
│                 │     │  - Send structured data to frontend  │
└─────────────────┘     └──────────────────────────────────────┘
                                          │
                                          ▼
                        ┌──────────────────────────────────────┐
                        │  React Frontend                      │
                        │  - Terminal.tsx renders ANSI text    │
                        │  - <img> for image sequences         │
                        │  - <a> for OSC 8 hyperlinks          │
                        │  - Custom components for widgets     │
                        └──────────────────────────────────────┘
```

## Implementation Priority

### Phase 1: Quick Wins
1. **OSC 8 Hyperlinks** - Parse and render as `<a href>` (easy, high value)
2. **iTerm2 inline images** - Simpler protocol, base64 → `<img src="data:...">`
3. **Kitty Graphics** - Full implementation with chunking, IDs, animations

### Phase 2: Enhanced Features
4. Desktop notifications (OSC 9/777)
5. Clipboard operations (OSC 52)
6. Semantic zones for better navigation
7. Progress bar indicators

### Phase 3: Tmuxy-Exclusive Features
8. Interactive widgets (buttons, forms)
9. Markdown rendering blocks
10. Chart/graph rendering (D3.js, Chart.js)
11. LaTeX math formulas
12. Syntax-highlighted code blocks

## Current Implementation Status

| Feature | Status | Works via tmux | Notes |
|---------|--------|----------------|-------|
| **OSC 8 Hyperlinks** | ✅ Working | ✅ | Rust backend parses OSC 8 → `cell.style.url` → `TerminalLine.tsx` renders `<a>` tags. Requires `terminal-features "hyperlinks"` in tmux config |
| **iTerm2 Images** | ❌ Inactive | ❌ | Frontend parser/renderer exist in `richContentParser.ts` and `RichContent.tsx` but are unused (dead code). `allow-passthrough` forwards to outer terminal, not captured |
| **Kitty Graphics** | ❌ Inactive | ❌ | Frontend parser/renderer exist but are unused (dead code). kitten detects tmux incompatibility, falls back to Unicode |

### tmux Limitations

tmux's `allow-passthrough` mode forwards escape sequences to the outer terminal but does **not** retain them in the capture buffer. This means:

1. **OSC 8 Hyperlinks** - Work because tmux has native support via `terminal-features "hyperlinks"`. These sequences are kept in the buffer and captured by `capture-pane -e`.

2. **Image Protocols (iTerm2, Kitty)** - Don't work because:
   - Passthrough sequences bypass the capture buffer entirely
   - `capture-pane` never sees them
   - kitten icat detects tmux and falls back to Unicode placeholders

### Future Solutions for Images

1. **Tauri Desktop App** - Connect directly to a pty without tmux; all protocols would work
2. **Sideband Channel** - Backend intercepts image sequences before tmux and sends via separate SSE event
3. **tmux Plugin** - Custom tmux plugin to capture and forward image data

## Testing

### OSC 8 Hyperlinks (Working)
```bash
# In a tmux session with tmuxy config
printf '\e]8;;https://example.com\e\\Click me\e]8;;\e\\\n'
ls --hyperlink=auto
```

### iTerm2 Images (Not working via tmux)
```bash
# Would work in direct terminal, not via tmux
imgcat image.png
```

### Kitty Graphics (Not working via tmux)
```bash
# Would work in Kitty terminal, not via tmux
kitty +kitten icat image.png
```
