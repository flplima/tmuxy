# E2E Test Scenarios

Comprehensive test scenarios for tmuxy, ordered from simplest to most complex within each category.

**Current status:** 18 scenarios implemented across 5 test files. See [tests.md](tests.md) for the file-to-scenario mapping. Scenarios 1, 3, and 15 were removed (covered by other scenarios or unreliable). Scenarios 20 (Glitch Detection) and 21 (Touch Scrolling) were added after the original plan.

---

## 1. Basic Connectivity & Rendering (removed — covered by other scenarios)

### 1.1 Smoke Tests
- [ ] **Page loads**: Open the page, verify the app container renders
- [ ] **SSE connects**: Open the page, verify "connected" state in UI
- [ ] **Single pane renders**: Open the page, verify one pane is visible with shell prompt
- [ ] **Echo command**: Run `echo hello`, verify "hello" appears in UI
- [ ] **Snapshot match**: Run `echo test`, compare tmux `capture-pane` output with UI text content

### 1.2 Content Rendering
- [ ] **Multi-line output**: Run `seq 1 10`, verify all 10 lines render correctly
- [ ] **Long line wrapping**: Run `echo $(printf 'x%.0s' {1..200})`, verify line wraps or truncates appropriately
- [ ] **ANSI colors**: Run `echo -e "\e[31mred\e[0m \e[32mgreen\e[0m"`, verify colors render
- [ ] **Bold/italic/underline**: Run `echo -e "\e[1mbold\e[0m \e[3mitalic\e[0m \e[4munderline\e[0m"`, verify styles
- [ ] **256 colors**: Run a script that outputs all 256 colors, verify rendering
- [ ] **True color (24-bit)**: Run `echo -e "\e[38;2;255;100;0mOrange\e[0m"`, verify RGB color
- [ ] **Unicode characters**: Run `echo "日本語 emoji 🎉 symbols ✓✗"`, verify rendering
- [ ] **Box drawing characters**: Run `cat` on a file with box drawing, verify alignment
- [ ] **Cursor position**: Verify cursor renders at correct position after various commands
- [ ] **Empty lines preserved**: Run command with empty lines in output, verify they render

### 1.3 Terminal State
- [ ] **Scroll region**: Open `less` on a long file, verify scroll region works
- [ ] **Alternate screen**: Open `vim`, verify alternate screen activates, exit and verify return
- [ ] **Terminal title**: Run `echo -ne "\e]0;Custom Title\a"`, verify title updates in pane header
- [ ] **Clear screen**: Run `clear`, verify screen clears and cursor resets

---

## 2. Keyboard Input

### 2.1 Basic Input
- [ ] **Alphanumeric**: Type "hello123", verify characters appear
- [ ] **Special characters**: Type `!@#$%^&*()`, verify all render
- [ ] **Backspace**: Type "hello", press backspace 2x, verify "hel" remains
- [ ] **Enter**: Type command, press Enter, verify execution
- [ ] **Tab completion**: Type partial command, press Tab, verify completion

### 2.2 Control Sequences
- [ ] **Ctrl+C**: Run `sleep 100`, press Ctrl+C, verify interrupt
- [ ] **Ctrl+D**: Open `cat`, press Ctrl+D, verify EOF
- [ ] **Ctrl+L**: Run commands, press Ctrl+L, verify screen clear
- [ ] **Ctrl+Z**: Run `sleep 100`, press Ctrl+Z, verify suspend message
- [ ] **Ctrl+A (tmux prefix)**: Press Ctrl+A, then "c", verify new window created

### 2.3 Arrow Keys & Navigation
- [ ] **Up arrow**: Run command, press Up, verify history recall
- [ ] **Down arrow**: Navigate history up, then down, verify navigation
- [ ] **Left/Right arrows**: Type text, use arrows to navigate, verify cursor movement
- [ ] **Home/End**: Type text, press Home/End, verify cursor jumps
- [ ] **Page Up/Down**: In `less`, press PgUp/PgDn, verify scrolling

### 2.4 Function Keys
- [ ] **F1-F12**: In an app that uses function keys (e.g., `mc`), verify each works
- [ ] **Shift+F1-F12**: Verify shifted function keys work in apps that use them

