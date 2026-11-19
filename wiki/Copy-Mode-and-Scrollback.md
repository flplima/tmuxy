Scroll back through history, search it, select text and copy it. tmuxy draws scrollback itself, so scrolling feels like a native terminal.

## Scroll

Scroll the wheel up over a pane, or drag a finger on a touch screen. The pane shows its history and your program keeps running. Type a key, press `Escape` or scroll back to the bottom and the view closes.

This is the **scroll view**. It opens only for a pane that is not a full-screen program. In `vim`, `htop`, `less` or Claude Code, the wheel goes to the program.

There are two views:

|           | Scroll view                                        | Copy mode                                      |
| --------- | -------------------------------------------------- | ---------------------------------------------- |
| Opened by | the wheel or a touch scroll up                     | `prefix [`, or Pane ▸ Copy Mode                |
| Cursor    | none                                               | a block cursor                                 |
| Selection | the browser's own                                  | `v`, `V`, `Ctrl+v`                             |
| Keys      | the first key closes the view and goes to the pane | vi keys, below                                 |
| Closed by | typing, `Escape`, or scrolling to the bottom       | `q`, `Escape`, `y`, or scrolling to the bottom |

No mouse gesture opens copy mode. On a phone, a touch-hold selects the word under your finger and does open it.

## Copy mode keys

Press `prefix [` to enter. The keys are vi style, because the default config sets `mode-keys vi`.

| Key                                 | Action                                               |
| ----------------------------------- | ---------------------------------------------------- |
| `h` `j` `k` `l`, arrows             | Move the cursor                                      |
| `0` / `$`                           | Start / end of line                                  |
| `w` `b` `e`                         | Word motions                                         |
| `H` `M` `L`                         | Top, middle, bottom of the screen                    |
| `g g` / `G`                         | Top / bottom of history                              |
| `Ctrl+u` `Ctrl+d` `Ctrl+b` `Ctrl+f` | Half and full pages                                  |
| `[` / `]`                           | Jump to the previous / next shell prompt (see below) |
| `v` or `Space`                      | Start a character selection                          |
| `V`                                 | Select whole lines                                   |
| `Ctrl+v`                            | Toggle a rectangle selection                         |
| `y`                                 | Copy and leave copy mode                             |
| `/` / `?`                           | Search down / up                                     |
| `n` / `N`                           | Next match / the other way                           |
| `q` or `Escape`                     | Leave                                                |

`[` and `]` are on main, not in a release yet.

## Search

Copy mode searches the whole scrollback. _On main, not in a release yet._

1. Press `prefix [`.
2. Press `/` to search down (towards newer lines) or `?` to search up.
3. Type your query and press `Enter`. The cursor jumps to the match.
4. Press `n` for the next match and `N` for the other direction.

In the prompt, `n`, `q` and `j` are text. `Backspace` deletes a character, or closes the prompt when it is empty. `Ctrl+u` clears the query. `Escape` closes the prompt and stays in copy mode. `Enter` on an empty query repeats the last search.

A few facts:

- The search is case-insensitive unless your query has a capital letter.
- It wraps at both ends of the history.
- A match cannot span a wrapped line break.
- If you started a selection with `v` or `V`, it grows with the cursor as you jump.
- The scroll view has no search. Press `prefix [` first.
- "Not found" shows for two seconds when nothing matches.

## Select with the mouse

| Gesture      | Does                                     |
| ------------ | ---------------------------------------- |
| Drag         | Select text                              |
| Double-click | Select a word                            |
| Triple-click | Select a whole line, across wrapped rows |

Outside copy mode the browser does the selecting, so the live screen and the scroll view behave like a web page. In a program that tracks the mouse (`vim`, `htop`), the drag belongs to the program.

When you release the mouse, the text goes to the clipboard at once and a notification says how many characters. The selection stays on screen until your next key.

In copy mode, releasing a drag copies and leaves copy mode, as tmux does by default.

## Select all, copy and paste

| Action                             | macOS   | Linux and web  |
| ---------------------------------- | ------- | -------------- |
| Select the pane's whole scrollback | `Cmd+A` | `Ctrl+Shift+A` |
| Copy                               | `Cmd+C` | `Ctrl+Shift+C` |
| Paste                              | `Cmd+V` | `Ctrl+Shift+V` |

Plain `Ctrl+C` stays the interrupt. Select all does nothing in a full-screen program, since there is no scrollback behind it.

## Right-click a selection

Right-click a selection to open the selection menu:

- **Copy** puts the text on the clipboard.
- **Send keys** types the selection into the pane.

Plugins can add items here too. With nothing selected, a right-click opens the pane's own menu.

## The clipboard from a program

A program inside tmuxy can set your clipboard with the OSC 52 escape sequence.

```bash
# Copies "hello" to your clipboard through OSC 52.
printf '\e]52;c;%s\a' "$(printf hello | base64)"
```

The status line says "Copied…" once the browser accepts it. Firefox and Safari take a clipboard write only right after a key press or click, so a sequence that arrives on its own can be refused there. The status line says so when that happens. Pasting back from the program is not supported.

## Jump between prompts and copy the last output

If your shell marks its prompts (OSC 133), tmuxy shows a bar beside each prompt in the scrollback. _On main, not in a release yet._

| What                          | Where                                             |
| ----------------------------- | ------------------------------------------------- |
| Previous Prompt / Next Prompt | Pane menu                                         |
| `[` and `]`                   | In copy mode                                      |
| Copy Last Output              | Pane menu: copies what the newest command printed |

Copy Last Output takes the rows from the newest command's output mark down to the next prompt, or to the bottom while a command still runs. An output longer than 20,000 rows is refused.

Your shell sends the marks, not tmuxy. bash, zsh and fish have OSC 133 integration scripts, and several prompt themes ship with it. Check your shell's or prompt's docs to switch it on. Then test it:

```bash
# Print a prompt mark by hand: A starts a prompt, C starts command output.
printf '\e]133;A\e\\'
```

It needs tmux 3.4 or newer. On older tmux the prompts read as having none, and nothing fails.

The marks are pane output, so anything that prints to your pane (a `cat`ed file, a remote host) can fake them. Copy Last Output copies what the marks say, so check what you paste.

Known gaps: a failed command's prompt looks like any other, and marks drift in an open view if you resize the pane. Reopen the view to fix it.

## See also

- [[Rich Rendering and Previews]]
- [[Keybindings]]
- [[Panes Groups and Floats]]
- [[Troubleshooting]]
