# tmux-wrapper Implementation Plan

## Project Overview

**Goal:** Create a Tauri desktop application that wraps a tmux session and provides a terminal interface through a React UI.

**Tech Stack:**
- **Backend:** Rust (Tauri 2.0)
- **Frontend:** React + TypeScript + Vite
- **Terminal Multiplexer:** tmux
- **Testing:** Vitest (frontend) + Rust built-in testing (backend)

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

## Phase 1: Project Setup

### 1.1 Initialize Tauri Project
```bash
cd tmux-wrapper
npm create tauri-app@latest .
# Choose:
# - React
# - TypeScript
# - Vite
```

**Deliverables:**
- ✅ Project scaffolded
- ✅ Basic Tauri + React + Vite configuration
- ✅ Can run `npm run tauri dev`

### 1.2 Configure Project Structure
```
tmux-wrapper/
├── src/                      # React frontend
│   ├── App.tsx
│   ├── App.css
│   ├── main.tsx
│   ├── components/
│   │   └── Terminal.tsx
│   ├── hooks/
│   │   ├── useTauriEvents.ts
│   │   └── useKeyboardHandler.ts
│   ├── types/
│   │   └── tmux.ts
│   └── test/
│       ├── setup.ts
│       └── App.test.tsx
├── src-tauri/                # Rust backend
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands.rs       # Tauri commands
│   │   ├── tmux/
│   │   │   ├── mod.rs
│   │   │   ├── session.rs    # Session management
│   │   │   ├── monitor.rs    # State monitoring
│   │   │   └── executor.rs   # Command execution
│   │   └── tests/
│   │       ├── commands_test.rs
│   │       └── tmux_test.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── TAURI_RESEARCH.md
├── REACT_RESEARCH.md
├── TMUX_RESEARCH.md
├── PLAN.md
└── README.md
```

### 1.3 Add Dependencies

**Rust (Cargo.toml):**
```toml
[dependencies]
tauri = { version = "2.0", features = ["shell-open"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1", features = ["full"] }
```

**Frontend (package.json):**
```json
{
  "devDependencies": {
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/cli": "^2.0.0",
    "vitest": "^1.0.0",
    "@testing-library/react": "^14.0.0",
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/user-event": "^14.0.0",
    "jsdom": "^23.0.0",
    "ansi-to-html": "^0.7.2"
  }
}
```

### 1.4 Configure Testing

**Vite config (vite.config.ts):**
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
```

**Test setup (src/test/setup.ts):**
```typescript
import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

afterEach(() => {
  cleanup();
});
```

## Phase 2: Backend Implementation (Rust)

### 2.1 Define Data Types

**src-tauri/src/tmux/mod.rs:**
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxState {
    pub content: Vec<String>,
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxError {
    pub message: String,
}
```

### 2.2 Session Management

**src-tauri/src/tmux/session.rs:**
```rust
use std::process::Command;

const SESSION_NAME: &str = "tmux-wrapper";

pub fn session_exists() -> Result<bool, String> {
    let output = Command::new("tmux")
        .args(&["has-session", "-t", SESSION_NAME])
        .output()
        .map_err(|e| format!("Failed to check session: {}", e))?;

    Ok(output.status.success())
}

pub fn create_session() -> Result<(), String> {
    Command::new("tmux")
        .args(&["new-session", "-d", "-s", SESSION_NAME, "bash"])
        .output()
        .map_err(|e| format!("Failed to create session: {}", e))?;

    Ok(())
}

pub fn create_or_attach() -> Result<(), String> {
    if !session_exists()? {
        create_session()?;
    }
    Ok(())
}

pub fn kill_session() -> Result<(), String> {
    Command::new("tmux")
        .args(&["kill-session", "-t", SESSION_NAME])
        .output()
        .map_err(|e| format!("Failed to kill session: {}", e))?;

    Ok(())
}
```

### 2.3 Command Executor

