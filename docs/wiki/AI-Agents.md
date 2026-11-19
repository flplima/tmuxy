> Paste this page into your coding agent and it can set itself up.

How to run coding agents in tmuxy so you can see which one needs you, and how to give them the CLI.

## Why tmuxy for agents

Agents already love tmux. Each one gets a pane. You see them all at once, scroll them, and type into them when they ask.

tmuxy adds three things on top:

- **A state per pane.** Working, waiting for you, failed. It shows on the pane header, the tab and the tree.
- **A CLI an agent can drive.** Split, run, capture, wait. Every command takes `--json` and has exit codes.
- **A question before one agent types into another pane.** See [[Send Permissions]].

## Set up an agent

```sh
# see what is installed and whether it is current
tmuxy agent status

# add the hooks and the skill for every agent found
tmuxy agent install

# or pick one: claude, codex, agy, opencode, pi, crush
tmuxy agent install claude
```

`install` puts two things into the agent's own config. The first is lifecycle hooks that report the agent's state to tmuxy. The second is the tmuxy skill, so the agent knows the CLI.

| Agent                     | Hooks                    | Skill |
| ------------------------- | ------------------------ | ----- |
| `claude` (Claude Code)    | yes                      | yes   |
| `codex`                   | yes                      | yes   |
| `agy` (Antigravity)       | yes                      | yes   |
| `opencode`, `pi`, `crush` | no, their hooks are code | yes   |

OpenCode, Pi and Crush take the skill only. `status` shows their hooks as `unsupported`.

| Option                         | What it does                                                      |
| ------------------------------ | ----------------------------------------------------------------- |
| `--dry-run`                    | Say what would change, write nothing                              |
| `--project`                    | Install into this project's config instead of your home directory |
| `--hooks-only`, `--skill-only` | Install just one half                                             |
| `--force`                      | Replace a `tmuxy` skill that tmuxy did not write                  |

Before it first changes a settings file, tmuxy keeps a `.tmuxy-bak` copy. `tmuxy agent uninstall` removes only what tmuxy added.

`status` reports each item as one of:

| State         | Means                                                     |
| ------------- | --------------------------------------------------------- |
| `current`     | What `install` would write now                            |
| `outdated`    | tmuxy's, but not what `install` writes today. It says why |
| `missing`     | Not there                                                 |
| `foreign`     | A `tmuxy` skill that tmuxy did not write                  |
| `unsupported` | The agent has no place for it                             |

Run `tmuxy agent install` again after you upgrade tmuxy if `status` says `outdated`.

## Print the guide

```sh
tmuxy skill
```

This prints the agent guide: the CLI cheat sheet, the safety rules and the script contract. Point an agent at it if it cannot load skills.

## What each state means

The state sits in the pane's `@tmuxy-pane-state` option. Anything can set it:

```sh
tmuxy pane state working     # also: needs-input, error, unread, idle, clear
tmuxy pane state explain     # where this pane's state came from
```

| State         | Mark                             | Means                             |
| ------------- | -------------------------------- | --------------------------------- |
| `needs-input` | warning triangle                 | A question only you can answer    |
| `error`       | circled x                        | Something failed                  |
| `unread`      | a dot                            | A result nobody has looked at yet |
| `working`     | spinner                          | Busy                              |
| `idle`        | none, the program's icon returns | Stopped or waiting at its prompt  |

A pane that never declared a state has no mark. Closing a `working` or `needs-input` pane asks first. Turn that off with `set -g @tmuxy-confirm-close off`.

How the hooks map to states:

| Agent event                       | State         |
| --------------------------------- | ------------- |
| A prompt, or a finished tool call | `working`     |
| A permission request              | `needs-input` |
| The agent stops                   | `idle`        |
| A failed turn                     | `error`       |
| The session ends                  | cleared       |

tmuxy also reads the screen of a hooked agent's pane every 1.5 seconds for an approval dialog. A dialog on screen reads as `needs-input`. A turn you interrupt with Esc in Claude Code fires no hook, so the pane stays `working` until the next prompt.

