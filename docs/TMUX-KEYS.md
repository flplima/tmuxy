# Keys a Program Receives

How a key pressed in tmuxy reaches the program in a pane, and extended keys. Part of [TMUX.md](TMUX.md).

## The path of a key

The browser or webview holds the keyboard. A chord goes to tmux as a key name through `send-keys` (`tmuxy-ui/src/machines/actors/keyboard/keyFormatting.ts`), and text goes as a literal. tmux then picks the bytes the pane's program reads, from the name and from what that program asked its terminal for.

## Extended keys

In the classic encoding several keys share their bytes: Shift+Enter and Ctrl+Enter read as Enter, Ctrl+I as Tab, Ctrl+M as Enter. The shipped defaults (`tmuxy-core/assets/tmuxy.defaults.conf`) turn the tmux server option `extended-keys` to `on`, and `extended-keys-format` to `csi-u` where tmux has it.

`on` means **only a program that asks gets them**, by writing the xterm request `CSI > 4 ; 1 m` or `CSI > 4 ; 2 m` to its terminal. Editors and coding agents do. A program that asks nothing, a shell for one, reads the same bytes as with the option off. `always` would send them to every program, and is not used.

What a pane reads on tmux 3.5 and later:

| Key | Asked nothing | Asked `CSI > 4 ; 2 m` |
| --- | --- | --- |
| Enter | CR | CR |
| Shift+Enter | CR | `CSI 13 ; 2 u` |
| Ctrl+Enter | CR | `CSI 13 ; 5 u` |
| Tab | TAB | TAB |
| Ctrl+I | TAB | `CSI 105 ; 5 u` |
| Ctrl+M | CR | `CSI 109 ; 5 u` |

With `CSI > 4 ; 1 m` tmux keeps the classic bytes for the keys that have them, so Ctrl+I stays TAB while Shift+Enter is still its own key.

## By tmux version

| | 3.2 to 3.4 | 3.5 and later |
| --- | --- | --- |
| Form sent | CSI u, the only one | CSI u, set by `extended-keys-format` (tmux's own default is xterm's `CSI 27 ; modifier ; code ~`) |
| Ctrl+I, Ctrl+M for a program that asked | TAB, CR: tmux folds them before encoding | their own keys |
| Shift+Enter for a program that asked nothing | the text `S-Enter`: tmux cannot encode the key, so `send-keys` types its name | CR |
| Ctrl+Enter for a program that asked nothing | nothing arrives | CR |
| `extended-keys off` | a program that asks still gets them: the request is only refused under `always` | the request is ignored |

The old versions' column is tmux's own behaviour, the same before and after the option was turned on. `tests/1-input-interaction-extended-keys.test.js` holds the bytes of both columns, on every tmux the nightly matrix runs and on 3.4 at every push.

## Turning it off, and when a change applies

The user's `tmuxy.conf` is sourced after the defaults, so `set -s extended-keys off` there turns it off, and `set -s extended-keys-format xterm` picks the other form (guard that one with `-q` on a tmux older than 3.5).

The defaults are sourced on every connect and reload, so a tmux server that was already running takes the options then, with no restart. tmux reads the option **when a program asks**: a program that asked while it was off (one left running from before an upgrade of tmuxy) stays on the classic keys until it asks again, usually by being restarted. Deleting an override from `tmuxy.conf` and reloading puts the default back.

No config is sourced on a server reached over SSH, and only the essentials on the user's own tmux server, so both keep their own setting.

A real terminal attached to the same server (`tmux attach`) is also asked for extended keys, when tmux knows that terminal supports them.

## What is not there

- **The Kitty keyboard protocol.** tmux does not implement it: `CSI > 1 u` is ignored and `CSI ? u` gets no reply. A program that speaks only that protocol sees a classic terminal.
- **Shift on a Ctrl+letter chord.** Ctrl+Shift+P reaches tmux as `C-p`, so it reads as Ctrl+P. Sending the Shift is not safe: for a program that asked nothing, tmux 3.2 to 3.4 type the text `C-S-p`.