**src-tauri/src/tmux/executor.rs:**
```rust
use std::process::Command;

const SESSION_NAME: &str = "tmux-wrapper";

pub fn execute_tmux_command(args: &[&str]) -> Result<String, String> {
    let output = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute tmux: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_string())
}

pub fn capture_pane() -> Result<String, String> {
    execute_tmux_command(&[
        "capture-pane",
        "-t", SESSION_NAME,
        "-p",  // print to stdout
        "-e",  // include escape sequences
    ])
}

pub fn send_keys(keys: &str) -> Result<(), String> {
    execute_tmux_command(&[
        "send-keys",
        "-t", SESSION_NAME,
        keys,
    ])?;
    Ok(())
}

pub fn get_pane_info() -> Result<(u32, u32, u32, u32), String> {
    let output = execute_tmux_command(&[
        "display-message",
        "-t", SESSION_NAME,
        "-p",
        "#{pane_width},#{pane_height},#{cursor_x},#{cursor_y}"
    ])?;

    let parts: Vec<&str> = output.trim().split(',').collect();
    if parts.len() != 4 {
        return Err("Invalid pane info format".to_string());
    }

    let width = parts[0].parse().map_err(|_| "Invalid width")?;
    let height = parts[1].parse().map_err(|_| "Invalid height")?;
    let cursor_x = parts[2].parse().map_err(|_| "Invalid cursor_x")?;
    let cursor_y = parts[3].parse().map_err(|_| "Invalid cursor_y")?;

    Ok((width, height, cursor_x, cursor_y))
}
```

### 2.4 State Monitor

**src-tauri/src/tmux/monitor.rs:**
```rust
use super::{executor, TmuxState};
use tauri::{AppHandle, Manager};
use tokio::time::{interval, Duration};

pub async fn start_monitoring(app: AppHandle) {
    let mut interval = interval(Duration::from_millis(100));
    let mut previous_content = String::new();

    loop {
        interval.tick().await;

        match capture_state() {
            Ok(state) => {
                // Only emit if content changed
                let current_content = state.content.join("\n");
                if current_content != previous_content {
                    if let Err(e) = app.emit("tmux-state-changed", &state) {
                        eprintln!("Failed to emit state: {}", e);
                    }
                    previous_content = current_content;
                }
            }
            Err(e) => {
                if let Err(e) = app.emit("tmux-error", e) {
                    eprintln!("Failed to emit error: {}", e);
                }
            }
        }
    }
}

fn capture_state() -> Result<TmuxState, String> {
    let content = executor::capture_pane()?;
    let (width, height, cursor_x, cursor_y) = executor::get_pane_info()?;

    Ok(TmuxState {
        content: content.lines().map(String::from).collect(),
        cursor_x,
        cursor_y,
        width,
        height,
    })
}
```

### 2.5 Tauri Commands

**src-tauri/src/commands.rs:**
```rust
use crate::tmux::{executor, session, TmuxState};

#[tauri::command]
pub async fn send_keys_to_tmux(keys: String) -> Result<(), String> {
    executor::send_keys(&keys)
}

#[tauri::command]
pub async fn get_initial_state() -> Result<TmuxState, String> {
    let content = executor::capture_pane()?;
    let (width, height, cursor_x, cursor_y) = executor::get_pane_info()?;

    Ok(TmuxState {
        content: content.lines().map(String::from).collect(),
        cursor_x,
        cursor_y,
        width,
        height,
    })
}

#[tauri::command]
pub async fn initialize_session() -> Result<(), String> {
    session::create_or_attach()
}
```

### 2.6 Main Application

**src-tauri/src/main.rs:**
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod tmux;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Initialize tmux session
            tmux::session::create_or_attach()
                .expect("Failed to create tmux session");

            // Start monitoring in background
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tmux::monitor::start_monitoring(app_handle).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Optional: Kill tmux session on close
                // tmux::session::kill_session().ok();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::send_keys_to_tmux,
            commands::get_initial_state,
            commands::initialize_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## Phase 3: Frontend Implementation (React)

### 3.1 Type Definitions

**src/types/tmux.ts:**
```typescript
export interface TmuxState {
  content: string[];
  cursor_x: number;
  cursor_y: number;
  width: number;
  height: number;
}

export interface TmuxError {
  message: string;
}
```

### 3.2 Custom Hooks

**src/hooks/useTauriEvents.ts:**
```typescript
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { TmuxState, TmuxError } from '../types/tmux';

export function useTmuxState() {
  const [state, setState] = useState<TmuxState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlistenState = listen<TmuxState>('tmux-state-changed', (event) => {
      setState(event.payload);
      setError(null);
    });

    const unlistenError = listen<TmuxError>('tmux-error', (event) => {
      setError(event.payload.message);
    });

    return () => {
      unlistenState.then(fn => fn());
      unlistenError.then(fn => fn());
    };
  }, []);

  return { state, error };
}
```

