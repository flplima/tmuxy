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

### 2. Live Local Scrollback Buffer

We do NOT continuously buffer a pane's output on the client. tmux is the only owner of scrollback history.

What we *do* render client-side is a **view** of it: mouse wheel in a normal shell enters copy mode and renders scrollback **fetched on demand from tmux** (`get_scrollback_cells` → `capture-pane`), lazily in chunks as the user scrolls, discarded when the pane leaves copy mode — see [COPY-MODE.md](COPY-MODE.md). In alternate screen (vim, less), the wheel sends arrow keys. So scrolling works and scrollback renders client-side, but the history always comes from tmux at scroll time, never from a buffer we keep in sync with live output.

**Why no live buffer?**
- Duplicates tmux's work
- Unbounded memory growth on the client
- State divergence risk against the pane tmux actually holds
- Lost on page refresh anyway

### 3. Local Search (Cmd+F / Ctrl+F)

We do NOT implement browser-style find-in-page for terminal content. Users search via tmux copy mode (`Prefix + [` then `/` or `?`).

**Why?** A find-in-page would have to search history we don't hold — the copy-mode `lines` map covers only the chunks fetched around the current viewport, so a client-side search would silently miss matches outside it. Searching in tmux searches the real buffer.

### 4. Local Echo / Input Prediction

We do NOT predict keystrokes locally to reduce perceived latency (like mosh does). Every keystroke round-trips through tmux.

**Why?**
- Only benefits high-latency connections
- Tmuxy is primarily for local/LAN use
- Adds significant complexity
- Risk of prediction errors

### 5. Binary Protocol / Compression

We use JSON over SSE/HTTP, not binary encoding (MessagePack, Protobuf) or compression.

**Why?**
- For local tmux, bandwidth is not the bottleneck
- JSON is debuggable and simple
- Premature optimization

### 6. Unicode Width Calculation

We do NOT maintain our own `wcwidth` tables for character width calculation. Tmux renders the grid; we display it.

**Exception:** If we implement custom text selection, we may need width info. Until then, tmux handles it.

### 7. Canvas/WebGL Rendering

We use DOM rendering (spans), not canvas or WebGL.

**Why?**
- DOM is simpler and works
- Native text selection works with DOM
- Accessibility (screen readers) works with DOM
- Canvas/WebGL is premature optimization

### 8. Simultaneous Multi-Session Views

We do NOT render more than one tmux session at a time. One tmuxy instance is attached to one session; there is no split view across sessions and no cross-session pane layout.

Switching between them *is* supported — `tmuxy session switch` and the sidebar sessions tree (`SidebarTree.tsx`) reattach without a page reload.

### 9. SSH via Web Server

SSH connections (remote server attachment) are only available in the Tauri desktop app. The web server accesses the host's local tmux; there is no browser-to-SSH tunnel.

---

## What We DO

- Render tmux panes accurately
- Handle keyboard input and forward to tmux
- Support tmux window/pane operations (split, resize, close, navigate)
- Provide a clean, modern UI for tmux
- Parse OSC sequences for hyperlinks and clipboard (targeted, not full emulation)
- Decode terminal image protocols (iTerm2 OSC 1337, Kitty Graphics, Sixel) and render them as inline `<img>` placements — see [RICH-RENDERING.md](RICH-RENDERING.md)
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

- [COPY-MODE.md](COPY-MODE.md) — Client-side scrollback rendering (the one scrollback-like feature we implement; history fetched from tmux on demand)
- [RICH-RENDERING.md](RICH-RENDERING.md) — Image protocol support (iTerm2, Kitty, Sixel) and OSC 8 hyperlinks
