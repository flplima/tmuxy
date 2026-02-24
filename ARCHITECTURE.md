# Tmuxy Architecture

This document describes the architecture of tmuxy, a web-based tmux interface.

## Overview

Tmuxy provides a browser-based UI for tmux sessions. It consists of:

1. **tmuxy-core** - Rust library for tmux interaction
2. **tmuxy-cli** - CLI + Axum web server with SSE support
3. **tmuxy-ui** - React frontend with XState state machine
4. **tmuxy-tauri-app** - Desktop app wrapper (optional)

```mermaid
graph TD
    subgraph Browsers["Browser Clients"]
        C1[Client 1]
        C2[Client 2]
        C3[Client 3]
    end

    subgraph Server["Web Server (Axum + WebSocket)"]
        WS[WebSocket Handler]

        subgraph SA["Session A (per-session)"]
            ConnsA[Connections]
            MonA[Monitor A]
        end

        subgraph SB["Session B (per-session)"]
            ConnsB[Connections]
            MonB[Monitor B]
        end
    end

    subgraph Tmux["tmux processes"]
        TA["tmux session A"]
        TB["tmux session B"]
    end

    C1 & C2 & C3 -->|WebSocket| WS
    WS --> ConnsA & ConnsB
    ConnsA --> MonA
    ConnsB --> MonB
    MonA <-->|"control mode (tmux -CC)"| TA
    MonB <-->|"control mode (tmux -CC)"| TB
```

## Key Components

### 1. TmuxMonitor (tmuxy-core)

The `TmuxMonitor` connects to tmux using **control mode** (`tmux -CC`), which provides:
- Real-time event notifications (pane content changes, layout changes, etc.)
- Ability to send commands through the same connection
- No polling required

**One monitor per session.** When the first client connects to a session, a monitor is spawned. When the last client disconnects, the monitor is stopped.

```rust
pub struct TmuxMonitor {
    connection: ControlModeConnection,
    state: StateAggregator,
    config: MonitorConfig,
    command_rx: mpsc::Receiver<MonitorCommand>,  // External commands (resize, etc.)
}
```

The monitor exposes a command channel (`MonitorCommandSender`) for external code to send commands through the control mode connection. This is critical because **some tmux commands only work when sent through the control mode connection**, not via external `tmux` subprocess calls.

### 2. SessionConnections (web-server)

Tracks all clients connected to a single tmux session:

```rust
pub struct SessionConnections {
    pub connections: Vec<u64>,             // All connection IDs
    pub connection_channels: HashMap<...>, // Per-connection direct message channels
    pub client_sizes: HashMap<u64, (u32, u32)>,  // Viewport sizes
    pub monitor_command_tx: Option<MonitorCommandSender>,  // Commands to monitor
    pub state_tx: broadcast::Sender<String>,  // Shared state updates
    pub monitor_handle: Option<JoinHandle<()>>,  // Monitor task handle
}
```

**Shared resources:**
- `state_tx` - Broadcast channel for state updates, shared by all clients in the session
- `monitor_command_tx` - Channel to send commands to the session's monitor
- `monitor_handle` - Task handle to stop monitor when last client leaves

### 3. Multi-Client Viewport Sizing

Like native tmux, when multiple clients connect to the same session, the **session is sized to the smallest client's viewport**.

```
Client A: 120x40 viewport
Client B:  80x24 viewport
                ↓
Session sized to: 80x24
```

**How it works:**
1. Each client reports its viewport size via `set_client_size`
2. Server computes the minimum across all connected clients
3. Server sends resize command through the monitor's control mode connection

**Why resize commands go through the monitor:**

When a control mode client is attached to a tmux session, external `tmux resize-window` commands (run via subprocess) are ignored. Resize commands must be sent **through the control mode connection** to take effect.

```rust
// MonitorCommand enum
pub enum MonitorCommand {
    ResizeWindow { cols: u32, rows: u32 },
}

// In set_client_size - server computes minimum and resizes:
let (min_cols, min_rows) = compute_min_client_size(&session_conns.client_sizes);
if let Some(tx) = command_tx {
    tx.send(MonitorCommand::ResizeWindow { cols: min_cols, rows: min_rows }).await;
}
```

