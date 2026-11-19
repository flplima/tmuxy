Split, move, group and float panes with the mouse, the keyboard or the `tmuxy` CLI. The prefix is `Ctrl+a` unless you changed it.

## Split a pane

| What        | Mouse / Menu            | Key                                   | CLI                   |
| ----------- | ----------------------- | ------------------------------------- | --------------------- |
| Split below | Pane ▸ Split Pane Below | `prefix -` or `prefix "`              | `tmuxy pane split -v` |
| Split right | Pane ▸ Split Pane Right | `prefix \|`, `prefix \` or `prefix %` | `tmuxy pane split -h` |

In PANE mode (`prefix p`) the same splits are `-` and `|`. New panes start in the current pane's directory.

## Move focus

| What                 | Key                                        | CLI                                     |
| -------------------- | ------------------------------------------ | --------------------------------------- |
| Focus a neighbour    | `Ctrl+h/j/k/l` or `Ctrl+arrows`, no prefix | `tmuxy nav left`, `right`, `up`, `down` |
| Focus by click       | click the pane                             | `tmuxy pane select %3`                  |
| Next / previous pane | Pane ▸ Next Pane, Previous Pane            | `tmuxy nav next`, `tmuxy nav prev`      |

`Ctrl+h/j/k/l` are bound at the root, so the program in the pane never sees them. That includes `Ctrl+l` (clear) and vim's window moves. To give them back, put `unbind -n C-h` (and `j`, `k`, `l`) in your `tmuxy.conf`. See [[Configuration]].

Navigation is one chain. It goes through group members first, then splits, then the sidebar columns.

## Resize, swap and zoom

| What                      | Mouse / Menu                                                        | Key                                 | CLI                      |
| ------------------------- | ------------------------------------------------------------------- | ----------------------------------- | ------------------------ |
| Resize                    | drag a divider                                                      | `prefix H/J/K/L` (5 cells)          | `tmuxy pane resize -L 5` |
| Swap with previous / next | drag a pane onto another, or Pane ▸ Swap with Previous / Next       | `prefix <` and `prefix >`           | `tmuxy pane swap %3 %4`  |
| Zoom                      | double-click a header, pinch out on a trackpad, or Pane ▸ Zoom Pane | `prefix z`, or `prefix p`, then `z` | `tmuxy pane zoom`        |

Pinch in while zoomed to unzoom. Trackpad gestures are in the desktop app only, and you can turn each off (see [[Configuration]]).

## Mark, swap and join

Mark a pane to swap or join with it later.

1. Open the pane menu (right-click a header, or click its icon) and pick **Mark Pane**. A MARKED badge shows.
2. Open the menu on another pane and pick **Swap with Marked Pane** or **Join Marked Pane Here**.

In PANE mode, `m` marks the active pane.

## Join a pane from another tab

Drag a pane onto a tab in the tab strip. Or press `prefix j` (or `prefix p`, then `g`) and pick a tab from the chooser. The pane lands beside the active one.

## Break a pane out to a tab

```bash
# Move the current pane to a tab of its own.
tmuxy pane break
```

Other ways: drag the pane onto the empty part of the tab strip, use Pane ▸ Move to New Tab, or press `prefix p`, then `b`.

## Close and rename

| What   | Mouse / Menu                                | Key                  | CLI                        |
| ------ | ------------------------------------------- | -------------------- | -------------------------- |
| Close  | the header's ✕, or Pane ▸ Close Pane        | `prefix p`, then `x` | `tmuxy pane kill [target]` |
| Rename | rename in the header, or Pane ▸ Rename Pane | `prefix p`, then `,` | none                       |

Closing a pane asks first while a pane in it says it is working or waiting for you. Set `@tmuxy-confirm-close off` to close at once. _On main, not in a release yet._

## Stack panes

Stacking collapses a tab's panes into rows. Only the row with the active pane stays open, and the others shrink to their headers. Click a collapsed header to open it.

| What                                                       | Key                  |
| ---------------------------------------------------------- | -------------------- |
| Add a row and turn stacking on                             | `prefix p`, then `s` |
| Switch stacking on or off for the rows the tab already has | `prefix p`, then `S` |

The Tab menu has a **Stacked Panes** item for the same switch.

## Group panes

A group puts several panes in one slot. Each member becomes a tab in the pane's header, and only one shows at a time. The others keep running.

```bash
# Add a new pane to the group of pane %3 (starts a group if it has none).
tmuxy pane group add %3
```

| What                    | Mouse / Menu                                           | Key                                              |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Add a pane to the group | drag a pane onto a header, or Pane ▸ Add Pane to Group | `prefix =`, or `prefix p`, then `=`              |
| Switch members          | click a header tab                                     | `Ctrl+h` and `Ctrl+l` step through members first |
| Reorder                 | drag a header tab                                      |                                                  |
| Take a member out       | drag its header tab                                    | `tmuxy pane group leave %3`                      |
| Group a whole tab       |                                                        | `tmuxy pane group all %3`                        |
| Ungroup                 |                                                        | `tmuxy pane group ungroup %3`                    |

Each member has its own ✕ in the header. You can close a hidden member without showing it first.

`tmuxy pane group <verb> --help` explains a verb. The ones to know are `add`, `close`, `switch`, `next`, `prev`, `move`, `join`, `leave`, `all` and `ungroup`. Hidden members live in a session called `__tmuxy_stash`. It is hidden from every list, so leave it alone.

## Float a pane

A float is a pane that sits over its tab, with a backdrop. Press `prefix p`, then `f` for a float with a shell. Close it with ✕, `Escape` or a click on the backdrop.

```bash
# Run a command in a float. It waits and prints the command's output.
tmuxy pane float htop

# Print the float's pane id at once instead of waiting.
tmuxy pane float --detach htop
```

Options of `tmuxy pane float [options] [cmd args...]`:

| Option                                   | Meaning                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--left`, `--right`, `--top`, `--bottom` | Dock the float to an edge as a drawer                                                                                      |
| `--width N`                              | Width in columns (default 60). A top or bottom drawer spans the full width and ignores it                                  |
| `--height N`                             | Height in rows (default 15, never more than the tab's height). A left or right drawer spans the full height and ignores it |
| `--bg MODE`                              | Backdrop: `dim` (default), `blur` or `none`                                                                                |
| `--hide-header`                          | Hide the title bar                                                                                                         |
| `--detach`                               | With a command, print the pane id at once                                                                                  |

A drawer example:

```bash
# A drawer from the right edge with a blurred backdrop.
tmuxy pane float --right --width 50 --bg blur
```

Floats belong to the tab they were opened from. Switch tabs and they stay behind.

### Minimize a float

A float's header has a minimize button. A minimized float becomes a pill at the right end of the tab's bottom edge. Its pane keeps running, so a dev server or a build carries on. Click the pill to bring the float back. _On main, not in a release yet._

## The pane menu

Click a header's icon or right-click the header. The menu has:

- Rename Pane, Split Pane Below, Split Pane Right
- Mark Pane, Swap with Marked Pane, Join Marked Pane Here
- Move to New Tab, Add Pane to Group
- Copy Mode, Paste, Clear Screen, Zoom Pane, Close Pane
- Previous Prompt, Next Prompt, Copy Last Output (see [[Copy Mode and Scrollback]])
- Plugin items, when a plugin adds them (see [[Plugins]])

The Pane submenu in the app menu adds Next Pane, Previous Pane and the two swaps.

## See also

- [[Tabs and Sessions]]
- [[Keybindings]]
- [[Copy Mode and Scrollback]]
- [[CLI Reference]]