A program can also declare its own state in its output, with the OSC 7501 escape sequence. See [[Rich Rendering and Previews]].

## Agents without hooks

_On main, not in a release yet._

Gemini CLI, Aider, Cursor's agent, Amp, OpenCode, Pi and Crush have no hooks that tmuxy installs. tmuxy reads their screens instead. The pane's command must be one of `gemini`, `aider`, `cursor-agent`, `amp`, `opencode`, `pi` or `crush`. An agent started through `node` or `python3` is found by its script name.

| On screen                                                              | State         |
| ---------------------------------------------------------------------- | ------------- |
| An approval dialog (a numbered menu, a question over "Yes", a `(y/n)`) | `needs-input` |
| Changed since the last look                                            | `working`     |
| Unchanged for about 4.5 seconds                                        | `idle`        |

The rules never say `done`. A long silent step reads as `idle`, and a spinner at the prompt keeps a pane `working`. These are known limits.

To add your own rules, put a `<agent>.toml` file in `~/.config/tmuxy/agents/`. It can name a pane command with `command`, and holds `[[rule]]` entries. Each has a `match` regex and a `state` (`needs-input`, `working`, `idle` or `error`).

```toml
# ~/.config/tmuxy/agents/myagent.toml
command = "myagent"

[[rule]]
match = "Proceed\\? \\[y/N\\]"
state = "needs-input"
```

The first rule that matches the bottom of the screen wins. Files are read again every 10 seconds. A file for Claude Code, Codex or Antigravity is refused, since their hooks own their state. So is one naming a bare interpreter such as `node`.

A state set by a hook, by `tmuxy pane state`, by the program or by a send's question is never overwritten by the rules. Ask why a pane has its state with `tmuxy pane state explain`.

## Find the pane that needs you

_On main, not in a release yet._

| Key        | Menu                                | What it does                                                                                   |
| ---------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `prefix A` | View, Activity                      | Open the activity inbox: every pane that declared a state, in every session, most urgent first |
| `prefix U` | View, Go to the Pane That Needs You | Jump to the most urgent pane                                                                   |

The status line also shows counts of panes in `needs-input` and `error`, across every session. Click it to go to that pane, or to open the inbox when there are several. Your phone can push a notice for the same events. See [[Phone and Tablet]].

## Rules agents must follow

These are in the skill. Hold your agent to them.

1. Never run a raw mutating `tmux` command. It can crash tmux while tmuxy is attached. Use `tmuxy pane`, `tmuxy tab` and `tmuxy run`.
2. Read-only `tmux` is fine, like `display-message -p` or `list-panes`.
3. Never use `new-window` or `neww`. Use `tmuxy tab create`.
4. Run anything long (a dev server, a watcher, a test suite) in a labelled pane, not a hidden background job: `tmuxy pane run --label dev -- npm run dev`.
5. Wait, don't poll: `tmuxy pane run --wait -- npm test`. See [[Scripting with the CLI]].
6. _(On main, not in a release yet.)_ Before something costly or irreversible, ask: `tmuxy pane ask "Deploy to prod?" --choice deploy --choice wait`.
7. Close only panes you opened.

## Tell your agent

Paste this into your project's `AGENTS.md` or `CLAUDE.md`:

```markdown
## tmuxy

This shell runs inside tmuxy. Run `tmuxy skill` for the full guide.

- Never run a mutating raw `tmux` command, and never `new-window`.
  Use `tmuxy pane`, `tmuxy tab` and `tmuxy run`.
- Run long jobs in a labelled pane: `tmuxy pane run --label dev -- npm run dev`.
- To wait for a command: `tmuxy pane run --wait -- npm test`. Do not poll.
- Use `--json` on query commands.
- Ask before anything costly: `tmuxy pane ask "Deploy?" --choice yes --choice no`.
- Typing into another pane asks the user first. Do not try to get around it.
```

## An experiment

An agent inbox bridge exists as a spike. It is off by default (`@tmuxy-send-inbox`). Skip it unless you are curious.

## See also

- [[Sub-agents]]
- [[MCP]]
- [[Send Permissions]]
- [[Security]]