### 2.5 IME Input (Issue #7)
- [ ] **Japanese input**: Enable IME, type Japanese, verify composition and commit
- [ ] **Chinese input**: Enable IME, type Chinese pinyin, select character, verify
- [ ] **Korean input**: Enable IME, type Korean, verify Hangul composition
- [ ] **IME cancel**: Start composition, press Escape, verify cancellation
- [ ] **Mixed input**: Type English, switch to IME, type Japanese, switch back, verify all

---

## 3. Pane Operations (removed — split across scenarios 2, 4, 18)

### 3.1 Split Operations
- [ ] **Horizontal split**: Press Ctrl+A, then `"`, verify two panes vertically stacked
- [ ] **Vertical split**: Press Ctrl+A, then `%`, verify two panes side by side
- [ ] **Split with command**: Split and run specific command in new pane
- [ ] **Nested splits**: Create 2x2 grid of panes via multiple splits
- [ ] **Uneven splits**: Split, then split one pane again, verify layout

### 3.2 Pane Navigation
- [ ] **Arrow navigation**: With multiple panes, use Ctrl+A + arrows to navigate
- [ ] **Cycle panes**: Press Ctrl+A + o to cycle through panes
- [ ] **Last pane**: Press Ctrl+A + `;` to toggle to last active pane
- [ ] **Pane by number**: Press Ctrl+A + q, then number to select pane
- [ ] **Click to focus**: Click on inactive pane, verify it becomes active

### 3.3 Pane Resize
- [ ] **Resize right**: Drag right edge of pane, verify width changes
- [ ] **Resize down**: Drag bottom edge of pane, verify height changes
- [ ] **Resize keyboard**: Use Ctrl+A + Ctrl+arrow to resize
- [ ] **Resize constraints**: Try to resize beyond minimum (1 col/row), verify constraint
- [ ] **Resize multiple**: Resize one pane, verify neighbor adjusts accordingly
- [ ] **Resize preview**: During drag, verify preview shows new dimensions

### 3.4 Pane Close
- [ ] **Exit command**: Run `exit` in pane, verify pane closes
- [ ] **Kill pane**: Press Ctrl+A + x, confirm, verify pane closes
- [ ] **Close button**: Click X button on pane header, verify close
- [ ] **Last pane**: Close all but one pane, verify window remains
- [ ] **Close with running process**: Close pane with active process, verify behavior

### 3.5 Pane Zoom
- [ ] **Zoom in**: With multiple panes, press Ctrl+A + z, verify one pane fills window
- [ ] **Zoom out**: While zoomed, press Ctrl+A + z again, verify original layout
- [ ] **Zoom indicator**: Verify UI shows zoom state
- [ ] **Double-click zoom**: Double-click pane header, verify zoom toggle

### 3.6 Pane Swap/Move
- [ ] **Swap panes**: Press Ctrl+A + { or }, verify panes swap positions
- [ ] **Drag to swap**: Drag pane header onto another pane, verify swap
- [ ] **Drag to new window**: Drag pane to "new window" drop zone, verify new window
- [ ] **Move to window**: Use Ctrl+A + ! to break pane to new window

---

## 4. Window Operations

### 4.1 Window Creation
- [ ] **New window**: Press Ctrl+A + c, verify new window tab appears
- [ ] **New window with name**: Create window with specific name
- [ ] **New window with command**: Create window running specific command

### 4.2 Window Navigation
- [ ] **Next window**: Press Ctrl+A + n, verify window switches
- [ ] **Previous window**: Press Ctrl+A + p, verify window switches
- [ ] **Window by number**: Press Ctrl+A + 0-9, verify window selection
- [ ] **Last window**: Press Ctrl+A + l, verify toggle to last window
- [ ] **Click tab**: Click window tab in status bar, verify switch

### 4.3 Window Management
- [ ] **Rename window**: Press Ctrl+A + ,, type name, verify rename
- [ ] **Close window**: Press Ctrl+A + &, confirm, verify window closes
- [ ] **Close window button**: Click X on window tab, verify close
- [ ] **Reorder windows**: Move window to different position