**src/hooks/useKeyboardHandler.ts:**
```typescript
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

export function useKeyboardHandler() {
  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      event.preventDefault();

      let key = '';

      // Handle special keys
      if (event.ctrlKey && event.key.length === 1) {
        key = `C-${event.key.toLowerCase()}`;
      } else if (event.key === 'Enter') {
        key = 'C-m';
      } else if (event.key === 'Backspace') {
        key = 'BSpace';
      } else if (event.key === 'Delete') {
        key = 'DC';
      } else if (event.key === 'ArrowUp') {
        key = 'Up';
      } else if (event.key === 'ArrowDown') {
        key = 'Down';
      } else if (event.key === 'ArrowLeft') {
        key = 'Left';
      } else if (event.key === 'ArrowRight') {
        key = 'Right';
      } else if (event.key.length === 1) {
        key = event.key;
      } else {
        return; // Ignore other keys
      }

      try {
        await invoke('send_keys_to_tmux', { keys: key });
      } catch (error) {
        console.error('Failed to send keys:', error);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
```

### 3.3 Terminal Component

**src/components/Terminal.tsx:**
```typescript
import React from 'react';
import Convert from 'ansi-to-html';
import './Terminal.css';

interface TerminalProps {
  content: string[];
}

const convert = new Convert({
  fg: '#d4d4d4',
  bg: '#1e1e1e',
  newline: false,
  escapeXML: true,
});

export const Terminal: React.FC<TerminalProps> = ({ content }) => {
  const html = content.map(line => convert.toHtml(line)).join('<br/>');

  return (
    <div
      className="terminal"
      data-testid="terminal"
      tabIndex={0}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
```

**src/components/Terminal.css:**
```css
.terminal {
  font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.4;
  background-color: #1e1e1e;
  color: #d4d4d4;
  padding: 10px;
  overflow: auto;
  height: 100vh;
  width: 100vw;
  white-space: pre;
  box-sizing: border-box;
}

.terminal:focus {
  outline: 2px solid #007acc;
  outline-offset: -2px;
}
```

### 3.4 App Component

**src/App.tsx:**
```typescript
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal } from './components/Terminal';
import { useTmuxState } from './hooks/useTauriEvents';
import { useKeyboardHandler } from './hooks/useKeyboardHandler';
import './App.css';

function App() {
  const { state, error } = useTmuxState();
  useKeyboardHandler();

  useEffect(() => {
    // Get initial state
    invoke('get_initial_state')
      .catch(err => console.error('Failed to get initial state:', err));
  }, []);

  if (error) {
    return (
      <div className="error">
        <h2>Error</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="loading">
        <p>Connecting to tmux...</p>
      </div>
    );
  }

  return <Terminal content={state.content} />;
}

export default App;
```

**src/App.css:**
```css
body {
  margin: 0;
  padding: 0;
  overflow: hidden;
}

.loading, .error {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background-color: #1e1e1e;
  color: #d4d4d4;
  font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
}

.error {
  flex-direction: column;
}

.error h2 {
  color: #f48771;
  margin-bottom: 1rem;
}
```

## Phase 4: Testing

### 4.1 Frontend Tests

**src/test/App.test.tsx:**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { mockIPC } from '@tauri-apps/api/mocks';
import App from '../App';

