# Sub-agents in panes

An agent (or a script) that hands work to other agents runs each one in a pane of its own tab, then waits on their states rather than reading their screens. Two verbs do it, both in Rust (`tmuxy-verbs/src/agents/`), so any orchestrator gets the same ones: Claude Code, Codex, a shell script.

## Spawn

`tmuxy agent spawn` starts an agent in a new pane of the caller's tab, with its task, and prints the pane's id (`spawn.rs`).

| Option | What |
| --- | --- |
| `--agent claude\|codex\|gemini\|cmd` | the agent; `cmd` runs the command after `--` as it is |
| `--prompt TEXT`, `--prompt-file F` | the task, up to 256 KiB |
| `--label L` | names the pane for `agent wait`, `-t` and the tree; refused when a pane already has it |
| `--place stack\|split` | a new full-width row of the tab, made a collapsible stack (the default), or a split below the caller |
| `--focus` | moves the focus to the new pane; without it the focus stays with the caller |
| `--permission-mode M` | passed to the agent as written; see below |
| `--cwd DIR` | where it starts; default: the caller's directory |

The pane is always in the caller's tab: spawn needs `TMUX_PANE` and refuses to run outside a pane.

**How each agent takes its task.** Claude Code and Codex take it as the last argument, after `--`, so a task that starts with `-` is not read as an option. Gemini CLI takes it after `--prompt-interactive`, which keeps the session open.

**Permissions.** Spawn adds no permission flag of its own, ever. With `--permission-mode` the caller names one, and it is passed under the agent's own option (Claude Code's `--permission-mode`, Codex's `--ask-for-approval`, Gemini CLI's `--approval-mode`), as one word. Without it, the agent starts in whatever mode its own settings give it.

**The command line.** It runs through a wrapper script in a private temporary directory (mode 0700), which removes itself and then becomes the agent, as `pane run` does. The task never goes through tmux's command parser, so quotes, `;` and `#{}` reach the agent as written.

**Tags** on the new pane:

| Option | Value |
| --- | --- |
| `@tmuxy-spawned-by` | the caller's pane id |
| `@tmuxy-agent` | `claude`, `codex`, `gemini`, or the program `cmd` ran |
| `@tmuxy-label` and the pane title | the label, when one was given |

A report sets one more, `@tmuxy-report-at`: when it was written, in Unix seconds.

## Wait

`tmuxy agent wait <pane>...` waits for panes, by id or label, to change to a state: `idle`, `needs-input`, `error`, `done` or `exited`; by default any but working. The first pane that gets there ends the wait, or every one with `--all`. A pane that goes away ends it with exit 3, unless `exited` was asked for. `--for` gives up with exit 1.

It reads `@tmuxy-pane-state` every 250 ms for the first 10 s, then every second (`wait.rs`). A state reached before the first read, or one that came and went between two reads, is not seen; `--now` counts a pane already in a wanted state. A per-pane change counter, bumped by every writer of the state, would close that gap; it is not written yet.

## Report

`tmuxy pane report <text>` (or `-` for stdin) is how an agent says what it did, for whoever started it (`tmuxy-verbs/src/report_cli.rs`). `tmuxy pane report -t <pane>` reads it back, and `agent wait --json` includes it with each pane's state. A report is what the pane said through tmuxy, not proof: any process of the same user can write the file. It stays until the pane writes another, so one from an earlier turn may still be there: compare its `at` with when the turn began. It survives scrollback and a cleared screen, which a capture does not, and a collapsed stack row is one line tall, so its capture shows almost nothing anyway.

| Rule | Why |
| --- | --- |
| only the pane itself writes its report; `-t` only reads | the shell checks the caller is a process of that pane, as for `restore-cmd` |
| kept in the state dir, `reports/<socket path>/<pane>.txt`, mode 0600 in 0700 directories | a report can say anything the agent saw; two servers sharing a socket name keep apart |
| at most 64 KiB | a summary, not a log |
| counts only while `@tmuxy-report-at` is on the pane | the option goes with the pane, so a pane id a later server hands out again never shows an old report |

## Tests

`spawn_tests.rs` holds each agent's command line, the permission rule (no flag unless named, and only one word), the wrapper's quoting, the placement and the tags. `wait_tests.rs` holds the wait. `tests/21-agent-states.test.js` runs both through the CLI against a real tmux: a `cmd` agent spawned from a pane lands in its tab as a stack row with its tags and header, the focus stays, its task arrives intact, and a taken label is refused. A spawned child writes its report from inside its pane; the orchestrator reads it as text and JSON and gets it from `agent wait --json`, while a write from outside the pane, or one with `-t`, is refused.
