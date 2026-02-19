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

See [tmux Control Mode documentation](https://github.com/tmux/tmux/wiki/Control-Mode) and [.agents/learnings/2026_02_09_tmux_control_mode.md](.agents/learnings/2026_02_09_tmux_control_mode.md).

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

## Browser Testing

**ALWAYS use `agent-browser` with CDP on port 9222 for manual browser testing.**

```bash
# First, connect to existing Chrome instance (sets default CDP target)
agent-browser connect 9222

# Now all commands work without --cdp flag
agent-browser open http://localhost:3853
agent-browser snapshot -i
agent-browser click @e1
```

**IMPORTANT:**
- **Prefer snapshots over screenshots** - Screenshots consume many tokens. Use `snapshot -i` to get interactive element refs.
- **Always compress screenshots** - When screenshots are needed, pipe through `compress-image.js` to reduce tokens:
  ```bash
  agent-browser screenshot 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -oP '/[^\s]+\.png' | xargs node /workspace/scripts/compress-image.js
  ```
  Then read the `.compressed.jpg` file from the output. This resizes to 800px wide and compresses to JPEG quality 70.
- If agent-browser fails or errors occur, report the error to the user. DO NOT use Playwright scripts, Puppeteer, or any other alternative to test the browser manually. The user will handle browser testing issues.

## Debugging with agent-browser

In dev mode, the following globals are available:

| Global | Purpose |
|--------|---------|
| `window.app` | XState actor - `send()`, `getSnapshot()`, `subscribe()` |
| `window.getSnapshot()` | Build UI snapshot (pane content rendered to text grid) |
| `window.getTmuxSnapshot()` | Fetch tmux snapshot from server API |

Use `agent-browser eval` to inject debugging scripts.

### Subscribing to Machine Events

Store machine events in a global array for later analysis:

```bash
# Subscribe to all machine events
agent-browser eval "
  window.machineEvents = [];
  window.app.subscribe((snapshot) => {
    window.machineEvents.push({
      ts: Date.now(),
      state: snapshot.value,
      context: { activePaneId: snapshot.context.activePaneId }
    });
    if (window.machineEvents.length > 200) window.machineEvents.shift();
  });
"

# Later, fetch the captured events
agent-browser eval "JSON.stringify(window.machineEvents.slice(-20), null, 2)"
```

### Tracking DOM Changes with MutationObserver

Inject a MutationObserver to track class changes (useful for debugging CSS state issues):

```bash
# Track class changes on pane headers
agent-browser eval "
  window.domChanges = [];
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      if (m.attributeName === 'class') {
        window.domChanges.push({
          ts: Date.now(),
          target: m.target.className,
          element: m.target.tagName
        });
      }
    });
  });
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
"

# Fetch DOM changes
agent-browser eval "JSON.stringify(window.domChanges.slice(-30), null, 2)"
```

### Polling State at High Frequency

For timing-sensitive bugs, poll state at short intervals:

```bash
# Poll pane header state every 5ms
agent-browser eval "
  window.headerStates = [];
  const poll = setInterval(() => {
    const headers = document.querySelectorAll('.pane-header');
    window.headerStates.push({
      ts: Date.now(),
      headers: Array.from(headers).map(h => ({
        classes: h.className,
        text: h.textContent.slice(0, 30)
      }))
    });
    if (window.headerStates.length > 500) clearInterval(poll);
  }, 5);
"

# Stop polling and fetch results
agent-browser eval "JSON.stringify(window.headerStates, null, 2)"
```

### Direct Machine State Access

```bash
# Get current machine state
agent-browser eval "window.app.getSnapshot().value"

# Get specific context values
agent-browser eval "JSON.stringify(window.app.getSnapshot().context.groups)"

# Send events to machine
agent-browser eval "window.app.send({ type: 'FOCUS_PANE', paneId: '%0' })"
```

### IndexedDB Event Log

Events are also stored in IndexedDB (`tmuxy-events` database) for persistence across page reloads. Access via DevTools > Application > IndexedDB.