### 4.4 Window Layout
- [ ] **Even horizontal**: Press Ctrl+A + Alt+1, verify layout
- [ ] **Even vertical**: Press Ctrl+A + Alt+2, verify layout
- [ ] **Main horizontal**: Press Ctrl+A + Alt+3, verify layout
- [ ] **Main vertical**: Press Ctrl+A + Alt+4, verify layout
- [ ] **Tiled**: Press Ctrl+A + Alt+5, verify layout
- [ ] **Cycle layouts**: Press Ctrl+A + Space repeatedly, verify cycling

---

## 5. Pane Groups (Issue #3)

### 5.1 Basic Group Operations
- [ ] **Create group**: Add second pane to same position as first (via menu/shortcut)
- [ ] **Group tabs appear**: Verify tabs show in pane header when grouped
- [ ] **Switch tab**: Click different tab in group, verify pane switches
- [ ] **Tab shows title**: Verify each tab shows pane title/command

### 5.2 Group Navigation
- [ ] **Keyboard tab switch**: Use keyboard shortcut to switch tabs in group
- [ ] **Tab order**: Verify tabs appear in consistent order
- [ ] **Active tab indicator**: Verify active tab is visually distinct

### 5.3 Group Management
- [ ] **Close tab**: Close one tab in group, verify others remain
- [ ] **Close last tab**: Close all tabs in group, verify group dissolves
- [ ] **Ungroup pane**: Move pane out of group to its own position
- [ ] **Add to existing group**: Add third pane to existing 2-pane group

### 5.4 Group Persistence
- [ ] **Group survives window switch**: Switch windows and back, verify group intact
- [ ] **Group survives refresh**: Reload page, verify group state preserved
- [ ] **Group with different commands**: Group panes running different commands

---

## 6. Floating Panes (Issue #4)

### 6.1 Float Creation
- [ ] **Create float**: Create a new floating pane via menu/shortcut
- [ ] **Convert to float**: Convert existing tiled pane to floating
- [ ] **Float with command**: Create float running specific command

### 6.2 Float Interaction
- [ ] **Move float**: Drag floating pane to new position
- [ ] **Resize float**: Drag corner/edge of float to resize
- [ ] **Focus float**: Click on float to focus it
- [ ] **Float above tiled**: Verify float renders above tiled panes
- [ ] **Multiple floats**: Create multiple floats, verify stacking

### 6.3 Float Management
- [ ] **Close float**: Close floating pane via button or command
- [ ] **Embed float**: Convert floating pane back to tiled
- [ ] **Pin float**: Pin float so it stays visible across window switches
- [ ] **Unpin float**: Unpin a pinned float
- [ ] **Toggle float view**: Show/hide all floats via toggle

### 6.4 Float Edge Cases
- [ ] **Float at window edge**: Move float to edge, verify constrained to viewport
- [ ] **Very small float**: Resize float to minimum size
- [ ] **Very large float**: Resize float larger than container
- [ ] **Float z-order**: With overlapping floats, verify click brings to front

---

## 7. Mouse Events (Issue #2)

### 7.1 Basic Mouse
- [ ] **Click to focus pane**: Click inactive pane, verify focus
- [ ] **Click in terminal**: Click in terminal content, verify cursor/selection (if app supports)
- [ ] **Right-click**: Right-click in pane, verify context menu or passthrough

### 7.2 Mouse in Applications
- [ ] **vim mouse**: Open vim with mouse enabled, click to position cursor
- [ ] **htop mouse**: Open htop, click to select process
- [ ] **less mouse**: Open less, use scroll wheel
- [ ] **mc mouse**: Open Midnight Commander, click to navigate

### 7.3 Mouse Wheel
- [ ] **Scroll in copy mode**: Scroll wheel enters copy mode, scrolls history
- [ ] **Scroll in alternate screen**: Scroll wheel sends arrow keys to app
- [ ] **Scroll passthrough**: With mouse app, scroll sends to application

### 7.4 Mouse Selection
- [ ] **Select text**: Click and drag to select text in pane
- [ ] **Word select**: Double-click to select word
- [ ] **Line select**: Triple-click to select line
- [ ] **Rectangle select**: Ctrl+click+drag for rectangle selection (if supported)

### 7.5 Mouse Drag
- [ ] **Drag pane divider**: Drag divider between panes to resize
- [ ] **Drag pane header**: Drag header to swap/move pane
- [ ] **Drag to resize float**: Drag float edges to resize

---

## 8. Copy Mode

