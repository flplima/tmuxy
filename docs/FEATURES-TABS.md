# Features: tabs, sessions, copy mode and widgets

Part of the capability catalog; [FEATURES.md](FEATURES.md) says how to read a row and what checks it.

## Tabs

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | New tab | the strip's + | `tab-new` | `prefix c` `tab c` | `tmuxy tab create` | — | `tests/2-layout-navigation-overview.test.js` |
| T2 | Switch tabs | click a tab; swipe on a trackpad | `tab-next` `tab-previous` `tab-last` | `root C-Tab` `root C-S-Tab` `tab h` `tab l` `tab 1` `tab 2` `tab 3` `tab 4` `tab 5` `tab 6` `tab 7` `tab 8` `tab 9` `app ctrl+1-9` | `tmuxy tab select` `tmuxy tab next` `tmuxy tab prev` | `@tmuxy-gesture-swipe-tabs` | `tests/2-layout-navigation-overview.test.js` |
| T3 | The tab key table | — | — | `prefix t` | — | — | `tests/2-layout-navigation-tree-drag.test.js` |
| T4 | Rename a tab | rename in the strip | `tab-rename` | `tab ,` | `tmuxy tab rename` | — | `tests/2-layout-navigation-group-drag.test.js` |
| T5 | Close a tab | the tab's ✕ | `tab-close` | `tab x` | `tmuxy tab kill` | — | `packages/tmuxy-ui/src/stories/TabActions.stories.tsx` |
| T6 | Reorder tabs | drag a tab along the strip | — | `app tab <` `app tab >` | — | — | `tests/2-layout-navigation.test.js` |
| T7 | Tab overview, every tab at once | the grid button; pinch in on a trackpad | `tab-overview` | `app prefix w` `app tab o` `app ctrl+0` | — | `@tmuxy-tab-overview-cols` `@tmuxy-gesture-pinch-overview` | `tests/2-layout-navigation-overview.test.js` |
| T8 | Preset layouts | — | `view-layout-*` | — | `tmuxy tab layout` | — | `tests/cli/cli-tab.test.js` |
| T9 | List tabs | the strip, the tree | — | — | `tmuxy tab list` | — | `tests/cli/cli-tab.test.js` |
| T10 | The tab menu | right-click a tab | `menu-tab` | — | — | — | `packages/tmuxy-ui/src/stories/TabActions.stories.tsx` |
| T11 | A tab's preview on hover | hover a tab | — | — | — | — | `packages/tmuxy-ui/src/stories/TabPreview.stories.tsx` |

## Sessions

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | New session | — | `session-new` | — | — | — | `tests/4-session-connectivity-multi.test.js` |
| S2 | Rename the session | — | `session-rename` | — | — | — | — |
| S3 | Detach (the desktop app) | — | `session-detach` | — | — | — | — |
| S4 | Kill the session, after a confirmation | — | `session-kill` | — | — | — | — |
| S5 | Switch sessions | the tree's title | `session:*` | — | `tmuxy session switch` | — | `tests/4-session-connectivity-multi.test.js` |
| S6 | Save, list, restore and forget snapshots | — | `restore:*` | — | `tmuxy session save` `tmuxy session snapshots` `tmuxy session restore` `tmuxy session forget` | — | `tests/15-session-snapshot.test.js` |
| S7 | Attach to another tmux server, over SSH too | the splash's form | `session-connect` `server:*` | — | `tmuxy session connect` `tmuxy connect` | — | `tests/tauri/tauri-app-ssh.test.js` |
| S8 | The session menu | — | `menu-session` | — | — | — | — |
| S9 | Size shared by several clients | — | — | — | — | `@tmuxy-size` | `tests/4-session-connectivity.test.js` |
| S10 | Reconnect after a dropped connection | the overlay | — | — | — | — | `tests/4-session-connectivity.test.js` |

## Copy mode and scrollback

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | Scroll back | the wheel, a touch drag | — | — | — | — | `tests/1-input-interaction-mouse.test.js` |
| C2 | Copy mode: move, select, yank, search | — | `pane-copy-mode` | `copy-mode-vi v` `copy-mode-vi V` `copy-mode-vi C-v` `copy-mode-vi y` `copy-mode-vi Escape` `copy-mode-vi q` `copy-mode-vi /` `copy-mode-vi ?` | — | — | `tests/1-input-interaction-copy.test.js` |
| C3 | Copy what the mouse selects | drag, double- or triple-click | `selection-copy` | `copy-mode-vi MouseDragEnd1Pane` `copy-mode MouseDragEnd1Pane` `app Ctrl+Shift+C` | — | — | `tests/1-input-interaction-clipboard.test.js` |
| C4 | Select all the scrollback | — | — | `app Cmd+A` | — | — | `tests/1-input-interaction-scrollback-select.test.js` |
| C5 | The selection menu | right-click a selection | — | — | — | — | `tests/1-input-interaction-mouse.test.js` |

## Widgets

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W1 | Preview a markdown file or a page in a pane | — | `widget:preview-close` | — | `tmuxy open` `tmuxy widget preview` | — | `tests/14-widget-preview.test.js` |
| W2 | Only a pane that asked draws a widget | — | — | — | — | — | `tests/14-widget-authorisation.test.js` |
