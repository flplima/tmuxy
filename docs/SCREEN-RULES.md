# Screen rules: a state for agents without hooks

An agent tmuxy installs hooks for (Claude Code, Codex, Antigravity) says what it is doing, and a program can say it with OSC 7501. Others say nothing: Gemini CLI, Aider, Cursor's agent, Amp, and the agents whose hooks are code (OpenCode, Pi, Crush). Their panes get a state from their screens instead (`tmuxy-core/src/host/socket_watch/agent_rules.rs`).

## Which panes

A pane whose foreground command is `gemini`, `aider`, `cursor-agent`, `amp`, `opencode`, `pi` or `crush`. An agent run by an interpreter is found by the script it runs: tmux names an npm or pip bin script's pane `node` or `python3`, so for an interpreter the foreground process's arguments are read from `/proc` (`tmuxy-core/src/host/socket_watch/agent_rules/program.rs`), and `node ~/.npm/bin/gemini` counts as `gemini`, `python3 -m aider` as `aider`. Off Linux the arguments come from `ps`, which joins them with spaces, so a script path with a space in it is cut short there. The agents with hooks are not read here; their hooks own their state, and a separate reader only watches their screens for approval dialogs ([TMUX-TAGS.md](TMUX-TAGS.md)).

## The signs

Read every pass of the host's socket watch (1.5 s), from the pane's screen:

| On screen | State |
| --- | --- |
| an approval dialog (a numbered menu with its cursor, a question over "Yes", a `(y/n)`) | `needs-input` |
| changed since the last pass | `working` |
| unchanged for 3 passes (about 4.5 s) after it was first seen | `idle` |
| first seen, or still for a shorter time | no change yet |

## A declared state wins

The rules write the state and, beside it, `@tmuxy-rules-state`: what they last wrote. They change `@tmuxy-pane-state` only while it is unset or still equal to that. So a hook, `tmuxy pane state`, a program's OSC 7501 report or a send's question is never overwritten, and the order of precedence holds without any of those writers knowing about the rules. Each write is an `if-shell -F` on the state the pass read, so a state declared between the read and the write is not overwritten either. When the agent's process ends, a state that is still the rules' own is taken off.

## Limits

- **A long silent step reads as idle**: a tool that runs for minutes without printing stops the screen, and after 4.5 s the pane says idle. Herdr's users report the same, which is why the rules never say `done`.
- **A spinner keeps a pane working**, which is right while the agent thinks, and wrong for an agent that animates at its prompt.
- **A declared state equal to the rules' last one** (a hook says working while the rules' note says working too) is taken for the rules' own, and the next sign can change it. A change counter every writer bumps would tell them apart.
- **A wrapped agent** (a script that starts `gemini`) is read only when the agent is the foreground command.

## Tests

`agent_rules_tests.rs` holds the signs and the precedence. `tests/agent_rules.rs` runs a fake agent (a Node script named `gemini`, run as node runs an npm bin script) in a real tmux on the test's own socket: working while it prints, idle once it holds still, and a state set as a hook sets it left alone.
