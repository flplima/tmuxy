# tmux Research for tmux-wrapper Project

## Overview
tmux (terminal multiplexer) is a terminal session manager that allows multiple terminal sessions to be accessed simultaneously in a single window. It provides powerful scripting capabilities and hooks for monitoring and controlling terminal sessions programmatically.

## Key Resources
- Official Man Page: https://man7.org/linux/man-pages/man1/tmux.1.html
- Tao of tmux: https://tao-of-tmux.readthedocs.io/
- GitHub Wiki: https://github.com/tmux/tmux/wiki
- Hooks Documentation: https://devel.tech/tips/n/tMuXz2lj/the-power-of-tmux-hooks/

## Core Concepts

### Sessions, Windows, and Panes
```
Session (named container)
  └── Window (tab-like)
      └── Pane (split terminal)
```

For our project:
- We'll use a single session named "tmux-wrapper"
- Single window
- Single pane (for MVP)

### Session Management

#### Create or Attach
```bash
# Create new session
tmux new-session -s tmux-wrapper

# Attach to existing session
tmux attach-session -t tmux-wrapper

# Create or attach (safe for our use case)
tmux new-session -A -s tmux-wrapper
```

#### Check if Session Exists
```bash
tmux has-session -t tmux-wrapper 2>/dev/null
```

#### List Sessions
```bash
tmux list-sessions
```

## Scripting tmux

### Control Mode (-C flag)
Control mode provides a programmable interface to tmux:
```bash
tmux -C attach-session -t tmux-wrapper
```

**Not suitable for our use case** because:
- Complex output parsing required
- Designed for full terminal emulators
- We want to monitor existing sessions, not control them directly

### Command Execution

#### Send Commands to tmux
```bash
# General format
tmux send-keys -t tmux-wrapper "ls -la" C-m

# C-m = Carriage return (Enter key)
# C-c = Ctrl+C
# C-d = Ctrl+D
```

#### Execute Without Sending Keys
```bash
tmux send-keys -t tmux-wrapper -X copy-mode
```

### Capture Pane Content

#### Basic Capture
```bash
# Capture visible pane content
tmux capture-pane -t tmux-wrapper -p

# -p: print to stdout
# -t: target session/window/pane
```

#### Capture with History
```bash
# Capture entire scrollback buffer
tmux capture-pane -t tmux-wrapper -p -S -

# -S: start line (-) means beginning of history
# -E: end line (default is visible pane)
```

#### Capture to File
```bash
# Capture to tmux's internal clipboard
tmux capture-pane -t tmux-wrapper

# Save clipboard to file
tmux save-buffer ~/tmux-capture.txt
```

#### Escape Sequences
```bash
# Include escape sequences (colors, formatting)
tmux capture-pane -t tmux-wrapper -p -e

# -e: include escape sequences
```

**For our project:** Use `-p -e` to capture with formatting, send to frontend

### Display Information

#### Get Pane Dimensions
```bash
tmux display-message -t tmux-wrapper -p '#{pane_width} #{pane_height}'
```

#### Get Cursor Position
```bash
tmux display-message -t tmux-wrapper -p '#{cursor_x} #{cursor_y}'
```

#### Multiple Variables
```bash
tmux display-message -t tmux-wrapper -p \
  'width=#{pane_width},height=#{pane_height},x=#{cursor_x},y=#{cursor_y}'
```

## Hooks: The Key to State Monitoring

### What are Hooks?
Hooks are commands that tmux executes automatically when certain events occur. They're described as "insanely powerful" for automation and monitoring.

### Setting Hooks

#### Global Hook
```bash
tmux set-hook -g hook-name "command to run"
```

#### Session-specific Hook
```bash
tmux set-hook -t tmux-wrapper hook-name "command to run"
```

### Available Hooks for Our Use Case

#### 1. after-select-pane
Fires after selecting a pane (not useful for single pane)

#### 2. pane-focus-in / pane-focus-out
Fires when pane gains/loses focus

#### 3. client-session-changed
Fires when client switches to different session

#### 4. window-pane-changed
**Most relevant:** Fires when pane content changes

#### 5. session-window-changed
Fires when active window changes