### 4. WebSocket Protocol

**Client → Server:**
```json
{ "type": "invoke", "id": "uuid", "cmd": "command_name", "args": {...} }
```

**Server → Client:**
```json
// Command responses
{ "type": "response", "id": "uuid", "result": ... }
{ "type": "error", "id": "uuid", "error": "message" }

// State updates (broadcast to all clients)
{ "type": "event", "name": "tmux-state-update", "payload": {...} }

// Connection management
{ "type": "connection_info", "connection_id": 1 }
```

### 5. Frontend State Machine (XState)

The React frontend uses XState for state management. All client logic lives in the state machine, not in React components.

```mermaid
graph TD
    subgraph AppMachine["appMachine"]
        subgraph Actors
            TA["tmuxActor (WebSocket)"]
            KA["keyboardActor (input handling)"]
            SA["sizeActor (viewport tracking)"]
        end

        Actors --> Context

        subgraph Context["Context (state)"]
            PW["panes, windows"]
            Active["activePaneId, activeWindowIndex"]
            Groups["groups (pane groupings)"]
            Modes["copyMode, prefixMode, etc."]
        end
    end

    AppMachine --> RC["React Components<br/>(read state, send events)"]
```

## Data Flow

### Connection Lifecycle

1. **Client connects** via WebSocket with `?session=name`
2. Server generates unique `connection_id`
3. Server checks if session monitor exists:
   - **No monitor:** Start new monitor, store handle in `SessionConnections`
   - **Has monitor:** Subscribe to existing `state_tx` channel
5. Client receives `connection_info` message
6. Client sends `get_initial_state` with viewport size
7. Server stores client size, computes minimum across all clients
8. Server sends resize command through monitor's control mode connection

### State Update Flow

```mermaid
graph TD
    TS["tmux session"] -->|"control mode notifications<br/>(%output, %layout-change, etc.)"| TM[TmuxMonitor]
    TM -->|"StateEmitter.emit_state(StateUpdate)"| WSE[WebSocketEmitter]
    WSE -->|"broadcast::Sender.send(JSON)"| STX["session_tx (broadcast channel)"]
    STX --> C1[Client 1]
    STX --> C2[Client 2]
    STX --> C3[Client 3]
```

### Command Execution Flow

```mermaid
graph TD
    Client -->|'invoke: send_keys'| WSH[WebSocket Handler]
    WSH -->|match cmd| Decision{route}
    Decision -->|subprocess| Exec["executor::send_keys()"]
    Decision -->|through control mode| Mon["monitor_command_tx.send()"]
    Exec --> Tmux1[tmux]
    Mon --> Tmux2[tmux]
```

## Tmux Configuration

For multi-client viewport sizing to work correctly:

```bash
# ~/.tmux.conf or docker/.tmuxy.conf
setw -g aggressive-resize off   # Don't auto-resize to largest client
set -g window-size manual       # Manual control over window size
```

## File Structure

```
packages/
├── tmuxy-core/
│   └── src/
│       ├── control_mode/
│       │   ├── connection.rs   # ControlModeConnection (tmux -CC)
│       │   ├── monitor.rs      # TmuxMonitor, MonitorCommand
│       │   ├── state.rs        # StateAggregator
│       │   └── parser.rs       # Control mode event parser
│       ├── executor.rs         # Subprocess tmux commands
│       └── session.rs          # Session management
├── tmuxy-cli/
│   └── src/
│       ├── main.rs             # CLI entry point (clap subcommands)
│       ├── server.rs           # Server setup (production + dev mode)
│       ├── web.rs              # AppState, SessionConnections, API routes
│       └── sse.rs              # SSE handling, state broadcasting
└── tmuxy-ui/
    └── src/
        ├── machines/
        │   ├── app/
        │   │   └── appMachine.ts   # Main state machine
        │   └── actors/
        │       ├── tmuxActor.ts    # WebSocket actor
        │       └── keyboardActor.ts
        └── components/
            ├── Terminal.tsx
            ├── PaneLayout.tsx
            └── StatusBar.tsx
```

