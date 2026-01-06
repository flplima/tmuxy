# tmux-wrapper

A Tauri desktop application that wraps a tmux session and provides a terminal interface through a React UI.

## Features

- **tmux Integration**: Automatically creates or attaches to a tmux session named "tmux-wrapper"
- **Real-time Updates**: Monitors tmux state changes and updates the UI in real-time
- **Keyboard Support**: Full keyboard input support for interacting with the tmux session
- **Professional Terminal Emulator**: Uses xterm.js for full VT100/xterm-compatible terminal emulation
- **Scrollback Buffer**: Access full terminal history (10,000 lines) with scroll wheel support
- **Mouse Support**: Selection, copy/paste, and scroll wheel navigation
- **Clickable Links**: URLs in terminal output are automatically detected and clickable

## Prerequisites

- **tmux**: Must be installed and available in PATH
  ```bash
  # Ubuntu/Debian
  sudo apt-get install tmux

  # macOS
  brew install tmux

  # Fedora/RHEL
  sudo dnf install tmux
  ```

- **Node.js**: Version 18 or higher
- **Rust**: Latest stable version
- **npm** or **yarn**: For package management

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd tmux-wrapper
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Development

Start the development server:

```bash
npm run tauri:dev
```

This will:
1. Start the Vite development server for the React frontend
2. Build and run the Tauri application
3. Automatically create or attach to a tmux session named "tmux-wrapper"

## Testing

### Frontend Tests

Run frontend tests with Vitest:

```bash
npm run test
```

Run tests in watch mode:

```bash
npm run test -- --watch
```

Run tests with UI:

```bash
npm run test -- --ui
```

### Backend Tests

Run Rust tests:

```bash
cd src-tauri
cargo test
```

Run integration tests (requires tmux installed):

```bash
cd src-tauri
cargo test -- --ignored
```

## Building

Build the application for production:

```bash
npm run tauri:build
```

This creates platform-specific installers in `src-tauri/target/release/bundle/`

## Architecture

```
┌─────────────────────────────────────┐
│      React Frontend (Vite)          │
│  ┌───────────────────────────────┐  │
│  │  Terminal Renderer Component  │  │
│  │  - Display tmux output        │  │
│  │  - Handle keyboard input      │  │
│  └───────────────────────────────┘  │
│              ↕ IPC                  │
└─────────────────────────────────────┘
                 ↕
         Tauri Event System
         (Commands & Events)
                 ↕
┌─────────────────────────────────────┐
│       Rust Backend (Tauri)          │
│  ┌───────────────────────────────┐  │
│  │  tmux Session Manager         │  │
│  │  - Create/attach session      │  │
│  │  - Monitor state (polling)    │  │
│  │  - Send keys to tmux          │  │
│  │  - Capture pane content       │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
                 ↕
┌─────────────────────────────────────┐
│      tmux Session                   │
│      (Session: "tmux-wrapper")      │
│  ┌───────────────────────────────┐  │
│  │  Single Window, Single Pane   │  │
│  │  - Running bash/shell         │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

## Project Structure

```
tmux-wrapper/
├── src/                      # React frontend
│   ├── App.tsx              # Main component
│   ├── components/          # React components
│   │   └── Terminal.tsx     # Terminal renderer
│   ├── hooks/               # Custom hooks
│   │   ├── useTauriEvents.ts
│   │   └── useKeyboardHandler.ts
│   ├── types/               # TypeScript types
│   └── test/                # Frontend tests
├── src-tauri/               # Rust backend
│   ├── src/
│   │   ├── main.rs         # Application entry
│   │   ├── commands.rs     # Tauri commands
│   │   └── tmux/           # tmux integration
│   │       ├── session.rs  # Session management
│   │       ├── executor.rs # Command execution
│   │       └── monitor.rs  # State monitoring
│   ├── Cargo.toml
│   └── tauri.conf.json
├── TAURI_RESEARCH.md        # Tauri documentation research
├── REACT_RESEARCH.md        # React/Vite research
├── TMUX_RESEARCH.md         # tmux research
├── PLAN.md                  # Implementation plan
└── README.md
```

## How It Works

1. **Initialization**: On startup, the Tauri backend creates or attaches to a tmux session named "tmux-wrapper"

2. **Monitoring**: A background task polls the tmux session every 100ms to capture state changes

3. **State Updates**: When changes are detected, the backend emits events to the frontend with the new state

4. **Rendering**: The React frontend receives state updates and renders the terminal content with ANSI formatting

5. **Keyboard Input**: The frontend captures keyboard events and sends them to the backend via IPC commands

6. **Command Execution**: The backend forwards keyboard input to tmux using `tmux send-keys`

## Known Limitations

- **Polling-based**: Uses polling (100ms interval) instead of true event-driven updates
- **Single Pane**: No split panes or multiple windows support

## Future Enhancements

See [PLAN.md](./PLAN.md) for detailed future enhancements including:
- ~~Mouse support~~ ✅ **Implemented**
- ~~Full terminal emulator (xterm.js)~~ ✅ **Implemented**
- ~~Scrollback buffer~~ ✅ **Implemented**
- Multiple panes/windows
- Configuration UI
- Performance optimizations (adaptive polling, channels)

## Research Documentation

- [TAURI_RESEARCH.md](./TAURI_RESEARCH.md) - Detailed Tauri IPC, commands, events, testing
- [REACT_RESEARCH.md](./REACT_RESEARCH.md) - React/Vite/Vitest setup and testing strategies
- [TMUX_RESEARCH.md](./TMUX_RESEARCH.md) - tmux scripting, hooks, monitoring approaches
- [PLAN.md](./PLAN.md) - Complete implementation plan and architecture

## License

ISC

## Contributing

Contributions are welcome! Please read the implementation plan and research documents before contributing.
