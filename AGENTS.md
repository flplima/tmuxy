# Tmuxy

A web-based tmux interface built with React (Vite) frontend and Rust backend.

**Always keep the [Architecture](ARCHITECTURE.md) in mind when developing features.** It documents the full system design: package structure, control mode pipeline, state machines, adapter pattern, data flow, and critical constraints.

## Project Structure

```
tmuxy/
├── packages/
│   ├── tmuxy-core/      # Core Rust library for tmux interaction
│   ├── tmuxy-ui/        # React/Vite frontend
│   ├── web-server/      # Axum web server with Vite integration
│   └── tauri-app/       # Tauri desktop app wrapper
├── tests/               # E2E tests (Jest + Puppeteer)
│   ├── helpers/         # One file per helper function
│   └── *.test.js        # Test suites grouped by operation
└── docker/              # Docker development environment
```

## Devcontainer

You may be running inside a Docker devcontainer. Check for the `CONTAINER_NAME` env var.

| Variable | Description |
|----------|-------------|
| `CONTAINER_NAME` | Container name (e.g., `tmuxy-worktree-1`) |
| `HOST_PORT` | Port exposed on the host (e.g., `14089`) |
| `PORT` | Internal server port (`9000`) |

The dev server listens on `PORT` inside the container, mapped to `HOST_PORT` on the host. The app is accessible from the host at `http://localhost:$HOST_PORT`.

## Development

```bash
npm start               # Start dev server with hot reload (pm2 + cargo-watch)
npm run stop            # Stop dev server
npm run logs            # View dev server logs
npm run tauri:dev       # Start Tauri desktop app
npm test                # Unit tests (Vitest)
npm run test:e2e        # E2E tests (requires server + Chrome CDP)
```

## Coding Guidelines

### General Principles

1. **No legacy code** - Remove dead code immediately. No commented-out code, no unused imports, no deprecated functions kept "just in case". No backwards compatibility shims unless explicitly requested.

2. **No "not doing" comments** - Don't add comments explaining what the code doesn't do (e.g., `/* No hover effect */`). Comments should explain what the code does, not what it doesn't do.

3. **DRY (Don't Repeat Yourself)** - Extract repeated logic into reusable functions. If you write similar code twice, refactor it.

4. **Modular helpers** - Helpers live in the `helpers/` directory, organized by domain (e.g., `browser.js`, `ui.js`, `tmux.js`). Avoid monolithic files. Classes like `TmuxTestSession` encapsulate related functionality.

5. **Commit after completing tasks** - After finishing a significant feature, bug fix, or task, always commit and push the changes. This preserves work and allows for incremental progress tracking.

### React Components

1. **Avoid `useEffect`** - Do not use `useEffect` unless the alternative is significantly more complex. Side effects belong in the state machine, not in components.

2. **Components are for rendering** - React components should focus on presenting UI based on state. Business logic, data fetching, and side effects go in the state machine.

3. **Derive, don't sync** - Prefer deriving values from state over syncing state with `useEffect`.

```tsx
// Bad - syncing state with useEffect
const [derivedValue, setDerivedValue] = useState();
useEffect(() => {
  setDerivedValue(computeValue(someState));
}, [someState]);

// Good - derive directly
const derivedValue = computeValue(someState);
```

### State Management (XState)

1. **Client logic in the state machine** - All client-side logic (data transformations, side effects, async operations) belongs in the state machine, not in React components.

2. **Actors for async operations** - Use XState actors for WebSocket connections, keyboard handling, and other async concerns.

3. **Components subscribe to state** - Components read from the machine context and send events. They don't manage their own state for anything the machine should own.

```
State Machine (appMachine.ts)
    └── Actors (tmuxActor.ts, keyboardActor.ts)
            └── Components (Terminal.tsx, StatusBar.tsx)
```

## Architecture

### Tmux Control Mode (Critical)

**All tmux commands must go through the control mode stdin connection**, not via external subprocess calls. Running external `tmux` commands while control mode is attached crashes tmux 3.3a.

See [tmux Control Mode documentation](https://github.com/tmux/tmux/wiki/Control-Mode).

```rust
// Commands are routed through the monitor's control mode connection
send_via_control_mode(state, session, "neww -t session").await;
```

Use short command forms: `neww`, `splitw`, `selectp`, `killp`, `resizep`, etc.

### Tmux Command Execution

Use `run_tmux_command` for all tmux operations. Don't create specific handlers for each command.

```typescript
// Good
await invoke('run_tmux_command', { command: 'swap-pane -s %0 -t %1' });

// Bad - redundant wrapper
await invoke('swap_panes', { sourceId: '%0', targetId: '%1' });
```

Exceptions:
- Commands needing output parsing (`get_all_panes_info`)
- Commands needing session targeting (`execute_prefix_binding`)
- High-frequency commands (`send_keys`)

### WebSocket API

```typescript
// Client sends
{ "type": "invoke", "id": "uuid", "cmd": "command_name", "args": {...} }

// Server responds
{ "type": "response", "id": "uuid", "result": ... }
{ "type": "error", "id": "uuid", "error": "message" }

// Server pushes state
{ "type": "event", "name": "tmux-state-changed", "payload": {...} }
```

### UI Components

- `Terminal.tsx` - Renders ANSI terminal content
- `PaneHeader.tsx` - Draggable pane header with close button
- `PaneLayout.tsx` - Grid layout for multiple panes
- `StatusBar.tsx` - Window tabs and tmux menu dropdown
- `RichContent.tsx` - Image protocol rendering (iTerm2/Kitty)

### E2E Tests

Tests use `TmuxTestSession` class via `ctx.session`:

```javascript
// ctx.session is created automatically in beforeEach
expect(ctx.session.getPaneCount()).toBe(1);
await splitPaneKeyboard(ctx.page, 'horizontal');
expect(ctx.session.getPaneCount()).toBe(2);
```

Test files are grouped by operation: `pane-split.test.js`, `pane-navigate.test.js`, etc.

## Git

### Commit Messages

Use [gitmoji](https://gitmoji.dev/) standards for commit messages. The first line should be a short summary with a gitmoji prefix. If the commit is related to an issue, add the issue number at the end of the first line.

```
🐛 Fix pane resize crash on split (#1234)

Additional details about the change go here.
Multi-line descriptions are welcome for context.
```

Common gitmojis:

| Emoji | Code | Description |
|-------|------|-------------|
| ✨ | `:sparkles:` | New feature |
| 🐛 | `:bug:` | Bug fix |
| ♻️ | `:recycle:` | Refactor |
| 🎨 | `:art:` | Improve structure/format |
| ⚡ | `:zap:` | Performance improvement |
| 🔥 | `:fire:` | Remove code or files |
| 🩹 | `:adhesive_bandage:` | Simple fix for a non-critical issue |
| ✅ | `:white_check_mark:` | Add or update tests |
| 📝 | `:memo:` | Documentation |
| 🔧 | `:wrench:` | Configuration files |
| 🏗️ | `:building_construction:` | Architectural changes |