### 8.1 Enter/Exit Copy Mode
- [ ] **Enter via keyboard**: Press Ctrl+A + [, verify copy mode indicator
- [ ] **Enter via scroll**: Scroll up, verify copy mode activates
- [ ] **Exit copy mode**: Press q or Escape, verify exit
- [ ] **Exit via Enter**: After selection, press Enter to copy and exit

### 8.2 Navigation in Copy Mode
- [ ] **Arrow navigation**: Use arrows to move cursor in history
- [ ] **Page navigation**: Use PgUp/PgDn to scroll pages
- [ ] **Word navigation**: Use w/b to move by words
- [ ] **Line navigation**: Use 0/$ to go to line start/end
- [ ] **Search**: Use / to search, n/N to navigate matches

### 8.3 Selection in Copy Mode
- [ ] **Start selection**: Press Space to start selection
- [ ] **Extend selection**: Move cursor to extend selection
- [ ] **Rectangle selection**: Use v to toggle rectangle mode
- [ ] **Copy selection**: Press Enter or y to copy selection
- [ ] **Cancel selection**: Press Escape to cancel selection

### 8.4 Paste
- [ ] **Paste buffer**: Press Ctrl+A + ] to paste
- [ ] **Paste in insert mode**: Verify paste works while typing
- [ ] **Paste multiline**: Copy multiple lines, paste, verify newlines

---

## 9. Status Bar & UI

### 9.1 Status Bar Rendering
- [ ] **Status bar visible**: Verify status bar renders at bottom
- [ ] **Window tabs**: Verify window tabs show in status bar
- [ ] **Active window highlighted**: Verify current window tab is highlighted
- [ ] **Session name**: Verify session name displays
- [ ] **ANSI in status**: Status line with colors renders correctly

### 9.2 Status Bar Interaction
- [ ] **Click window tab**: Click tab to switch windows
- [ ] **New window button**: Click + button to create window
- [ ] **Close window from tab**: Click X on tab to close

### 9.3 Tmux Menu
- [ ] **Open menu**: Click menu button, verify dropdown opens
- [ ] **Menu actions work**: Select menu item, verify action executes
- [ ] **Close menu**: Click outside menu, verify it closes
- [ ] **Keyboard navigation**: Use arrow keys to navigate menu

### 9.4 File Picker (Issue #6)
- [ ] **Open file picker**: Trigger file picker via menu/shortcut
- [ ] **Navigate directories**: Use arrows/enter to navigate
- [ ] **Select file**: Select file, verify path inserted
- [ ] **Cancel picker**: Press Escape, verify picker closes
- [ ] **Hidden files**: Toggle hidden file visibility

---

## 10. Session & Connection

### 10.1 Session Management
- [ ] **Session persists**: Close browser, reopen, verify session state preserved
- [ ] **Multiple windows survive**: Create multiple windows, refresh, verify all present
- [ ] **Pane layout survives**: Create complex layout, refresh, verify preserved

### 10.2 Reconnection (Issue #9)
- [ ] **Auto-reconnect**: Disconnect server briefly, verify auto-reconnect
- [ ] **Reconnect indicator**: During reconnect, verify UI shows status
- [ ] **State after reconnect**: After reconnect, verify full state restored
- [ ] **Multiple disconnects**: Simulate multiple disconnects, verify resilience
- [ ] **Exponential backoff**: Verify reconnect attempts use backoff

### 10.3 Multi-Client (tmuxy view - Issue #5)
- [ ] **Read-only viewer**: Open viewer, verify can see but not interact
- [ ] **Viewer sees updates**: Make changes in main, verify viewer sees them
- [ ] **Viewer count**: With multiple viewers, verify all see same state
- [ ] **Primary indication**: Verify primary client indicator works

### 10.4 Flow Control (Issue #8)
- [ ] **Pause on flood**: Generate massive output, verify pause triggers
- [ ] **Pause indicator**: When paused, verify UI shows pause state
- [ ] **Auto-continue**: Verify output resumes after pause
- [ ] **Manual continue**: If manual continue needed, verify it works

---

## 11. OSC Protocols (Issue #10)

### 11.1 Hyperlinks (OSC 8)
- [ ] **Link renders**: Output OSC 8 hyperlink, verify underlined text
- [ ] **Link clickable**: Click hyperlink, verify opens in new tab
- [ ] **Link hover**: Hover over link, verify cursor changes
- [ ] **Multiline link**: Link spanning multiple lines works

