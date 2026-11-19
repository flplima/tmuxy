Find things fast: a tree of everything, a terminal you can keep beside your panes, a list of every key, a command palette, and an inbox for panes that need you.

## The tree sidebar

The left sidebar lists the attached session's tabs and panes. Each pane row shows its state mark (working, waiting, failed) at the right edge.

| What               | Mouse                                                         | Key                                       |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------- |
| Peek               | rest the pointer on the closed sidebar's toggle in the header |                                           |
| Open, then dock    | click the toggle                                              | `prefix s`, then `prefix s` again to dock |
| Resize             | drag the column's inner edge                                  |                                           |
| Close              |                                                               | `q` in the tree                           |
| Move a pane or tab | drag a row                                                    |                                           |

A **peek** slides the column in over your panes for a moment. It goes away when the pointer leaves. Your panes keep their size, so tmux re-tiles nothing. A click on the toggle docks it. Peek is mouse only, and a tap on a phone docks it.

A **docked** sidebar sits beside the panes and tmux re-tiles them into the room left. Pressing `prefix s` while it is open docks it, and again frees it. Your dragged width is remembered and survives a reload.

Inside the tree, `j` and `k` move, `Enter` goes to the row, `l` hands the keyboard back to the panes and `q` closes the column. `Escape` is not used, so a program in a sidebar can have it.

You can also print the tree in a pane:

```bash
# The same widget the left sidebar draws.
tmuxy widget tree
```

### Switch session from the tree

Click the session's title at the top of the tree. A dropdown lists the sessions on the server, with a box to filter as you type. The desktop app also lists other servers and a way to connect to one. See [[Tabs and Sessions]].

## The right sidebar

`prefix S` opens a right sidebar that holds a real shell. It starts in the current pane's directory. Press `prefix S` again to dock it, and once more to free it.

Closing it hides the column and keeps the shell running. Open it again and the shell is still there. Use it for a long-running command you want beside your work, such as a build or a log tail.

Focus moves in and out of a sidebar with `Ctrl+h` and `Ctrl+l`, or a click on a pane. Prefix keys still act on the tab's panes while a sidebar has focus.

## See every key

Press `prefix ?`. The keys view lists every key, table by table.

For the file and line each key comes from, use the CLI (_on main, not in a release yet_). See [[Keybindings]].

```bash
# Where does prefix t come from?
tmuxy keymap --table prefix t
```

## Command palette

The palette searches every menu item, plus every session, tab and pane.

| Where                                           | Key                     |
| ----------------------------------------------- | ----------------------- |
| Linux and the web                               | `Ctrl+Shift+K`          |
| macOS                                           | `Cmd+K`                 |
| Any OS, for a browser that keeps `Ctrl+Shift+K` | `prefix P`              |
| Menu                                            | View ▸ Command Palette… |

_On main, not in a release yet._

Type a few letters. Then:

| Key                                                 | Does   |
| --------------------------------------------------- | ------ |
| `↑` / `↓`, `Ctrl+N` / `Ctrl+P`, `Ctrl+J` / `Ctrl+K` | Move   |
| `Enter`                                             | Run it |
| `Esc`                                               | Close  |

### Go to a session, tab or pane

`prefix g` opens the palette on places only. View ▸ Go to Session, Tab or Pane… is the same thing. Type `>` to bring the actions back.

If you type a name no session has, you can make a session of that name from the same box.

tmux 3.8 binds `prefix g` to something else. The defaults unbind it so tmuxy can use it. A `g` binding in your own config wins over tmuxy.

## The activity inbox

When agents work in several sessions, the question is "who needs me?". The inbox answers it for the whole server. _On main, not in a release yet._

| Key        | Menu                                 | Does                                  |
| ---------- | ------------------------------------ | ------------------------------------- |
| `prefix A` | View ▸ Activity                      | Open the inbox                        |
| `prefix U` | View ▸ Go to the Pane That Needs You | Jump straight to the most urgent pane |

The inbox lists every pane that declared a state, in every session. Most urgent first:

```
needs-input   a question only you can answer
error         something failed
unread        a result nobody has looked at
working       busy
idle          said it is idle
```

A pane that never declared a state is not listed. Each row shows the pane's name, what its program said (like "Needs your approval") and where it is (`session · tab`).

A pane gets a state from a coding agent's hooks (`tmuxy agent install`), from a program's own report, or from you:

```bash
# Say what this pane is doing: idle, working, needs-input, error or unread.
tmuxy pane state working
```

| Inbox key                                           | Does                                     |
| --------------------------------------------------- | ---------------------------------------- |
| typing                                              | Filter by session, tab, name and message |
| `↓` / `↑`, `Ctrl+N` / `Ctrl+P`, `Ctrl+J` / `Ctrl+K` | Move the highlight                       |
| `Enter`, or a click on a row                        | Go to that pane                          |
| `Escape`, or a click outside                        | Close                                    |

`prefix U` skips the pane in front, since it already has you. With nobody waiting it says "No pane needs you" and stays put.

### Counts on the status line

At the right end of the status line, left of the host name, two counts follow every session. A warning triangle counts panes that need you. A circled x counts panes that failed. A count shows only above zero.

- **One pane in all:** a click goes to that pane.
- **More than one:** a click opens the inbox.

Counts follow a state change in the session you are looking at within about a second. A change in another session can take up to five seconds to show.

### What it does not do

- It does not show how long a pane has been in its state.
- The desktop app sends no OS notifications. The web server can push a notice when a pane needs you (see [[Security]]).
- You cannot mute a tab or a pane yet.
- The in-browser demo has one session, so its inbox stays empty.

## See also

- [[Tabs and Sessions]]
- [[AI Agents]]
- [[Keybindings]]
- [[Phone and Tablet]]
