# Tmuxy Documentation

This directory contains architectural and design documentation for the tmuxy project. It is written for both **human developers** and **AI coding agents** (Claude Code, Copilot, etc.) that work on this codebase.

## How to Use These Docs

**Before starting work:** Read the docs relevant to the area you're changing. They provide critical context about architecture, constraints, and conventions that aren't obvious from reading code alone.

**After finishing work:** If your changes affect behavior described here, update the relevant docs or flag the misalignment.

**For AI agents:** The project's `CLAUDE.md` references these docs and includes rules about reviewing them. Key constraints (e.g., all tmux commands must go through control mode) are documented here because they prevent crashes and data loss.

## Document Guide

### Core Architecture

| Document | What it covers | When to read it |
|----------|---------------|-----------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | High-level system overview: components, how they interact, key design decisions, file structure | Starting any work on the project; onboarding |
| [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) | Frontend XState machine (states, context, actors, child machines, selectors, React hooks) and backend Rust state (AppState, SessionConnections, TmuxMonitor, StateAggregator, MonitorCommand, StateEmitter) | Changing state handling, adding events, modifying the machine, or working on the Rust backend |
| [DATA-FLOW.md](DATA-FLOW.md) | SSE/HTTP protocol, Tauri IPC, adapter pattern, delta protocol, connection lifecycle, keyboard input flow, and three real-world deployment scenarios | Working on client-server communication, the adapter layer, or deployment configuration |

### tmux Integration

| Document | What it covers | When to read it |
|----------|---------------|-----------------|
| [TMUX.md](TMUX.md) | Control mode architecture, command routing rules (which commands must use control mode vs. safe as subprocesses), `new-window` crash workaround, version-specific bugs, tmux configuration, flow control | Any work involving tmux commands, pane/window operations, or shell scripts |
| [COPY-MODE.md](COPY-MODE.md) | Client-side copy mode reimplementation: vi keybindings, scrollback loading, selection/clipboard, entry/exit triggers, key files | Working on copy mode, scrollback, or keyboard handling during copy mode |

### Security & Constraints

| Document | What it covers | When to read it |
|----------|---------------|-----------------|
| [SECURITY.md](SECURITY.md) | Threat model, known risks (no auth, no TLS, arbitrary file access, run-shell), LLM-assisted development risks, deployment recommendations | Deploying tmuxy, adding network-facing features, or assessing risk |
| [NON-GOALS.md](NON-GOALS.md) | What tmuxy intentionally does NOT do (no local scrollback, no terminal emulation, no image protocols, no canvas rendering, etc.) | Before proposing a new feature; understanding design boundaries |

### Testing

| Document | What it covers | When to read it |
|----------|---------------|-----------------|
| [TESTS.md](TESTS.md) | Test framework (Jest + Playwright), running tests, test structure, helpers, debugging, rules | Writing or debugging tests |
| [E2E-TEST-SCENARIOS.md](E2E-TEST-SCENARIOS.md) | Full list of 18 implemented E2E test scenarios with descriptions and expected behaviors | Planning new tests or understanding existing coverage |

### Protocols & Rendering

| Document | What it covers | When to read it |
|----------|---------------|-----------------|
| [RICH-RENDERING.md](RICH-RENDERING.md) | Terminal image protocols (Kitty, iTerm2, Sixel), OSC sequences (hyperlinks, clipboard, notifications), current implementation status | Working on terminal rendering, OSC parsing, or considering rich content features |

## Conventions

- **No project-specific code** in docs. Describe architecture in prose and tables. Reference file paths instead of embedding code snippets (they go stale).
- **Use ASCII diagrams**, not Mermaid. Plain ASCII art in fenced code blocks works everywhere.
- **Uppercase filenames** (e.g., `ARCHITECTURE.md`) to match README.md convention and distinguish docs from code.
- **Cross-reference** related docs with a "Related" section at the bottom of each file.