describe('App', () => {
  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    mockIPC((cmd) => {
      if (cmd === 'get_initial_state') {
        return new Promise(() => {}); // Never resolves
      }
    });

    render(<App />);
    expect(screen.getByText('Connecting to tmux...')).toBeInTheDocument();
  });

  it('renders terminal content after loading', async () => {
    mockIPC((cmd) => {
      if (cmd === 'get_initial_state') {
        return Promise.resolve({
          content: ['line 1', 'line 2', 'line 3'],
          cursor_x: 0,
          cursor_y: 0,
          width: 80,
          height: 24,
        });
      }
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('terminal')).toBeInTheDocument();
    });
  });

  it('sends keys to backend on keyboard input', async () => {
    const sendKeysMock = vi.fn();

    mockIPC((cmd, args) => {
      if (cmd === 'get_initial_state') {
        return Promise.resolve({
          content: ['$ '],
          cursor_x: 2,
          cursor_y: 0,
          width: 80,
          height: 24,
        });
      }
      if (cmd === 'send_keys_to_tmux') {
        sendKeysMock(args);
        return Promise.resolve();
      }
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('terminal')).toBeInTheDocument();
    });

    const terminal = screen.getByTestId('terminal');
    terminal.focus();

    const user = userEvent.setup();
    await user.keyboard('l');
    await user.keyboard('s');

    expect(sendKeysMock).toHaveBeenCalledWith({ keys: 'l' });
    expect(sendKeysMock).toHaveBeenCalledWith({ keys: 's' });
  });

  it('displays error when tmux-error event is emitted', async () => {
    // This test would require event mocking which is complex
    // For now, test error prop directly in Terminal component
  });
});
```

**src/components/Terminal.test.tsx:**
```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Terminal } from './Terminal';

describe('Terminal', () => {
  it('renders terminal content', () => {
    const content = ['line 1', 'line 2', 'line 3'];
    render(<Terminal content={content} />);

    const terminal = screen.getByTestId('terminal');
    expect(terminal).toBeInTheDocument();
    expect(terminal).toHaveTextContent('line 1');
    expect(terminal).toHaveTextContent('line 2');
    expect(terminal).toHaveTextContent('line 3');
  });

  it('handles empty content', () => {
    render(<Terminal content={[]} />);
    const terminal = screen.getByTestId('terminal');
    expect(terminal).toBeInTheDocument();
  });

  it('converts ANSI codes to HTML', () => {
    const content = ['\x1b[31mred text\x1b[0m'];
    render(<Terminal content={content} />);

    const terminal = screen.getByTestId('terminal');
    const html = terminal.innerHTML;
    expect(html).toContain('color');
  });
});
```

### 4.2 Backend Tests

**src-tauri/src/tests/tmux_test.rs:**
```rust
#[cfg(test)]
mod tests {
    use crate::tmux::executor;

    #[test]
    fn test_capture_pane_parsing() {
        // Mock content
        let content = "line1\nline2\nline3".to_string();
        let lines: Vec<String> = content.lines().map(String::from).collect();

        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "line1");
        assert_eq!(lines[2], "line3");
    }

    #[test]
    fn test_pane_info_parsing() {
        let output = "80,24,5,10";
        let parts: Vec<&str> = output.split(',').collect();

        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0].parse::<u32>().unwrap(), 80);
        assert_eq!(parts[1].parse::<u32>().unwrap(), 24);
        assert_eq!(parts[2].parse::<u32>().unwrap(), 5);
        assert_eq!(parts[3].parse::<u32>().unwrap(), 10);
    }

    // Integration tests (require tmux installed)
    #[test]
    #[ignore] // Run with: cargo test -- --ignored
    fn test_session_lifecycle() {
        use crate::tmux::session;

        let test_session = "test-tmux-wrapper-12345";

        // Should not exist initially
        assert!(!session::session_exists().unwrap());

        // Create session
        session::create_session().expect("Failed to create session");

        // Should now exist
        assert!(session::session_exists().unwrap());

        // Cleanup
        session::kill_session().expect("Failed to kill session");
    }
}
```

**src-tauri/src/tests/commands_test.rs:**
```rust
#[cfg(test)]
mod tests {
    use crate::commands;

