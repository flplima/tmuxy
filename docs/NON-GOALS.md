# Non-Goals

This document describes what tmuxy intentionally does NOT do. These are conscious decisions, not missing features.

## Target Audience

Tmuxy targets **tmux-heavy users** who already know and use tmux. It is not trying to attract users unfamiliar with tmux or replace standalone terminal emulators.

## Core Philosophy

**Tmuxy is a tmux UI, not a terminal emulator.**

We delegate terminal emulation to tmux. We render what tmux gives us. We don't re-implement what tmux already handles well.

---

## Non-Goals

### 1. Full Terminal Emulation

We do NOT maintain a local terminal state machine (cursor position, SGR attributes, scroll regions). Tmux already does this.

### 2. Local Scrollback Buffer

We do NOT maintain our own scrollback history. Tmux has scrollback. Users access it via tmux copy mode (`Prefix + [`).

**Why not local scrollback?**
- Duplicates tmux's work
- Memory overhead on client
- State divergence risk
- Lost on page refresh anyway
- Target users already know copy mode

### 3. Native Mouse Wheel Scrolling

Mouse wheel does NOT scroll through history like a native terminal. In normal mode, it may enter copy mode or do nothing. In alternate screen (vim, less), it sends arrow keys.

**Why?** Native scrolling requires local scrollback, which we don't have.

### 4. Local Search (Cmd+F / Ctrl+F)

We do NOT implement browser-style find-in-page for terminal content. Users search via tmux copy mode (`Prefix + [` then `/` or `?`).

**Why?** Search requires a buffer to search through. We don't maintain one.

### 5. Image Protocols

We do NOT actively support iTerm2 or Kitty inline image protocols. Exploratory parser and renderer code exists in the frontend (`richContentParser.ts`, `RichContent.tsx`) but is currently unused — these components are not wired into the rendering pipeline. Full support would require a sideband channel to intercept image sequences before tmux strips them.

**Maybe later:** If demand exists and a sideband channel is implemented.

### 6. Local Echo / Input Prediction

We do NOT predict keystrokes locally to reduce perceived latency (like mosh does). Every keystroke round-trips through tmux.

**Why?**
- Only benefits high-latency connections
- Tmuxy is primarily for local/LAN use
- Adds significant complexity
- Risk of prediction errors

### 7. Binary Protocol / Compression

We use JSON over SSE/HTTP, not binary encoding (MessagePack, Protobuf) or compression.

**Why?**
- For local tmux, bandwidth is not the bottleneck
- JSON is debuggable and simple
- Premature optimization

### 8. Unicode Width Calculation

We do NOT maintain our own `wcwidth` tables for character width calculation. Tmux renders the grid; we display it.

**Exception:** If we implement custom text selection, we may need width info. Until then, tmux handles it.

### 9. Canvas/WebGL Rendering

We use DOM rendering (spans), not canvas or WebGL.

**Why?**
- DOM is simpler and works
- Native text selection works with DOM
- Accessibility (screen readers) works with DOM
- Canvas/WebGL is premature optimization

### 10. Cross-Session Features (Revised)

Session switching is supported via `tmuxy session switch` and the status bar session picker. One tmuxy instance connects to one session at a time, but can switch between sessions without page reload.

### 11. SSH via Web Server

SSH connections (remote server attachment) are only available in the Tauri desktop app. The web server accesses the host's local tmux; there is no browser-to-SSH tunnel.

---

## What We DO

- Render tmux panes accurately
- Handle keyboard input and forward to tmux
- Support tmux window/pane operations (split, resize, close, navigate)
- Provide a clean, modern UI for tmux
- Parse OSC sequences for hyperlinks and clipboard (targeted, not full emulation)
- Auto-reconnect on connection drop
- Handle flow control for stability

---

## Revisiting Non-Goals

These decisions can be revisited if:
1. Target audience changes (e.g., targeting non-tmux users)
2. A feature becomes trivial due to other work (e.g., local scrollback after OSC parsing)
3. Strong user demand with clear use cases

Until then, we stay focused on being the best tmux UI, not another terminal emulator.

## Related

- [COPY-MODE.md](COPY-MODE.md) — Client-side copy mode (the one scrollback-like feature we do implement)
- [RICH-RENDERING.md](RICH-RENDERING.md) — Image protocol research and current status (mostly inactive)
