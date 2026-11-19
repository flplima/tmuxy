_Checked against the Rex beta docs on 2026-11-19. Rex is in public testing and changing. Tell me if it has moved on._

Rex, from Superlogical, is a multiplexer with its own macOS app and servers on Linux and FreeBSD. tmuxy is a GUI over tmux. Both keep sessions on a server so you can close the window and come back.

Rex's own docs: [superlogical.com/rex/docs](https://www.superlogical.com/rex/docs).

## Words: Rex to tmuxy

| Rex                             | tmuxy                                   |
| ------------------------------- | --------------------------------------- |
| server                          | the tmuxy server, over tmux             |
| client (the macOS app)          | the desktop app, or a browser           |
| session                         | session                                 |
| window (acts as a tab)          | tab                                     |
| block (a terminal in a split)   | pane                                    |
| `pane.float`                    | float                                   |
| program status (OSC 7501)       | pane state, from the same protocol      |
| `rex` CLI                       | `tmuxy` CLI                             |
| `init.lua` and `rex.bind`       | `tmuxy.conf` and tmux `bind` lines      |
| agent skill (`rex skill setup`) | `tmuxy agent install` and `tmuxy skill` |

Both understand OSC 7501, the status protocol. A program that reports it shows up in either tool.

## Keys: Rex to tmuxy

Rex's defaults on macOS use `cmd` and have no prefix. tmuxy uses a `Ctrl+a` prefix and a few keys without it.

| Action             | Rex (macOS default)          | tmuxy                        |
| ------------------ | ---------------------------- | ---------------------------- |
| Split right        | `cmd+d`                      | `prefix \|`                  |
| Split down         | `shift+cmd+d`                | `prefix -`                   |
| New tab            | `cmd+t`                      | `prefix c`                   |
| Close pane         | `cmd+w`                      | `prefix p` then `x`          |
| Close tab          | `alt+cmd+w`                  | `prefix t` then `x`          |
| Focus a pane       | `alt+cmd+arrows`             | `Ctrl+h` `j` `k` `l`         |
| Next, previous tab | `ctrl+tab`, `ctrl+shift+tab` | `Ctrl+Tab`, `Ctrl+Shift+Tab` |
| Zoom a pane        | `shift+cmd+enter`            | `prefix z`                   |
| Float a pane       | `alt+cmd+enter`              | `prefix p` then `f`          |
| Change session     | `cmd+k`                      | `prefix g`                   |
| Search             | `cmd+f`                      | `/` and `?` in copy mode     |

On macOS, `Cmd+K` in tmuxy opens the command palette instead. _The palette is on main, not in a release yet._

## What you gain

- **MIT licensed, with tmux underneath.** Your sessions and `~/.tmux.conf` still work.
- **Linux desktop.** tmuxy has a Linux app. Rex's Linux support today is the server, and its Linux client is not in public testing.
- **A web app.** Any browser reaches a tmuxy server, with a password off loopback.
- **Pane groups and floats** in the tab and pane model.
- **Safe agent sends.** `tmuxy pane send` asks you first. See [[Send Permissions]].

## What you give up

- **Rex's Lua scripting.** Rex has `rex.bind`, custom actions and Lua scripts. tmuxy configures through tmux options, `tmuxy.conf` and [[Plugins]].
- **A macOS-first key map.** Rex binds `cmd` keys out of the box. tmuxy's defaults are tmux-style, and you add your own binds.
- **Windows and FreeBSD.** Rex has servers for both. tmuxy builds for macOS and Linux.
- **iOS app.** The Rex docs have iOS actions and settings. tmuxy reaches a phone through the browser, and that is experimental.

Rex is new and moving fast. Its docs already cover remote hosts, a server API and an agent skill.

## Run both

A tmuxy pane is a real terminal, so you can use the `rex` CLI from one if a Rex server runs on that machine. A Rex pane can run `tmuxy` commands the same way.

Both keep sessions on a server. Keep one tool per project, so one server owns each session.

## See also

- [[AI Agents]]
- [[Coming from tmux]]
- [[Desktop or Web]]