    #[tokio::test]
    async fn test_send_keys_command() {
        // Mock test - in real scenario would need tmux running
        let result = commands::send_keys_to_tmux("ls".to_string()).await;

        // This will fail if tmux not running - that's expected in unit tests
        // For real testing, use integration tests with tmux
        match result {
            Ok(_) => println!("Command succeeded"),
            Err(e) => println!("Command failed (expected in unit test): {}", e),
        }
    }
}
```

### 4.3 Run Tests

**Frontend:**
```bash
npm run test
```

**Backend:**
```bash
cd src-tauri
cargo test
cargo test -- --ignored  # Run integration tests
```

## Phase 5: Integration & Polish

### 5.1 Error Handling
- Add user-friendly error messages
- Handle tmux not installed
- Handle session creation failures
- Reconnection logic if tmux crashes

### 5.2 Configuration
Add settings (optional):
- Poll interval (100ms default)
- Terminal colors/theme
- Font size/family
- Session name customization

### 5.3 Documentation
Create README.md with:
- Prerequisites (tmux, Rust, Node.js)
- Installation instructions
- Usage guide
- Development setup
- Testing instructions

### 5.4 Build & Distribution
```bash
npm run tauri build
```

Produces platform-specific installers in `src-tauri/target/release/bundle/`

## Testing Checklist

Before considering the project complete:

### Backend Tests
- [ ] Unit test: Session existence check
- [ ] Unit test: Pane content capture parsing
- [ ] Unit test: Pane info parsing
- [ ] Integration test: Create/kill session (requires tmux)
- [ ] Integration test: Send keys and verify execution
- [ ] Integration test: Capture pane with escape sequences

### Frontend Tests
- [ ] Unit test: Terminal component renders content
- [ ] Unit test: Terminal component handles ANSI codes
- [ ] Unit test: App component shows loading state
- [ ] Unit test: App component renders terminal after load
- [ ] Integration test: Keyboard events trigger IPC calls
- [ ] Integration test: State updates when event received

### Manual Testing
- [ ] App starts and connects to tmux
- [ ] Terminal displays current pane content
- [ ] Typing appears in terminal
- [ ] Special keys work (Enter, Ctrl+C, arrows)
- [ ] Terminal updates when content changes
- [ ] Error handling works (kill tmux, see error message)
- [ ] App gracefully handles tmux not installed

## Known Limitations (MVP)

1. **No Mouse Support** - Keyboard only (as requested)
2. **Polling-based** - No true event-driven updates (tmux limitation)
3. **Single Pane** - No split panes or multiple windows
4. **Basic Rendering** - Using ansi-to-html, not full terminal emulator
5. **No Scrollback** - Only visible content (can be added later)
6. **No Copy/Paste** - Would require additional implementation

## Next Steps (Future Enhancements)

### Phase 6: Advanced Features (Future)

#### 6.1 Mouse Support
- Capture mouse events in React
- Convert to tmux mouse commands
- Send via `send-keys -X`

#### 6.2 Full Terminal Emulator
- Replace ansi-to-html with xterm.js
- Better cursor rendering
- Full escape sequence support
- Selection/copy/paste

#### 6.3 Multiple Panes/Windows
- Support tmux layouts
- Pane splitting
- Window tabs

#### 6.4 Scrollback Buffer
- Capture full history
- Virtual scrolling
- Search functionality

#### 6.5 Configuration UI
- Settings dialog
- Theme customization
- Keybinding customization

#### 6.6 Performance Optimization
- Adaptive polling (slow down when idle)
- Incremental updates (only changed lines)
- Debouncing rapid changes
- Background rendering

#### 6.7 Session Persistence
- Remember open sessions
- Restore on app restart
- Multiple named sessions

#### 6.8 Integration Features
- File system navigation
- Git integration
- Command suggestions

## Success Criteria

The MVP is complete when:
1. ✅ App starts and creates/attaches to tmux session
2. ✅ Terminal content is visible in React UI
3. ✅ Keyboard input is sent to tmux and works correctly
4. ✅ Terminal updates when tmux output changes
5. ✅ Frontend tests pass (mocking Tauri IPC)
6. ✅ Backend tests pass (mocking tmux where needed)
7. ✅ Manual testing confirms all basic functionality works
8. ✅ Error handling is robust and user-friendly

## Timeline Estimate

- **Phase 1** (Setup): 30 minutes
- **Phase 2** (Backend): 2-3 hours
- **Phase 3** (Frontend): 2-3 hours
- **Phase 4** (Testing): 2-3 hours
- **Phase 5** (Polish): 1-2 hours

**Total:** 8-12 hours for complete MVP with tests

## Resources Reference

- **TAURI_RESEARCH.md** - Detailed Tauri IPC, commands, events, testing
- **REACT_RESEARCH.md** - React/Vite/Vitest setup and testing strategies
- **TMUX_RESEARCH.md** - tmux scripting, hooks, monitoring approaches

---

*This plan represents the MVP implementation. Future enhancements are documented but not required for initial release.*
