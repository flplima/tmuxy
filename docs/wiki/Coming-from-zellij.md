_Checked against zellij 0.46.0 (the latest GitHub release when I wrote this). Tell me if it has moved on._

Zellij and tmuxy both give you tabs, floating panes, stacked panes and sessions that outlive your window. The difference is where the work happens. Zellij is its own multiplexer, with modes and a plugin system of its own. tmuxy is a GUI on top of tmux, which still holds your sessions.

Zellij's own docs: [zellij.dev/documentation](https://zellij.dev/documentation/).

## Words: zellij to tmuxy

| zellij                                  | tmuxy                                                       |
| --------------------------------------- | ----------------------------------------------------------- |
| session                                 | session                                                     |
| tab                                     | tab                                                         |
| pane                                    | pane                                                        |
| floating pane                           | float                                                       |
| stacked panes                           | stack (`prefix p` then `s`)                                 |
| layout (a KDL file)                     | session snapshot (saved on every change, restored on start) |
| mode (pane, tab, resize...)             | PANE and TAB modes, plus the prefix                         |
| locked mode                             | no equivalent                                               |
| session manager, resurrectable sessions | session switcher, snapshots                                 |
| inbox and attention                     | activity inbox (`prefix A`)                                 |
| plugin (WASM)                           | plugin, see [[Plugins]]                                     |
| web client (`zellij web`)               | web app (`tmuxy server`)                                    |

## Keys: zellij to tmuxy

_`prefix g`, `prefix A` and the command palette are on main, not in a release yet._

Zellij's defaults use `Ctrl` to enter a mode and `Alt` for shortcuts. tmuxy uses one prefix, `Ctrl+a`. The zellij column below is what its docs state. Print the full list with `zellij setup --dump-keybinds default`.

| Action              | zellij                               | tmuxy                                                       |
| ------------------- | ------------------------------------ | ----------------------------------------------------------- |
| New pane            | `Alt n`, or `Ctrl p` then `n`        | `prefix -` or `prefix \|`                                   |
| Split right         | `Ctrl p` then `r`                    | `prefix \|`                                                 |
| Split down          | `Ctrl p` then `d`                    | `prefix -`                                                  |
| Close the pane      | `Ctrl p` then `x`                    | `prefix p` then `x`                                         |
| Move focus          | `Alt` with `h` `j` `k` `l` or arrows | `Ctrl+h` `j` `k` `l` or `Ctrl+arrows`                       |
| New floating pane   | `Ctrl p` then `a`                    | `prefix p` then `f`                                         |
| Show or hide floats | `Alt f`                              | a float closes with `Esc`, its ✕ or a click on the backdrop |
| New tab             | the `NewTab` action                  | `prefix c`                                                  |
| Fullscreen the pane | the `ToggleFocusFullscreen` action   | `prefix z`                                                  |
| Session mode        | `Ctrl o`                             | `prefix g` (go to), `prefix s` (tree)                       |
| Rename the session  | `Ctrl o` then `r`                    | Session menu, Rename Session                                |
| Lock the keys       | `Ctrl g`                             | none                                                        |

## What you gain

- **A real mouse UI.** Drag dividers, drag panes between tabs, right-click menus and a command palette (`Ctrl+Shift+K`).
- **tmux underneath.** Your sessions, your `~/.tmux.conf` (with `tmuxy config use-tmux-conf on`) and tmux's ecosystem all still work.
- **Pane groups.** Several panes in one slot, as header tabs.
- **Images and previews.** Terminal image protocols render inline, and `tmuxy open` previews markdown.
- **Phone access, experimental.** Open the web app from a phone. See [[Phone and Tablet]].
- **An MCP endpoint** so agents can drive a session. See [[MCP]].

## What you give up

- **Zellij's layouts.** Layouts are KDL files you write and apply. tmuxy restores a session's shape from snapshots instead, and `tmuxy tab layout` applies preset layouts.
- **Zellij's plugin system.** Plugins here are a different thing, with their own API.
- **A program you run in a terminal.** tmuxy is its own window or a browser tab. It is not something you start inside another terminal.
- **Locked mode.** tmuxy binds `Ctrl+h`, `Ctrl+j`, `Ctrl+k` and `Ctrl+l` at the root. A program in the pane does not get them unless you unbind them.
- **Windows.** There is no tmuxy build for it.

Zellij does a lot of this well. Its layouts are plain text files that can load from a URL. It has a web client of its own. You can try it without installing it.

## Run both

tmuxy panes are real terminals, so you can run `zellij` inside one. Some tips:

- tmuxy takes `Ctrl+h`, `Ctrl+j`, `Ctrl+k` and `Ctrl+l` before the pane sees them. Use zellij's `Alt` focus keys inside.
- tmuxy's prefix is `Ctrl+a`. Press `Ctrl+a` twice to send a literal `Ctrl+a` to zellij.
- To use zellij's web client beside tmuxy's, give them different ports. Zellij's defaults to 8082 and tmuxy's to 9000.

## See also

- [[Quick Start]]
- [[Coming from tmux]]
- [[Panes Groups and Floats]]
