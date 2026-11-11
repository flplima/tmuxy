# Shell prompts (OSC 133)

A shell with OSC 133 integration marks its prompts and its commands in its own output. tmuxy uses the marks for four things: a mark beside each prompt in the scrollback, a jump from prompt to prompt, a copy of what the newest command printed, and a result left on the pane when a long command ends.

It is a companion to [COPY-MODE.md](COPY-MODE.md) (the scrollback views) and [RICH-RENDERING.md](RICH-RENDERING.md#program-status-osc-7501) (the pane's state).

## What the shell sends

| Mark | Meaning | Who reads it | Used for |
| --- | --- | --- | --- |
| `OSC 133 ; A` | a prompt starts | tmux keeps it on the line; tmuxy's parser sees it too | prompt rows; ends a `working` or `blocked` program status |
| `OSC 133 ; B` | the prompt ends, typing starts | nobody | nothing |
| `OSC 133 ; C` | the command's output starts | tmux keeps it on the line; tmuxy's parser notes the time | "Copy Last Output"; the start of the command's run |
| `OSC 133 ; D ; <status>` | the command ended | tmuxy's parser only (tmux keeps no mark for it) | the result left on the pane |

The shell sends them, never tmuxy: bash, zsh and fish have integration scripts, and several prompts ship with one.

## Where the rows come from

tmux (3.4 and later) keeps the `A` and `C` marks on their lines as they scroll into the history. It has no format and no `capture-pane` flag for them. The only thing that finds one is copy mode's `previous-prompt` and `next-prompt`.

So the host reads them by walking (`tmuxy-core/src/host/prompt_marks.rs`):

```
one command list, sent over control mode
  │
  ├─ print the pane's history size and height
  ├─ copy-mode -e                  enter (nothing changes if the user is already in it)
  ├─ history-top, print position   how long the mode's own copy of the history is
  ├─ is there a mark on the last row?   (a step only looks above the cursor)
  ├─ previous-prompt -o, print     the newest output mark
  ├─ previous-prompt, print        ┐ repeated: each step is one prompt,
  ├─ previous-prompt, print        ┘ until the cursor stops moving
  └─ history-bottom, scroll-down   leave
```

- **Nobody sees the mode.** tmux runs a command list in one go. It draws nothing and tells no client about the mode change until the list is over, and by then the pane has left the mode. The monitor's next listing says `in_mode` is off, so the client never opens a copy-mode view for it.
- **Leaving does not end the user's own copy mode.** A mode entered with `-e` is one tmux leaves by itself on `scroll-down` at the bottom. A pane the user already had in copy mode was not entered by the list, so the same `scroll-down` leaves it where it is. A plain `cancel` would have ended theirs.
- **The user's copy mode gets its cursor back.** The walk moves the cursor of a mode it did not enter. So the host first asks where that mode is (scroll position, cursor column and row), and after the walk puts it back: top left, the scroll position, then down and right. A mode with a selection begun is not walked at all, because the steps would drag the selection.
- **A failed list is cleaned up.** tmux stops a list at its first failure, which would skip the leave. The host then sends `cancel`, but only when the list's first line says the pane was in no mode before.
- **Two walks at most.** A probe of four steps answers for a pane with no marks, the common case. If its last step still found a prompt, a second walk of 256 steps follows. The newest 256 prompts are what a pane is read for.
- **Rows are counted from the top of the history**, like the client's scrollback rows, so a row still names its line after the pane prints more.
- **On tmux older than 3.4** the steps do nothing, the cursor never moves, and the pane reads as having no marks. Nothing fails.
- **A `pane-mode-changed` hook of the user's fires** for the mode the walk enters and leaves: twice a walk.

The whole choice sits in that one file. What it answers is rows and text; nothing outside it knows a mode was involved.

## In the scrollback

A view asks for its pane's prompt rows when it opens (`get_prompt_marks`, beside the history fetch) and keeps them as `promptRows` on its record. They are re-keyed with the view's own rows when a chunk corrects the history size.

| What | Where | How |
| --- | --- | --- |
| A mark beside each prompt | both views | a bar in the row's left edge (`ScrollbackTerminal.tsx`) |
| Previous / Next Prompt | Pane menu | from the live screen it asks tmux first, then opens the scroll view with the prompt on its top row |
| `[` and `]` | copy mode | the cursor goes to the prompt above or below it, column 0 |

The scroll view has no cursor, so it moves from its top row. A next prompt that is on the live screen closes the view, which is where that prompt is. Neither key was taken in the client's copy-mode keys.

## Copy Last Output

Pane menu ▸ Copy Last Output (`get_last_command_output`). The output is the rows from the newest `C` mark down to the line before the next prompt, or to the bottom while the command still runs. A prompt on the output's own row means the command printed nothing.

The rows are found by one query and captured by the next, and `capture-pane` counts lines from the top of the screen. A pane that printed in between has moved them. Two checks catch that: the history size must be the same, and the first captured row must read what the walk read on the output's first row (a full history keeps its size while its lines move). A capture that fails either is thrown away and both are asked again, three times at most. Wrapped lines are joined, and the padding at the end of each line and the blank rows below the last one are dropped. An output longer than 20,000 rows is refused.

## A long command's end

The parser notes when a command starts (`C`) and how it ends (`D`). One that ran for ten seconds or more leaves a record on the pane, exactly as a program's own OSC 7501 report would (`control_mode/command_finish.rs`):

| Exit status | Record | The pane shows | Tooltip |
| --- | --- | --- | --- |
| 0, or none given | `done` | unread, cleared when the pane is in front | "New output: Finished in 15 s" |
| not 0 | `done` | the same | "New output: Exit 130 after 2 min 5 s" |

A status that is not 0 is said in the text and is still a result, never `error`. Most long commands that end that way were stopped by the person watching them: Ctrl-C on a server is 130, a closed ssh 255.

A shorter command leaves nothing. The next command (`C`) takes the last one's record off.

`tmuxy server` pushes a notice for a result (`tmuxy-server/src/push/watch.rs`): an `unread` that a report is behind, the shell's or a program's own `done`. It waits one read of the panes (1.5 s) first, because a client that has the pane in front clears it within that time, and what was seen there is not news. The shell's notice says "A command finished", since by then the pane's program is the shell again. An `unread` nothing reported (a send that skipped its question) is not pushed.

## What a pane's output can do with these

The marks are pane output, so a program, a `cat`ed file or a remote host can print them ([SECURITY-CONTENT.md](SECURITY-CONTENT.md)).

- **Choose what Copy Last Output copies**: a `C` mark, then any text. It takes the user's click, and the notice says only how many characters went.
- **Leave a result on its pane and raise its push notice**, every ten seconds at most: a `C`, a wait, a `D`.
- **End another program's `working` or `blocked`** with an `A` mark.
- **Add false prompts to the jump.** A walk reads the newest 256.

## Not done

- **Exit status in the scrollback marks.** tmux keeps no mark for `D`, so a failed command's prompt looks like any other.
- **Rows in an open view are not corrected** when the pane is resized (tmux rewraps the history) or when a full history drops its oldest lines. The marks drift with the view's own rows until it is opened again.
- **A setting for the ten seconds.** It is a constant.
- **The in-browser demo** (v86, CheerpX) answers that a pane has no marks.

## Key files

| File | Responsibility |
| --- | --- |
| `packages/tmuxy-core/src/host/prompt_marks.rs` | The walk, the rows, the last output |
| `packages/tmuxy-core/src/control_mode/osc.rs` | Reads `A`, `C` and `D` out of a pane's output |
| `packages/tmuxy-core/src/control_mode/command_finish.rs` | What a long command's end leaves on its pane |
| `packages/tmuxy-server/src/push/watch.rs` | The push notice, and the wait before an unread one |
| `packages/tmuxy-ui/src/domain/promptMarks.ts` | The jump, as a pure function of a view |
| `packages/tmuxy-ui/src/machines/app/actions/copyMode/promptMarks.ts` | The events: jump, rows loaded, copy last output |

## Tests

- `packages/tmuxy-core/tests/prompt_marks.rs` runs the walk against a real tmux: 41 prompts by row, the last output, no state with the pane in a mode, and a user's copy mode left alone.
- `packages/tmuxy-core/src/host/prompt_marks_tests.rs` holds the parsing and the retries.
- `tests/1-input-interaction-prompts.test.js` drives the menu and the keys in a browser.
- `tests/21-agent-states.test.js` runs an eleven-second command in a pane that is not in front.
