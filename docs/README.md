# Tmuxy Documentation

This directory contains architectural and design documentation for the tmuxy project. It is written for both **human developers** and **AI coding agents** (Claude Code, Copilot, etc.) that work on this codebase.

## How to Use These Docs

**Before starting work:** Read the docs relevant to the area you're changing. They provide critical context about architecture, constraints, and conventions that aren't obvious from reading code alone.

**After finishing work:** If your changes affect behavior described here, update the relevant docs or flag the misalignment.

**For AI agents:** The project's `AGENTS.md` references these docs and includes rules about reviewing them. Key constraints (e.g., all tmux commands must go through control mode) are documented here because they prevent crashes and data loss.

## Document Guide

Every file in this directory. A doc that outgrew the size cap (below) continues in companions named after it, listed under it.

### Core Architecture

| Document | What it covers | When to read it |
| --- | --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | High-level system overview: components, how they interact, key design decisions, file structure | Starting any work on the project; onboarding |
| [ARCHITECTURE-WIDGETS.md](ARCHITECTURE-WIDGETS.md) | Panes that draw something other than a terminal: the widget registry, the tree and the preview | Adding or changing a widget |
| [ARCHITECTURE-INDEX.md](ARCHITECTURE-INDEX.md) | Compact feature-to-files lookup index optimized for retrieval by AI agents | Quickly locating implementation entry points |
| [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) | Frontend XState machine (states, context, actors, child machines, selectors, React hooks) and backend Rust state (AppState, SessionConnections, TmuxMonitor, StateAggregator, MonitorCommand, StateEmitter) | Changing state handling, adding events, modifying the machine, or working on the Rust backend |
| [STATE-MANAGEMENT-ACTORS.md](STATE-MANAGEMENT-ACTORS.md) | The app machine's context, its actors and child machines, and how the code is split | Adding an actor or a context field |
| [STATE-MANAGEMENT-UPDATES.md](STATE-MANAGEMENT-UPDATES.md) | Optimistic updates (`TmuxClientModel`), read-only focus, keystroke routing, user-facing errors, React integration | Changing a prediction, a reconcile verdict or what the user sees of a failure |
| [DATA-FLOW.md](DATA-FLOW.md) | SSE/HTTP protocol, adapter pattern, delta protocol, connection lifecycle, keyboard input flow | Working on client-server communication or the adapter layer |
| [DATA-FLOW-DEPLOYMENTS.md](DATA-FLOW-DEPLOYMENTS.md) | The Tauri transport, real-world deployment scenarios and the extra HTTP endpoints | Deploying, or touching the desktop IPC |
| [DESKTOP.md](DESKTOP.md) | What only the desktop app has (trackpad gestures, GUI windows, window chrome, native menus, other servers) and why | Working on the Tauri app, or wondering why the web build lacks something |

### tmux Integration

| Document | What it covers | When to read it |
| --- | --- | --- |
| [TMUX.md](TMUX.md) | Control mode architecture, command routing rules (which commands must use control mode vs. safe as subprocesses), `new-window` crash workaround, flow control | Any work involving tmux commands, pane/window operations, or shell scripts |
| [TMUX-TAGS.md](TMUX-TAGS.md) | The `@tmuxy-*` window/pane tag schema and the pane-group model built on it (floats, groups, the stash session, window filtering) | Floats, pane groups, anything that reads or writes a tag |
| [TMUX-SIDEBARS.md](TMUX-SIDEBARS.md) | The two sidebar columns and `tmuxy pane send -t`, both built on the tags | The tree, the dock, cross-pane sends |
| [TMUX-CONFIG.md](TMUX-CONFIG.md) | The dedicated socket, the config chain, session groups, servers and client-side key tables | The socket, `~/.config/tmuxy`, PANE/TAB modes, remote servers |
| [TMUX-VERSION-BUGS.md](TMUX-VERSION-BUGS.md) | Version-specific tmux behaviour tmuxy depends on or works around, 3.2 to HEAD | A bug that shows on one tmux version |
| [COPY-MODE.md](COPY-MODE.md) | Client-side copy mode reimplementation: vi keybindings, scrollback loading, selection/clipboard, entry/exit triggers, key files | Working on copy mode, scrollback, or keyboard handling during copy mode |

### Security & Constraints

