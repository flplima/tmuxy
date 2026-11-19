Your first five minutes with tmuxy: open it, split, add a tab, move around and find any command.

The prefix key is `Ctrl+a`. On a Mac, `Cmd` replaces `Ctrl` in the shortcuts that are not tmux keys.

## Walk through it

1. **Launch it.** Open tmuxy from your applications menu, or run `tmuxy` in a terminal. No desktop? Run `tmuxy server` and open `http://localhost:9000`. See [[Installation]].

2. **Split a pane.** Press `Ctrl+a`, release, then `-` to split below or `|` to split to the right.

   ```bash
   # The same split from a shell
   tmuxy pane split -h    # to the right
   tmuxy pane split -v    # below
   ```

3. **Move between panes.** `Ctrl+h`, `Ctrl+j`, `Ctrl+k` and `Ctrl+l` go left, down, up and right. The arrow keys with `Ctrl` do the same. Clicking a pane works too.

4. **Resize with the mouse.** Drag a divider. Or press `Ctrl+a`, then `H`, `J`, `K` or `L`.

5. **Open a new tab.** Click the `+` in the tab strip, or press `Ctrl+a` then `c`.
   `Ctrl+Tab` and `Ctrl+Shift+Tab` go to the next and previous tab. `Ctrl+1` to `Ctrl+9` jump to a tab by position.

6. **See every tab at once.** Press `Ctrl+0`.

7. **Find any command.** Press `Ctrl+Shift+K` (`Cmd+K` on a Mac). Type a few letters, use the arrow keys, press `Enter`. If your browser keeps `Ctrl+Shift+K` for itself, use `Ctrl+a` then `P`. _On main, not in a release yet._

8. **See all the keys.** Press `Ctrl+a` then `?` for every key, table by table.

## Drag things around

| Drag                              | What happens                |
| --------------------------------- | --------------------------- |
| A divider                         | Resizes the panes beside it |
| A pane onto another pane          | Swaps them                  |
| A pane onto another pane's header | Groups them (see below)     |
| A pane onto a tab in the strip    | Moves it to that tab        |
| A pane onto the empty strip       | Moves it to a new tab       |
| A tab along the strip             | Reorders the tabs           |

## Groups and floats, in one line each

- **Group:** panes stacked in one slot, shown as tabs in the header. `Ctrl+a` then `=` adds a pane to the current pane's group.
- **Float:** a pane that hovers over its tab. `tmuxy pane float htop` runs a command in one, and it closes when the command ends.

Both are in [[Panes Groups and Floats]].

## The two modes

`Ctrl+a` then `p` enters PANE mode. `Ctrl+a` then `t` enters TAB mode. In a mode, one plain letter runs an action and you are back in normal mode. `Esc` leaves without doing anything. The status line names the mode.

| PANE            | Does               | TAB     | Does                  |
| --------------- | ------------------ | ------- | --------------------- |
| `h` `j` `k` `l` | Move focus         | `h` `l` | Previous and next tab |
| `-` `\|`        | Split below, right | `c`     | New tab               |
| `x`             | Close the pane     | `x`     | Close the tab         |
| `z`             | Zoom and unzoom    | `,`     | Rename the tab        |

## Where to go next

- Your tmux habits and your `~/.tmux.conf`: [[Coming from tmux]]
- Everything you can do with panes: [[Panes Groups and Floats]]
- The keys in full: [[Keybindings]]
- Reach it from your phone: [[Phone and Tablet]]

## See also

- [[Installation]]
- [[Tabs and Sessions]]
- [[Keybindings]]