### 11.2 Clipboard (OSC 52)
- [ ] **Copy to clipboard**: Application sends OSC 52, verify clipboard updated
- [ ] **Paste from clipboard**: Verify paste works after OSC 52 copy

---

## 12. Popup Support (Issue #1)

### 12.1 Popup Rendering
- [ ] **Popup displays**: Trigger tmux popup, verify overlay renders
- [ ] **Popup content**: Verify popup content is correct
- [ ] **Popup position**: Verify popup appears at correct position

### 12.2 Popup Interaction
- [ ] **Type in popup**: Type in popup, verify input works
- [ ] **Close popup**: Close popup via command/escape
- [ ] **Popup over panes**: Verify popup renders above panes

---

## 13. Performance & Stress

### 13.1 Output Performance
- [ ] **Rapid output**: Run `yes | head -10000`, verify smooth rendering
- [ ] **Large file cat**: `cat` a large file, measure render time
- [ ] **Continuous output**: Run `ping localhost`, verify no memory leak over time

### 13.2 Layout Performance
- [ ] **Many panes**: Create 16 panes, verify responsive navigation
- [ ] **Rapid split/close**: Rapidly create and close panes
- [ ] **Resize during output**: Resize pane while it's outputting

### 13.3 Long Sessions
- [ ] **Extended use**: Leave session running for hours, verify stability
- [ ] **Large scrollback**: Accumulate large history, verify scroll performance
- [ ] **Many windows**: Create 20+ windows, verify tab performance

---

## 14. Real-World Workflow Scenarios

### 14.1 Development Workflow
```
Scenario: Full-stack development session
1. Create window "editor" - open vim on project
2. Create window "server" - split vertically:
   - Left pane: run backend server (npm run dev)
   - Right pane: run frontend server (npm run start)
3. Create window "shell" - split horizontally:
   - Top pane: general shell for git commands
   - Bottom pane: run tests (npm test --watch)
4. Create window "logs" - split into 3 panes:
   - Backend logs
   - Frontend logs
   - Database logs
5. Navigate between windows using Ctrl+A + number
6. Use pane groups to organize related logs
7. Create floating pane for quick reference (API docs)
8. Copy error from log pane, paste into editor pane
9. Resize panes to focus on failing test
10. Zoom into editor pane for focused coding
11. Verify all panes update in real-time as servers run
```

### 14.2 DevOps Workflow
```
Scenario: Multi-server monitoring session
1. Create window for each server (prod1, prod2, staging)
2. Each window has split panes:
   - SSH session to server
   - tail -f of application logs
   - htop for resource monitoring
3. Use pane groups to organize multiple log files per server
4. Float a pane with alerting dashboard
5. Copy commands from one server, paste to another
6. Navigate between servers rapidly
7. Zoom into problematic server's htop
8. Use mouse to click through htop process list
9. Resize log panes when investigating issues
10. Verify sessions survive network blips (reconnection)
```

### 14.3 Pair Programming Workflow
```
Scenario: Collaborative coding with viewer
1. Primary user creates complex pane layout:
   - Editor pane (vim)
   - Terminal pane
   - Test output pane
2. Second user connects as viewer (read-only)
3. Viewer sees all primary user's actions in real-time
4. Primary user types code, viewer sees keystrokes
5. Primary user runs tests, both see output
6. Primary user navigates files, viewer follows
7. Primary user uses vim mouse mode
8. Verify viewer sees correct cursor position
9. Primary user copies text, both see selection
10. Test with 3+ simultaneous viewers
```

### 14.4 Long-Running Process Management
```
Scenario: Managing background jobs
1. Start multiple long-running processes:
   - Database migration
   - Data import script
   - Build process
2. Each in separate pane, monitor progress
3. Processes flood output - verify flow control
4. Close browser, reopen - sessions still running
5. One process finishes - verify pane remains for review
6. Kill hung process with Ctrl+C
7. Restart failed process
8. Use copy mode to search for errors in output
9. Copy relevant log sections
10. Verify scrollback survives reconnection
```

