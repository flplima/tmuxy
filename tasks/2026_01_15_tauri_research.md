# Tauri Research for tmux-wrapper Project

## Overview
Tauri is a framework for building lightweight desktop applications using web technologies (HTML/CSS/JavaScript) for the frontend and Rust for the backend. Version 2.0 was released stable and includes significant improvements to IPC performance and capabilities.

## Key Resources
- Official Documentation: https://v2.tauri.app/
- IPC Documentation: https://v2.tauri.app/concept/inter-process-communication/
- Calling Rust: https://v2.tauri.app/develop/calling-rust/
- Testing: https://v2.tauri.app/develop/tests/

## Inter-Process Communication (IPC)

### Architecture
IPC in Tauri allows isolated processes to communicate securely. The frontend (webview) and backend (Rust) are separate processes that communicate through a secure channel.

### Commands
Commands are the primary way for the frontend to call Rust functions:

**Features:**
- Synchronous request/response pattern
- Type-safe (Rust types are serialized to JSON)
- Can access application state, windows, and return data
- Created with `#[tauri::command]` attribute
- Called from frontend using `invoke()` function

**Example Use Case:**
```rust
#[tauri::command]
fn send_keys_to_tmux(keys: String) -> Result<(), String> {
    // Send keys to tmux session
}
```

**Frontend:**
```javascript
import { invoke } from '@tauri-apps/api/core';
await invoke('send_keys_to_tmux', { keys: 'ls\n' });
```

### Events
Events are fire-and-forget, one-way IPC messages:

**Characteristics:**
- Asynchronous only
- Not type-safe
- Cannot return values
- Support JSON payloads only
- Can be emitted by both frontend and backend
- Best suited for lifecycle events and state changes

**Example Use Case:**
Backend emits event when tmux state changes:
```rust
app.emit("tmux-state-changed", TmuxState { ... })
```

Frontend listens:
```javascript
import { listen } from '@tauri-apps/api/event';
await listen('tmux-state-changed', (event) => {
    // Update UI with new tmux state
});
```

### Channels
Tauri 2.0 introduced `Channel` type for bidirectional streaming communication:

**Features:**
- Send multiple messages over time
- Useful for long-running operations
- Available in both Rust (`tauri::ipc::Channel`) and JS

**Example Use Case:**
Stream continuous tmux output updates to frontend.

### V2 IPC Improvements
- Uses custom protocols instead of string-based serialization
- More reminiscent of HTTP-based communication
- Significantly better performance than v1
- Added `tauri::ipc` module with IPC primitives

## Application for tmux-wrapper

### Commands We Need
1. `send_keys` - Send keyboard input to tmux session
2. `create_or_attach_session` - Initialize tmux session on startup
3. `get_initial_state` - Get current tmux pane content

### Events We Need
1. `tmux-state-changed` - Emitted when tmux pane content changes
2. `tmux-error` - Emitted when tmux operations fail

### Architecture Pattern
```
Frontend (React)
    ↓ invoke() commands
Backend (Rust)
    ↓ spawns & monitors
tmux session
    ↓ hooks trigger
Backend (Rust)
    ↓ emit() events
Frontend (React)
```

## Project Setup

### Create Tauri + Vite + React Project
```bash
npm create tauri-app@latest
# Choose:
# - React
# - TypeScript
# - Vite
```

### Configuration Files
1. `tauri.conf.json` - Tauri configuration
2. `vite.config.ts` - Vite configuration for frontend
3. `Cargo.toml` - Rust dependencies

### Key Dependencies (Rust)
- `tauri` - Core framework
- `serde` - Serialization/deserialization
- `tokio` - Async runtime for monitoring tmux

### Key Dependencies (Frontend)
- `@tauri-apps/api` - IPC functions (invoke, listen, emit)
- `@tauri-apps/plugin-shell` - If we need shell access

## Testing

### Backend Testing
- Tauri provides mock runtime for testing
- Use `#[cfg(test)]` modules
- Mock IPC with `tauri::test` (unstable feature)
- Write unit tests for individual commands
- Integration tests can use `tauri-testing` library

**Example:**
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_send_keys_command() {
        // Test logic
    }
}
```

### Frontend Testing
- Use `mockIPC` function to intercept IPC requests
- Works with any testing library (Vitest, Jest)
- Can simulate backend responses

**Example:**
```typescript
import { mockIPC } from '@tauri-apps/api/mocks';

mockIPC((cmd, args) => {
    if (cmd === 'send_keys_to_tmux') {
        return Promise.resolve();
    }
});
```

## State Management

### Rust State
- Use `tauri::State` for application-wide state
- Can store tmux session handle, configuration
- Thread-safe with `Arc<Mutex<T>>`

**Example:**
```rust
struct TmuxState {
    session_name: String,
    // ... other state
}

#[tauri::command]
fn get_state(state: tauri::State<TmuxState>) -> String {
    state.session_name.clone()
}
```

## Security Considerations

### Allowlist
Tauri 2.0 requires explicitly allowing commands in configuration:
```json
{
  "tauri": {
    "allowlist": {
      "all": false
    }
  }
}
```

Commands defined with `#[tauri::command]` are automatically added to allowlist when registered.

## Performance Considerations

1. **IPC Overhead**: Minimal with V2's custom protocol
2. **JSON Serialization**: Keep payloads small, avoid sending full terminal buffer every time
3. **Event Frequency**: Debounce tmux state change events if they fire too frequently
4. **Async Operations**: Use tokio for non-blocking tmux monitoring

## Build & Development

### Development
```bash
npm run tauri dev
```

### Production Build
```bash
npm run tauri build
```

### Hot Reload
Vite provides HMR for frontend changes. Rust changes require restart.

## Best Practices for Our Project

1. **Separation of Concerns**: Keep tmux logic in separate Rust modules
2. **Error Handling**: Return `Result<T, String>` from commands, emit error events
3. **Logging**: Use `log` crate in Rust, forward important logs to frontend if needed
4. **Type Safety**: Define shared types for IPC payloads
5. **Lifecycle Management**: Clean up tmux session on app close (use Tauri lifecycle hooks)

## Potential Challenges

1. **tmux Compatibility**: Different tmux versions might behave differently
2. **Hook Timing**: Ensuring hooks fire reliably and capture all changes
3. **Performance**: High-frequency updates from tmux could overwhelm IPC
4. **Terminal Rendering**: Accurately rendering terminal escape sequences in browser

## Next Steps for Implementation

1. Set up basic Tauri + Vite + React project
2. Create Rust commands for tmux operations
3. Set up event system for state changes
4. Implement tmux monitoring with hooks
5. Build React terminal renderer
6. Add comprehensive tests