## Tmux Control Mode Command Routing

**Critical:** All tmux commands must be sent through the control mode stdin connection, NOT via external subprocess calls.

When tmux control mode (`tmux -CC`) is attached to a session, running external `tmux` commands as separate processes can crash the tmux server (observed in tmux 3.3a). This is by design - the [tmux Control Mode documentation](https://github.com/tmux/tmux/wiki/Control-Mode) states that commands should be sent through the control mode client.

### Architecture

```mermaid
graph LR
    subgraph Commands
        FE1[Frontend] -->|WebSocket| SCM["send_via_control_mode()"]
        SCM --> Mon[Monitor]
        Mon -->|stdin| TMX["tmux -CC"]
    end

    subgraph Events
        TMX2["tmux -CC"] -->|stdout| Mon2[Monitor]
        Mon2 -->|WebSocket| FE2[Frontend]
    end
```

### Implementation

All WebSocket command handlers route through `send_via_control_mode()`:

```rust
async fn send_via_control_mode(state: &Arc<AppState>, session: &str, command: &str) -> Result<(), String> {
    let command_tx = {
        let sessions = state.sessions.read().await;
        sessions.get(session).and_then(|s| s.monitor_command_tx.clone())
    };

    if let Some(tx) = command_tx {
        tx.send(MonitorCommand::RunCommand { command: command.to_string() })
            .await
            .map_err(|e| format!("Monitor channel error: {}", e))
    } else {
        Err("No monitor connection available".to_string())
    }
}
```

### Short Command Forms

Use tmux short command aliases (preferred in control mode):

| Long Form | Short Form |
|-----------|------------|
| `new-window` | `neww` |
| `split-window` | `splitw` |
| `select-pane` | `selectp` |
| `select-window` | `selectw` |
| `kill-pane` | `killp` |
| `kill-window` | `killw` |
| `resize-pane` | `resizep` |
| `resize-window` | `resizew` |
| `send-keys` | `send` |
| `next-window` | `next` |
| `previous-window` | `prev` |

**Note:** `new` is short for `new-session`, NOT `new-window`. Use `neww` for creating windows.

See the [tmux Control Mode wiki](https://github.com/tmux/tmux/wiki/Control-Mode) for detailed documentation.

## Key Design Decisions

1. **One monitor per session** - Avoids duplicate control mode connections and ensures resize commands work reliably.

2. **Resize through control mode** - External `tmux resize-window` commands are ignored when control mode is attached. All resize commands go through the monitor's command channel.

3. **Minimum viewport sizing** - Server computes the minimum viewport size across all connected clients and resizes the session accordingly. No "primary" client concept needed.

4. **Broadcast channel for state** - All clients in a session share a single broadcast channel for state updates, reducing memory and CPU overhead.

5. **State machine in frontend** - All client logic lives in XState, keeping React components purely presentational.

## Testing

The project has three distinct testing approaches, each serving different purposes.

### 1. E2E Snapshot Tests (Jest + Playwright)

**Goal:** Verify the UI renders terminal content identically to native tmux.

These tests compare two text snapshots:
- **UI Snapshot:** `window.getSnapshot()` - Renders the React terminal grid to ASCII text
- **Tmux Snapshot:** `window.getTmuxSnapshot()` → `tmux capture-pane -p` - Native tmux output

```javascript
// Test suites enable snapshot comparison in afterEach
const ctx = createTestContext({ snapshot: true });

// After each test, compare UI vs tmux output
// Uses Levenshtein edit distance with threshold (≤8 chars difference allowed)
assertSnapshotsMatch(page);
```

**Tolerance:** Small differences (≤8 character edits per row) are tolerated for terminal emulation edge cases (escape sequences, cursor positioning).

**Enabled for:** Rendering-focused suites (basic connectivity, floating panes, status bar, OSC protocols).

### 2. E2E Functional Tests (Jest + Playwright)

**Goal:** Verify features work correctly with real browser interactions.

Tests use real tmux sessions, real keyboard/mouse events, and real WebSocket connections. No mocking.

```javascript
// Real keyboard
await ctx.page.keyboard.press('Enter');

// Real mouse
await ctx.page.mouse.click(x, y);

// State consistency - UI matches tmux
const uiPaneCount = await getUIPaneCount(ctx.page);
expect(uiPaneCount).toBe(ctx.session.getPaneCount());
```

**Categories:**
- Basic connectivity & rendering
- Keyboard input
- Pane/window operations
- Mouse events
- Copy mode
- Status bar
- Session connection
- OSC protocols
- Workflows

### 3. E2E Performance Tests (Jest + Playwright)

**Goal:** Ensure operations complete within acceptable time bounds.

```javascript
// Output performance - large content renders quickly
await runCommand(ctx.page, 'seq 1 2000 && echo "SEQ_DONE"', 'SEQ_DONE', 15000);
expect(elapsed).toBeLessThan(20000);

// Input latency - keyboard round-trip
const elapsed = await measureKeyboardRoundTrip(ctx.page);
expect(elapsed).toBeLessThan(500);

// Layout performance - many panes
ctx.session.splitHorizontal(); // repeat 5x
await waitForPaneCount(ctx.page, 6);
```

**Metrics:**
- Rapid output (yes | head -500)
- Large output (seq 1 2000)
- Many panes (6+ panes)
- Keyboard latency (<500ms)
- Mouse click latency (<500ms)
- Workflow round-trips (<15s)

### 4. Glitch Detection Tests (Jest + Playwright + MutationObserver)

**Goal:** Detect visual instability (flicker, layout shifts, attribute churn) that functional tests miss.

These tests inject MutationObserver + size polling into the browser to catch DOM mutations during operations.

```javascript
// Start glitch detection before operation
await ctx.startGlitchDetection({ scope: '.pane-layout' });

// Perform operation
await splitPaneKeyboard(ctx.page, 'horizontal');
await waitForPaneCount(ctx.page, 2);

// Assert no glitches detected
await ctx.assertNoGlitches({ operation: 'split' });
```

**Detection types:**
- **Node flicker:** Element added then removed (or vice versa) within 100ms
- **Attribute churn:** Same attribute changing >2 times within 200ms
- **Size jumps:** Pane dimensions changing >20px between frames outside resize

**Exclusions (expected mutations):**
- Terminal content (`.terminal-content`, `.terminal-line`)
- Cursor updates (`.terminal-cursor`)
- CSS transition styles during animations

**File:** `tests/15-glitch-detection.test.js`

### 5. Unit Tests (Vitest + React Testing Library)

**Goal:** Test React components in isolation.

```javascript
// packages/tmuxy-ui/src/test/Terminal.test.tsx
describe('Terminal', () => {
  it('renders terminal lines', () => {
    const content = createContent(['hello', 'world']);
    render(<Terminal content={content} />);
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
  });
});
```

**Scope:** Component rendering, props handling, accessibility attributes.

### Running Tests

```bash
# E2E tests (requires dev server running)
npm run web:dev:start
npm run test:e2e

# Specific E2E suite
npm run test:e2e -- --testPathPattern="01-basic-connectivity"

# Unit tests
npm test
```

### Test Files

```
tests/
├── helpers/
│   ├── TmuxTestSession.js    # Tmux session wrapper
│   ├── browser.js            # Playwright utilities
│   ├── ui.js                 # UI interaction helpers
│   ├── glitch-detector.js    # MutationObserver harness for flicker detection
│   └── test-setup.js         # Context factory, snapshot comparison
├── 01-basic-connectivity.test.js  # Smoke tests, rendering (snapshot: true)
├── 02-keyboard-input.test.js      # Keyboard handling
├── 03-pane-operations.test.js     # Split, navigate, resize
├── ...
├── 14-workflows.test.js           # Real-world scenarios
└── 15-glitch-detection.test.js    # Visual stability tests (flicker, churn)

packages/tmuxy-ui/src/test/
├── Terminal.test.tsx              # Terminal component tests
└── App.test.tsx                   # App component tests
```
