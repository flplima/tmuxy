# Features: rendering, the apps, agents and configuration

Part of the capability catalog; [FEATURES.md](FEATURES.md) says how to read a row and what checks it.

## Rich rendering

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Links: OSC 8, and plain URLs with a modifier | click | — | — | — | — | `tests/3-rendering-protocols-links.test.js` |
| R2 | Images: iTerm2, Kitty, Sixel | — | — | — | — | — | `tests/3-rendering-protocols-images.test.js` |
| R3 | Unicode, wide and faint text | — | — | — | — | — | `tests/3-rendering-protocols-unicode.test.js` |
| R4 | OSC 52 clipboard and OSC 2 titles | — | — | — | — | — | `tests/3-rendering-protocols.test.js` |
| R5 | An icon per program | — | — | — | — | `@tmuxy-icon-*` | `tests/22-process-icons.test.js` |

## The desktop and phone apps

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | Several windows | — | `menu-window` `window-new` `window-close` `window-focus-*` | `app Cmd+N` `app Cmd+1-9` | `tmuxy gui` | — | `tests/tauri/tauri-app-windows.test.js` |
| D2 | Window styles | — | `menu-window-style` `window-style-*` | — | — | — | `tests/tauri/tauri-app-windows.test.js` |
| D3 | Transparency, blur and dimming | — | `view-transparency` | — | — | `@tmuxy-transparency` `@tmuxy-blur` `@tmuxy-opacity` `@tmuxy-active-pane-opacity` `@tmuxy-inactive-pane-opacity` `@tmuxy-active-text-opacity` `@tmuxy-inactive-text-opacity` | `tests/16-personalization.test.js` |
| D4 | Native menus | — | — | — | — | `@tmuxy-native-menus` | `tests/tauri/tauri-app.test.js` |
| D5 | Restart or quit the app | — | `restart-app` `quit` | `app Ctrl+Q` | — | — | `tests/tauri/tauri-app.test.js` |
| D6 | The phone layout: 80×25, key row, divider, bottom view | tap, double-tap, hold, slide | — | — | — | — | `tests/12-touch.test.js` |
| D7 | The e-ink page | — | — | — | — | — | `tests/23-kindle.test.js` |
| D8 | Push notifications when a pane needs you | — | `view-notify` | — | — | `@tmuxy-notify` | `tests/20-push.test.js` |
| D9 | Trackpad gestures | slide, pinch | — | — | — | `@tmuxy-gesture-swipe-tabs` | `packages/tmuxy-ui/src/stories/TrackpadGestures.stories.tsx` |

## Agents and the CLI

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | Status | — | — | — | `tmuxy info` | — | `tests/cli/cli-info.test.js` |
| A2 | The agent guide | — | — | — | `tmuxy skill` | — | `tests/cli/cli-help.test.js` |
| A3 | Coding agents' hooks and skill | — | — | — | `tmuxy agent install` `tmuxy agent uninstall` `tmuxy agent status` | — | `tests/cli/cli-agent.test.js` |
| A4 | The MCP endpoint | — | — | — | `tmuxy mcp` | — | `tests/19-mcp.test.js` |
| A5 | A safe raw tmux command | — | — | — | `tmuxy run` | — | `tests/cli/cli-run.test.js` |
| A6 | Reap orphan shells | — | — | — | `tmuxy cleanup` | — | `tests/cli/cli-cleanup.test.js` |
| A7 | The web server | — | — | — | `tmuxy server` | — | `tests/cli/cli-server.test.js` |
| A8 | Traces | — | `menu-debug` `trace-enabled` `trace-level` `trace-open` `trace-copy-path` `debug-copy-state` `trace-copy-share` | — | `tmuxy trace` | — | — |
| A9 | Plugins: actions, links, keys, themes, CLI verbs | — | — | — | `tmuxy plugin` | — | `tests/17-plugins.test.js` |
| A10 | Copy a bug report snippet | — | `debug-copy-report` | — | — | — | `tests/26-bug-report.test.js` |
| A11 | Start an agent in a pane of your own tab with its task, and return once it is ready | — | — | — | `tmuxy agent spawn` `tmuxy agent start` | — | `tests/21-agent-spawn.test.js` |
| A12 | Wait for agents in panes to stop, by their state | — | — | — | `tmuxy agent wait` | — | `tests/21-agent-states.test.js` |
| A13 | An agent's report of what it did, for whoever started it | — | — | — | `tmuxy pane report` | — | `tests/21-agent-spawn.test.js` |
| A14 | Bring an exited agent back into the same conversation | the pane menu's Revive Agent Session | — | — | `tmuxy agent revive` | — | `tests/25-agent-lifecycle.test.js` |
| A15 | Fork an agent's conversation into a new worktree and tab | — | — | — | `tmuxy agent fork` | — | `tests/24-worktrees.test.js` |
| A16 | Worktrees: one for a task with its tab and agent, and removed without losing work | — | — | — | `tmuxy worktree` | — | `tests/24-worktrees.test.js` |
| A17 | Post to a Claude Code session's inbox instead of typing (a spike, off by default) | — | — | — | `tmuxy pane send` | `@tmuxy-send-inbox` | `tests/cli/cli-agent.test.js` |

## Configuration and themes

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| K1 | Config files, reloaded live | — | `session-reload-config` | — | `tmuxy config reload` `tmuxy config init` `tmuxy config paths` `tmuxy config doctor` `tmuxy config use-tmux-conf` `tmuxy config check` | `~/.config/tmuxy/tmuxy.conf` | `tests/16-personalization.test.js` |
| K2 | Themes, light and dark | — | `menu-theme` `theme-mode-*` `theme-set-*` | — | — | `~/.config/tmuxy/themes/` | `tests/16-personalization.test.js` |
| K3 | Custom CSS and CSS variables | — | — | — | — | `~/.config/tmuxy/custom.css` `@tmuxy-css-*` | `tests/16-personalization.test.js` |
| K4 | Text size | ctrl+wheel | `menu-view` `view-font-bigger` `view-font-smaller` `view-font-reset` | `app Cmd+=` `app Cmd+-` `app Cmd+0` | — | — | `packages/tmuxy-ui/src/stories/ThemesAndMenus.stories.tsx` |
| K5 | Blinking cursor | — | `view-cursor-blink` | — | — | `@tmuxy-cursor-blink` | `packages/tmuxy-ui/src/stories/CursorBlink.stories.tsx` |
| K6 | Animations | — | — | — | — | `@tmuxy-animations` | — |
| K7 | Profiles: named sets of the menus' settings, one per session | — | `menu-profiles` `profile-use-*` `profile-*` | — | — | — | `tests/29-profiles.test.js` |
| K8 | Where every key binding comes from | — | — | — | `tmuxy keymap` | — | `tests/cli/cli-keymap.test.js` |