### 14.5 Complex Layout Stress Test
```
Scenario: Maximum complexity session
1. Create 5 windows
2. Window 1: 4-pane grid (2x2)
3. Window 2: 3-pane with groups (6 total logical panes)
4. Window 3: Pane with 2 floating panes on top
5. Window 4: 9-pane grid (3x3)
6. Window 5: Deep nested splits (binary tree 4 levels)
7. Run different commands in each pane
8. Navigate through all windows rapidly
9. Resize various panes
10. Use mouse and keyboard interchangeably
11. Switch pane group tabs rapidly
12. Move/swap panes between positions
13. Zoom and unzoom in different windows
14. Verify all state via tmux and UI match
15. Refresh browser - verify full state restore
```

### 14.6 Unicode & Internationalization
```
Scenario: Multilingual terminal session
1. Set UTF-8 locale
2. Run commands outputting various scripts:
   - Japanese: ls of directory with Japanese names
   - Chinese: cat file with Chinese content
   - Arabic: echo RTL text
   - Emoji: cat file with emoji
3. Type input in Japanese using IME
4. Use vim with CJK content
5. Run program outputting box-drawing characters
6. Verify alignment of mixed-width characters
7. Copy CJK text, paste elsewhere
8. Search for CJK characters in copy mode
```

### 14.7 Mouse-Heavy Application Usage
```
Scenario: GUI-like terminal applications
1. Open Midnight Commander (mc)
   - Navigate using mouse clicks
   - Select files with mouse
   - Drag to copy/move (if supported)
2. Open htop
   - Click to select processes
   - Click column headers to sort
   - Scroll wheel to navigate
3. Open vim with mouse enabled
   - Click to position cursor
   - Drag to select text
   - Scroll wheel to navigate
4. Open lazygit
   - Click through panels
   - Scroll through commits
5. Verify mouse works correctly in all apps
6. Switch between apps, verify mouse state resets
```

### 14.8 Error Recovery Scenario
```
Scenario: Graceful handling of failures
1. Create session with multiple windows/panes
2. Server crash simulation:
   - Kill backend server
   - Verify reconnection attempts
   - Verify UI shows disconnected state
   - Restart server
   - Verify full state recovery
3. tmux crash simulation:
   - Kill tmux server
   - Verify appropriate error
   - Restart tmux
   - Verify new session works
4. Browser crash simulation:
   - Force kill browser
   - Reopen browser
   - Verify session pickup
5. Network flap simulation:
   - Disconnect network briefly
   - Verify reconnection
   - Verify no lost state
```

---

## Test Coverage Matrix

| Category | Unit | Integration | E2E | Manual |
|----------|------|-------------|-----|--------|
| Connectivity | ✓ | ✓ | ✓ | |
| Rendering | ✓ | ✓ | ✓ | |
| Keyboard | | ✓ | ✓ | ✓ (IME) |
| Pane Ops | ✓ | ✓ | ✓ | |
| Window Ops | | ✓ | ✓ | |
| Pane Groups | ✓ | ✓ | ✓ | |
| Floats | | ✓ | ✓ | |
| Mouse | | | ✓ | ✓ |
| Copy Mode | | ✓ | ✓ | |
| Status Bar | ✓ | ✓ | ✓ | |
| Session | | ✓ | ✓ | |
| Reconnection | | ✓ | ✓ | |
| OSC | ✓ | ✓ | ✓ | |
| Popups | | ✓ | ✓ | |
| Performance | | | ✓ | ✓ |
| Workflows | | | | ✓ |

---

## Priority Order for Implementation

### P0 - Critical Path (Must have)
1. Basic connectivity & rendering (1.1, 1.2)
2. Basic keyboard input (2.1, 2.2)
3. Pane split/close (3.1, 3.4)
4. Window create/navigate (4.1, 4.2)
5. Session persistence (10.1)

### P1 - Core Features
1. Pane navigation & resize (3.2, 3.3)
2. Pane zoom (3.5)
3. Window management (4.3)
4. Copy mode basics (8.1, 8.2)
5. Reconnection (10.2)

### P2 - Enhanced Features
1. Pane groups (5.x)
2. Mouse events (7.x)
3. Floating panes (6.x)
4. OSC protocols (11.x)

### P3 - Polish
1. Performance tests (13.x)
2. Complex workflows (14.x)
3. Popup support (12.x)
4. IME input (2.5)