### Limitations
**Critical Discovery:** There is NO hook that fires on pane content changes!

The hooks listed above fire on:
- User interactions (switching panes/windows)
- Focus changes
- Layout changes

**But NOT on:**
- Output written to terminal
- Command execution completing
- New lines appearing

### Alternative Monitoring Strategies

#### Option 1: Polling
Poll pane content at regular intervals:
```bash
while true; do
  tmux capture-pane -t tmux-wrapper -p -e
  sleep 0.1  # 100ms interval
done
```

**Pros:**
- Simple implementation
- Guaranteed to catch all changes

**Cons:**
- CPU usage from constant polling
- Latency (bounded by poll interval)
- Inefficient (captures even when nothing changed)

#### Option 2: pipe-pane
Redirect pane output to a pipe/file:
```bash
tmux pipe-pane -t tmux-wrapper -o 'cat >> /tmp/tmux-output.txt'
```

**Pros:**
- Only captures new output
- Event-driven (file changes trigger updates)
- More efficient than polling

**Cons:**
- Doesn't capture existing content
- Requires file watching
- Misses tmux-generated output (prompts, etc.)

#### Option 3: Hybrid Approach (Recommended)
Combine polling with optimization:
```bash
# Poll but only send updates if content changed
previous_hash=""
while true; do
  content=$(tmux capture-pane -t tmux-wrapper -p -e)
  current_hash=$(echo "$content" | md5sum)

  if [ "$current_hash" != "$previous_hash" ]; then
    # Content changed, send update
    previous_hash="$current_hash"
  fi

  sleep 0.1
done
```

**Pros:**
- Catches all changes
- Only sends updates when content actually changes
- Adjustable latency vs CPU tradeoff

**Cons:**
- Still polls (but efficient)

### Hook Examples for Other Use Cases

#### Notify on Session Attach
```bash
tmux set-hook -g client-attached \
  'display-message "Client attached to #{session_name}"'
```

#### Run Command on Window Change
```bash
tmux set-hook -t tmux-wrapper session-window-changed \
  'run-shell "echo Window changed >> /tmp/tmux.log"'
```

## Sending Keys Programmatically

### Basic Keys
```bash
tmux send-keys -t tmux-wrapper "hello world" C-m
```

### Special Keys

#### Control Keys
- `C-a` = Ctrl+A
- `C-c` = Ctrl+C
- `C-d` = Ctrl+D
- `C-m` = Enter/Return

#### Other Special Keys
- `Enter` or `C-m` = Return
- `BSpace` = Backspace
- `DC` = Delete
- `Up`, `Down`, `Left`, `Right` = Arrow keys
- `PageUp`, `PageDown` = Page navigation
- `Home`, `End` = Line navigation

#### Example: Ctrl+C
```bash
tmux send-keys -t tmux-wrapper C-c
```

#### Example: Navigate with Arrows
```bash
tmux send-keys -t tmux-wrapper Up Up Enter
```

### Literal Mode
Send keys without special interpretation:
```bash
tmux send-keys -t tmux-wrapper -l "C-c"  # Sends literal text "C-c"
```

## Session Lifecycle

### Starting Session from Rust

#### Option 1: Start Detached
```rust
std::process::Command::new("tmux")
    .args(&["new-session", "-d", "-s", "tmux-wrapper"])
    .output()?;
```

#### Option 2: Start with Initial Command
```rust
std::process::Command::new("tmux")
    .args(&["new-session", "-d", "-s", "tmux-wrapper", "bash"])
    .output()?;
```

#### Option 3: Create or Attach
```rust
std::process::Command::new("tmux")
    .args(&["new-session", "-A", "-d", "-s", "tmux-wrapper"])
    .output()?;

// -A: attach if exists, create if not
// -d: detached (doesn't attach to current terminal)
```

### Checking Session Status
```rust
let output = std::process::Command::new("tmux")
    .args(&["has-session", "-t", "tmux-wrapper"])
    .output()?;

let exists = output.status.success();
```

### Killing Session
```rust
std::process::Command::new("tmux")
    .args(&["kill-session", "-t", "tmux-wrapper"])
    .output()?;
```

## Error Handling

### Common Errors

