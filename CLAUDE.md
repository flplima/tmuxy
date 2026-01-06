# Tmuxy

A web-based tmux interface built with React (Vite) frontend and Rust backend.

## Project Structure

```
tmuxy/
├── packages/
│   ├── tmuxy-core/      # Core Rust library for tmux interaction
│   ├── tmuxy-ui/        # React/Vite frontend
│   ├── web-server/      # Axum web server with Vite integration
│   └── tauri-app/       # Tauri desktop app wrapper
```

## Development

### Web Server (Browser)

```bash
# Start dev server (Rust backend + Vite HMR on single port)
npm run web:dev

# Opens at http://localhost:3853
# - WebSocket at /ws (tmux communication)
# - Vite HMR proxied for hot reload
```

### Tauri App (Desktop)

```bash
npm run tauri:dev
```

## Production Build

### Web Server

```bash
# Build frontend + backend
npm run web:build

# Run production server (serves static files from dist/)
npm run web:start
```

### Tauri App

```bash
npm run tauri:build
```

## Testing

```bash
npm test
```

## Architecture Guidelines

### Tmux Command Execution

**Use `run_tmux_command` for all tmux operations.** Do not create specific Rust functions or WebSocket handlers for individual tmux commands.

The `run_tmux_command` WebSocket command accepts any tmux command string and executes it directly. This avoids redundant wrapper functions.

```typescript
// Good - use run_tmux_command directly
await invoke('run_tmux_command', { command: 'swap-pane -s %0 -t %1' });
await invoke('run_tmux_command', { command: 'join-pane -s %0 -t %1 -h' });
await invoke('run_tmux_command', { command: 'resize-pane -t %0 -L 5' });

// Bad - don't create specific handlers for each tmux command
await invoke('swap_panes', { sourceId: '%0', targetId: '%1' });  // Redundant
await invoke('join_pane', { ... });  // Redundant
```

Exceptions where specific handlers make sense:
- Commands that need special processing of output (e.g., `get_all_panes_info` parses structured data)
- Commands that need session targeting logic (e.g., `execute_prefix_binding`)
- High-frequency commands where the extra API ergonomics help (e.g., `send_keys`)

### WebSocket API

The frontend communicates with the backend via WebSocket at `/ws`. Messages use JSON with an invoke/response pattern:

```typescript
// Client sends
{ "type": "invoke", "id": "uuid", "cmd": "command_name", "args": {...} }

// Server responds
{ "type": "response", "id": "uuid", "result": ... }
// or
{ "type": "error", "id": "uuid", "error": "message" }

// Server pushes state changes
{ "type": "event", "name": "tmux-state-changed", "payload": {...} }
```

### UI Components

- `Terminal.tsx` - Renders ANSI terminal content
- `PaneHeader.tsx` - Draggable pane header with close button
- `PaneGrid.tsx` - Grid layout for multiple panes
- `StatusBar.tsx` - Window tabs and tmux menu dropdown

### State Management

Located in `src/tmux/`:
- `types.ts` - TmuxPane, TmuxWindow, TmuxState interfaces
- `tmux.ts` - Tmux class with state management and methods
- `adapters.ts` - WebSocketAdapter (browser) and TauriAdapter (desktop)
- `context.tsx` - TmuxProvider React context
- `hooks.ts` - useTmux(), useTmuxSelector(), useKeyboardHandler()

Tmux state is polled every 100ms by the backend and pushed to clients via WebSocket events. Components use `useTmuxSelector` hook to subscribe to specific state slices.