| Document | What it covers | When to read it |
| --- | --- | --- |
| [SECURITY.md](SECURITY.md) | Threat model, optional password auth, loopback by default, known risks (no TLS, file access, run-shell), deployment recommendations | Deploying tmuxy, adding network-facing features, or assessing risk |
| [SECURITY-NETWORK.md](SECURITY-NETWORK.md) | Where the server listens, what it serves, and how to deploy it | Exposing a server beyond the machine it runs on |
| [SECURITY-CONTENT.md](SECURITY-CONTENT.md) | Previewed files, session snapshots and hostile pane output | The preview widget, snapshots, anything that renders what a program wrote |
| [NON-GOALS.md](NON-GOALS.md) | What tmuxy intentionally does NOT do (no terminal emulation, no live local scrollback buffer, no local echo, no canvas rendering, etc.) | Before proposing a new feature; understanding design boundaries |

### Testing

| Document | What it covers | When to read it |
| --- | --- | --- |
| [TESTS.md](TESTS.md) | The guidelines for every test type, known coverage gaps, and where a new test belongs | Writing, placing or debugging tests |
| [TESTS-LAYERS.md](TESTS-LAYERS.md) | Every test layer, the CI job that runs it, the local gates, and the tiers (per commit, nightly, before a release) | Reading a CI failure; deciding which layer a test goes in |
| [TESTS-E2E.md](TESTS-E2E.md) | The browser + tmux suites, what their helpers guarantee, the latency gate and the Tauri suite | Writing or fixing an E2E test |
| [TESTS-STORYBOOK.md](TESTS-STORYBOOK.md) | The deterministic and v86 Storybook probes, quarantine, accessibility | Writing or fixing a story |
| [INVARIANTS.md](INVARIANTS.md) | The ledger of cross-layer promises — effect ordering, stream sequencing, predictions, read-only gating — each with the test that holds it | Fixing a bug on a seam; adding a test for ordering or a race |
| [PERFORMANCE.md](PERFORMANCE.md) | Speed measurement along two independent axes: core + client processing (Axis A) vs transport (Axis B), and the harness for each | Benchmarking, profiling, or investigating latency |
| [PERFORMANCE-BASELINE.md](PERFORMANCE-BASELINE.md) | The numbers measured so far, long-session retention, and snapshot costs | Judging whether a measurement regressed |
| [TRACING.md](TRACING.md) | Unified cross-layer action tracing (XState/Effect/Rust/Tauri) into one local NDJSON file: reading it, the redaction boundary | Debugging complex cross-layer issues; reporting a bug with a trace |
| [TRACING-DESIGN.md](TRACING-DESIGN.md) | The trace file's schema, its instrumentation seams and correlation | Adding instrumentation |
| [CI-TRIAGE.md](CI-TRIAGE.md) | Fast triage workflow for CI failures, with job-to-command mappings and artifact entry points | Investigating red GitHub Actions runs |

### Protocols & Rendering

| Document | What it covers | When to read it |
| --- | --- | --- |
| [RICH-RENDERING.md](RICH-RENDERING.md) | Terminal image protocols (iTerm2, Kitty, Sixel), OSC sequences (hyperlinks, clipboard, notifications), current implementation status | Working on terminal rendering, OSC parsing, or considering rich content features |
| [RICH-RENDERING-CELL-GRID.md](RICH-RENDERING-CELL-GRID.md) | Why every glyph must land on tmux's cell grid, and how widths are kept in agreement | Fonts, wide characters, anything that measures a cell |

## Conventions

- **No project-specific code** in docs. Describe architecture in prose and tables. Reference file paths instead of embedding code snippets (they go stale).
- **Use ASCII diagrams**, not Mermaid. Plain ASCII art in fenced code blocks works everywhere.
- **Uppercase filenames** (e.g., `ARCHITECTURE.md`) to match README.md convention and distinguish docs from code.
- **Cross-reference** related docs with a "Related" section at the bottom of each file.
- **Under 5,000 tokens per file** (bytes / 4), enforced repo-wide by `bin/check-repo-policy.mjs`. A topic that outgrows it moves whole sections into a companion named after its parent (`TMUX-TAGS.md`, `TESTS-E2E.md`, `STATE-MANAGEMENT-ACTORS.md`), the parent keeps a one-line pointer where the section was, and the guide above lists the companion under its parent. Tables stay unpadded (`| a | b |`); column padding once made up half the bytes of a doc.