#### Session Not Found
```bash
$ tmux attach-session -t nonexistent
can't find session: nonexistent
```

**Exit code:** Non-zero

#### Server Not Running
```bash
$ tmux list-sessions
error connecting to /tmp/tmux-1000/default (No such file or directory)
```

### Rust Error Handling
```rust
fn execute_tmux_command(args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("tmux")
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
```

## Performance Considerations

### Capture Performance
- Full pane capture is fast (< 1ms for typical terminal)
- Scrollback capture can be slow for large histories
- Consider limiting capture range for better performance

### Poll Interval
- 100ms (10 FPS): Good balance for interactive use
- 50ms (20 FPS): Smoother, slightly more CPU
- 16ms (60 FPS): Overkill for terminal, high CPU usage

**Recommendation:** Start with 100ms, make configurable

### Optimization Strategies
1. **Hash comparison:** Only send updates when content changes
2. **Incremental updates:** Send only changed lines (more complex)
3. **Adaptive polling:** Slow down when no changes detected
4. **Debouncing:** Batch rapid changes

## Application to tmux-wrapper

### Initialization Flow
```rust
1. Check if tmux server is running
2. Check if "tmux-wrapper" session exists
3. If not, create session: `tmux new-session -d -s tmux-wrapper bash`
4. Start monitoring loop
```

### Monitoring Loop (Rust + Tokio)
```rust
use tokio::time::{interval, Duration};

async fn monitor_tmux_session(app: AppHandle) {
    let mut interval = interval(Duration::from_millis(100));
    let mut previous_content = String::new();

    loop {
        interval.tick().await;

        match capture_pane() {
            Ok(content) => {
                if content != previous_content {
                    app.emit("tmux-state-changed", TmuxState {
                        content: content.lines().map(String::from).collect(),
                        // ... other fields
                    }).ok();
                    previous_content = content;
                }
            }
            Err(e) => {
                app.emit("tmux-error", e).ok();
            }
        }
    }
}
```

### Sending Keys
```rust
fn send_keys_to_tmux(keys: String) -> Result<(), String> {
    execute_tmux_command(&[
        "send-keys",
        "-t", "tmux-wrapper",
        &keys,
    ])
}
```

### Capturing State
```rust
fn capture_pane() -> Result<String, String> {
    execute_tmux_command(&[
        "capture-pane",
        "-t", "tmux-wrapper",
        "-p",  // print to stdout
        "-e",  // include escape sequences
    ])
}
```

## Testing Strategy

### Mock tmux Commands
For testing without actual tmux:
```rust
#[cfg(test)]
mod tests {
    // Mock tmux command execution
    fn mock_tmux_capture() -> Result<String, String> {
        Ok("line1\nline2\nline3".to_string())
    }

    #[test]
    fn test_capture_parsing() {
        let content = mock_tmux_capture().unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3);
    }
}
```

### Integration Testing
- Requires tmux installed in test environment
- Create temporary test sessions
- Clean up after tests

```rust
#[test]
fn test_real_tmux_integration() {
    let session = "test-session-12345";

    // Create session
    Command::new("tmux")
        .args(&["new-session", "-d", "-s", session])
        .output()
        .unwrap();

    // Test operations
    // ...

    // Cleanup
    Command::new("tmux")
        .args(&["kill-session", "-t", session])
        .output()
        .unwrap();
}
```

## Limitations and Considerations

### No Content Change Hook
**Critical limitation:** tmux doesn't provide hooks for content changes, requiring polling

### Terminal Compatibility
- Different tmux versions may have slightly different output formats
- Escape sequences depend on terminal emulator
- Colors/formatting may vary

### Concurrency
- Multiple clients can attach to same session
- Our app should handle this gracefully
- Consider using `display-message -p #{client_tty}` to identify clients

### Performance
- Polling 10 times per second adds overhead
- Consider adaptive polling based on activity
- Large scrollback histories slow down capture

## Next Steps for Implementation

1. ✅ Understand tmux scripting capabilities
2. ✅ Identify monitoring strategy (polling with optimization)
3. ✅ Plan session lifecycle management
4. ✅ Design error handling
5. Implement in Rust with tokio for async monitoring
6. Test with real tmux sessions
7. Optimize based on performance metrics
