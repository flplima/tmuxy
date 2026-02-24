# tmuxy Project Status

## Summary

Tmuxy is a tmux terminal wrapper available as both:
- **Tauri desktop app** - Native desktop application
- **Web server** - Accessible via Chrome browser

## Project Structure

```
tmuxy/
├── Cargo.toml                       # Workspace root
├── package.json                     # Frontend package config
├── src/                             # React frontend
│   ├── App.tsx                      # Main component
│   ├── components/
│   │   └── Terminal.tsx             # xterm.js terminal
│   ├── hooks/
│   │   ├── useTauriEvents.ts        # Bridge event listener
│   │   └── useKeyboardHandler.ts    # Keyboard handling
│   └── lib/
│       └── bridge.ts                # Tauri/WebSocket abstraction
├── crates/
│   ├── tmuxy-core/                  # Shared tmux logic
│   │   └── src/
│   │       ├── lib.rs               # Types & capture_state
│   │       ├── session.rs           # Session management
│   │       └── executor.rs          # tmux command execution
│   ├── tauri-app/                   # Tauri desktop app
│   │   ├── tauri.conf.json
│   │   └── src/
│   │       ├── main.rs              # App entry
│   │       ├── commands.rs          # IPC commands
│   │       └── monitor.rs           # State monitoring
│   └── web-server/                  # Web server
│       └── src/
│           ├── main.rs              # HTTP server + static files
│           └── websocket.rs         # WebSocket handling
└── dist/                            # Built frontend (for web server)
```

## Running the App

### Desktop App (Tauri)
```bash
npm run tauri:dev    # Development mode
npm run tauri:build  # Build for production
```

### Web Server (Chrome access)
```bash
npm run web:dev      # Build frontend + start server
# Then open http://localhost:3853 in Chrome
```

## Features

- Full terminal emulation via xterm.js
- Real-time tmux output (100ms polling)
- Keyboard input forwarding to tmux
- Scrollback history (10k lines)
- Works in both Tauri and browser environments

## Architecture

### Frontend Bridge
The `src/lib/bridge.ts` provides a unified API that:
- Detects runtime environment (`window.__TAURI__`)
- Uses Tauri IPC in desktop mode
- Uses WebSocket in browser mode

### WebSocket Protocol
```json
// Client → Server
{ "type": "invoke", "id": "uuid", "cmd": "send_keys_to_tmux", "args": { "keys": "ls\n" } }

// Server → Client (response)
{ "type": "response", "id": "uuid", "result": {...} }

// Server → Client (event)
{ "type": "event", "name": "tmux-state-changed", "payload": {...} }
```

## Port Configuration

- **Tauri dev**: Port 1420 (Vite dev server)
- **Web server**: Port 3853 (generated from "tmuxy")

## Requirements

- tmux installed on system
- Node.js 18+
- Rust 1.70+
