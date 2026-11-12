# Screen rules: a state for agents without hooks

An agent tmuxy installs hooks for (Claude Code, Codex, Antigravity) says what it is doing, and a program can say it with OSC 7501. Others say nothing: Gemini CLI, Aider, Cursor's agent, Amp, and the agents whose hooks are code (OpenCode, Pi, Crush). Their panes get a state from their screens instead (`tmuxy-core/src/host/socket_watch/agent_rules.rs`).

## Which panes

A pane whose foreground command is `gemini`, `aider`, `cursor-agent`, `amp`, `opencode`, `pi` or `crush`. An agent run by an interpreter is found by the script it runs: tmux names an npm or pip bin script's pane `node` or `python3`, so for an interpreter the foreground process's arguments are read from `/proc` (`tmuxy-core/src/host/socket_watch/agent_rules/program.rs`), and `node ~/.npm/bin/gemini` counts as `gemini`, `python3 -m aider` as `aider`. Off Linux the command stands as tmux names it. The agents with hooks are not read here; their hooks own their state, and a separate reader only watches their screens for approval dialogs ([TMUX-TAGS.md](TMUX-TAGS.md)).

## The signs

Read every pass of the host's socket watch (1.5 s), from the pane's screen:

| On screen | State |
| --- | --- |
| an approval dialog (a numbered menu with its cursor, a question over "Yes", a `(y/n)`) | `needs-input` |
| changed since the last pass | `working` |
| unchanged for 3 passes (about 4.5 s) after it was first seen | `idle` |
| first seen, or still for a shorter time | no change yet |

## Your own rules

A file per agent in `~/.config/tmuxy/agents/` (`tmuxy-core/src/host/socket_watch/agent_rules/user.rs`), named `<agent>.toml`. Its optional `command` key names the pane command it is for (default: the file's name), and each `[[rule]]` has a `match` regex and a `state` (`needs-input`, `working`, `idle` or `error`). A file can name an agent the list above lacks, or add rules to one it has. The first rule that matches the bottom of the screen gives the state, ahead of the signs. Files are read again every 10 s.

A file for an agent with hooks (Claude Code, Codex, Antigravity) is refused, and so is one naming a bare interpreter (`node`, `python3`: it would read every program that runs it; name the script or module instead), and a file with an unknown key, a bad state or a bad pattern, each with its reason in the server's log, once; the other files still load.

Pane output is untrusted and the pattern is the user's, so both are bounded:

| What | Bound |
| --- | --- |
| a pattern | 256 characters, compiled with bounded memory by the plugins' compiler; the `regex` crate matches in linear time, so no pattern backtracks |
| the text a rule reads | the bottom 15 non-empty lines, each cut to 512 characters |
| a file | 64 KiB and 32 rules; 32 files at most |

Nothing in the rules sends keys to a pane: they read the screen and write two pane options.

## A declared state wins

The rules write the state and, beside it, `@tmuxy-rules-state`: what they last wrote. They change `@tmuxy-pane-state` only while it is unset or still equal to that. So a hook, `tmuxy pane state`, a program's OSC 7501 report or a send's question is never overwritten, and the order of precedence holds without any of those writers knowing about the rules. Each write is an `if-shell -F` on the state the pass read, so a state declared between the read and the write is not overwritten either. When the agent's process ends, a state that is still the rules' own is taken off.

## Limits

- **A long silent step reads as idle**: a tool that runs for minutes without printing stops the screen, and after 4.5 s the pane says idle. Herdr's users report the same, which is why the rules never say `done`.
- **A spinner keeps a pane working**, which is right while the agent thinks, and wrong for an agent that animates at its prompt.
- **A declared state equal to the rules' last one** (a hook says working while the rules' note says working too) is taken for the rules' own, and the next sign can change it. A change counter every writer bumps would tell them apart.
- **A wrapped agent** (a script that starts `gemini`) is read only when the agent is the foreground command.

## Tests

`agent_rules_tests.rs` holds the signs, the precedence and the guarded write; `program.rs` the script names; `user_tests.rs` the files, including a pattern that would blow up a backtracking engine run over a screen of million-character lines. `tests/agent_rules.rs` runs fake agents in a real tmux on the test's own socket: a script named `gemini` run by `sh`, which is working while it prints, idle once it holds still, and leaves a state set as a hook sets it alone; and a Node script named in a user's file, whose question reads as needs-input though tmux names the pane `node`.
