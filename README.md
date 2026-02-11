# Tmuxy

A web-based tmux interface with React frontend and Rust backend. Available as a web application or Tauri desktop app.

## Features

- **Multi-pane support**: Split panes horizontally/vertically, navigate, resize, zoom
- **Multi-window support**: Create, switch, and manage multiple tmux windows
- **Real-time updates**: Tmux state polled every 100ms and pushed via WebSocket
- **Keyboard shortcuts**: Full tmux keybinding support (Ctrl+a prefix)
- **Rich content**: iTerm2 and Kitty image protocol support
- **Dual deployment**: Run as web server or native Tauri desktop app

## Project Structure

```
tmuxy/
├── packages/
│   ├── tmuxy-core/      # Core Rust library for tmux interaction
│   ├── tmuxy-ui/        # React/Vite frontend (XState state management)
│   ├── web-server/      # Axum web server with WebSocket + Vite proxy
│   └── tauri-app/       # Tauri desktop app wrapper
├── tests/               # E2E tests (Jest + Puppeteer)
│   ├── helpers/         # Test utilities
│   └── *.test.js        # Test suites by operation
└── docker/              # Docker development environment
```

## Docker Development

The dev container runs an interactive bash shell with output logged to `/var/log/shell.log`. View logs with:

```bash
docker logs -f tmuxy-dev
```

## Prerequisites

- **tmux**: Must be installed and available in PATH
- **Node.js**: Version 18+
- **Rust**: Latest stable
- **Chrome/Chromium**: For E2E tests (CDP on port 9222)

## Development

### Web Server (Browser)

```bash
# Start dev server (Rust backend + Vite HMR on single port)
npm run web:dev

# Opens at http://localhost:3853
# - WebSocket at /ws
# - Vite HMR proxied for hot reload
```

#### Background Mode (pm2)

```bash
# Start dev server in background
npm run web:dev:start

# View logs
npm run web:dev:logs

# Stop server
npm run web:dev:stop

# Other pm2 commands
pm2 status          # List running processes
pm2 restart tmuxy-dev  # Restart the server
pm2 delete tmuxy-dev   # Remove from pm2
```

### Tauri App (Desktop)

```bash
npm run tauri:dev
```

## Production Build

### Web Server

```bash
npm run web:build   # Build frontend + backend
npm run web:start   # Run production server
```

### Tauri App

```bash
npm run tauri:build
```

## Testing

### Unit Tests (Vitest)

```bash
npm test
```

### E2E Tests (Jest + Puppeteer)

```bash
# Requires: web server running + Chrome with CDP on port 9222
npm run web:dev:start
google-chrome --remote-debugging-port=9222 &

npm run test:e2e

# View server logs if tests fail
npm run web:dev:logs
```

E2E test suites:
- `smoke.test.js` - Quick verification of all operations
- `pane-split.test.js` - Split operations
- `pane-navigate.test.js` - Navigation (arrow keys, vim-style, mouse)
- `pane-swap.test.js` - Swap pane positions
- `pane-zoom.test.js` - Zoom/unzoom panes
- `pane-resize.test.js` - Resize via divider drag
- `pane-close.test.js` - Kill/close panes
- `window-operations.test.js` - Window create/switch/select
- `layout.test.js` - Layout cycling
- `image-rendering.test.js` - iTerm2/Kitty image protocols

## Architecture

```
┌─────────────────────────────────────┐
│      React Frontend (Vite)          │
│  - XState for state management      │
│  - Terminal.tsx renders panes       │
│  - PaneLayout.tsx handles grid      │
│  - StatusBar.tsx for window tabs    │
└─────────────────────────────────────┘
                 ↕ WebSocket (/ws)
┌─────────────────────────────────────┐
│   Axum Web Server (web-server)      │
│  - Proxies Vite in dev mode         │
│  - Serves static files in prod      │
│  - WebSocket handler                │
└─────────────────────────────────────┘
                 ↕
┌─────────────────────────────────────┐
│   tmuxy-core (Rust library)         │
│  - Control mode connection          │
│  - State monitoring (100ms poll)    │
│  - Command execution                │
└─────────────────────────────────────┘
                 ↕
┌─────────────────────────────────────┐
│         tmux session                │
└─────────────────────────────────────┘
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+a "` | Split horizontal |
| `Ctrl+a %` | Split vertical |
| `Ctrl+a Arrow` | Navigate panes |
| `Ctrl+a z` | Toggle zoom |
| `Ctrl+a x` | Kill pane |
| `Ctrl+a c` | New window |
| `Ctrl+a n/p` | Next/prev window |
| `Ctrl+a 0-9` | Select window |
| `Ctrl+a Space` | Cycle layouts |
| `Ctrl+a {/}` | Swap pane up/down |

## License

ISC
