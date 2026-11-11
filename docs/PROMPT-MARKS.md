# Shell prompts (OSC 133)

A shell with OSC 133 integration marks its prompts and its commands in its own output. tmuxy reads the marks out of a pane's output, and a long command leaves a result on its pane when it ends.

It is a companion to [RICH-RENDERING.md](RICH-RENDERING.md#program-status-osc-7501) (the pane's state).

## What the shell sends

| Mark | Meaning | Used for |
| --- | --- | --- |
| `OSC 133 ; A` | a prompt starts | ends a `working` or `blocked` program status |
| `OSC 133 ; B` | the prompt ends, typing starts | nothing |
| `OSC 133 ; C` | the command's output starts | the start of the command's run |
| `OSC 133 ; D ; <status>` | the command ended | the result left on the pane |

The shell sends them, never tmuxy: bash, zsh and fish have integration scripts, and several prompts ship with one.

## A long command's end

The parser notes when a command starts (`C`) and how it ends (`D`). One that ran for ten seconds or more leaves a record on the pane, exactly as a program's own OSC 7501 report would (`control_mode/command_finish.rs`):

| Exit status | Record | The pane shows | Tooltip |
| --- | --- | --- | --- |
| 0, or none given | `done` | unread, cleared when the pane is in front | "New output: Finished in 15 s" |
| not 0 | `error` | error, until the next command starts | "Failed: Exit 1 after 15 s" |

A shorter command leaves nothing. The next command (`C`) takes the last one's record off.

`tmuxy server` pushes a notice for it like for any pane state (`tmuxy-server/src/push/watch.rs`). An unread result waits one read of the panes (1.5 s) first: a client that has the pane in front clears it within that time, and what was seen there is not news.

## Not done

- **A setting for the ten seconds.** It is a constant.

## Key files

| File | Responsibility |
| --- | --- |
| `packages/tmuxy-core/src/control_mode/osc.rs` | Reads `A`, `C` and `D` out of a pane's output |
| `packages/tmuxy-core/src/control_mode/command_finish.rs` | What a long command's end leaves on its pane |
| `packages/tmuxy-server/src/push/watch.rs` | The push notice, and the wait before an unread one |

## Tests

- `packages/tmuxy-core/src/control_mode/command_finish.rs` and `control_mode/program_status/tests.rs` hold the timing and the record.
- `tests/21-agent-states.test.js` runs an eleven-second command in a pane that is not in front.
