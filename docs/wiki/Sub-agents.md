_On main, not in a release yet._

Hand work to other agents from one agent or a script. Each helper runs in a pane of its own, and you wait on its state instead of reading its screen.

It works the same for Claude Code, Codex or a shell script, because the commands are plain CLI.

## Start a helper

```sh
# print the pane id and keep going
tmuxy agent spawn --agent claude --label tests --prompt "Run the unit tests and fix what fails"

# same, but return only once the agent is ready
tmuxy agent start tests --agent claude --prompt "Run the unit tests and fix what fails"
```

The new pane lands in the caller's own tab, so run these from a pane. Outside a pane they refuse.

| Option                               | What it does                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `--agent claude\|codex\|gemini\|cmd` | Which agent. `cmd` runs the command after `--` as it is                      |
| `--prompt TEXT`                      | The task, up to 256 KiB                                                      |
| `--prompt-file F`                    | Read the task from a file                                                    |
| `--label L`                          | Names the pane for `agent wait`, `-t` and the tree. Refused if a pane has it |
| `--place stack\|split`               | A collapsible stack row (default), or a split below the caller               |
| `--focus`                            | Move focus to the new pane. Without it, focus stays with you                 |
| `--permission-mode M`                | Passed to the agent as written, under its own option                         |
| `--cwd DIR`                          | Where it starts. Default: your directory                                     |

**Permissions.** tmuxy adds no permission flag of its own. Without `--permission-mode`, the agent starts in whatever mode its own settings give it.

**The task is safe to quote.** It goes through a private wrapper script and never through tmux's parser. Quotes, `;` and `#{}` reach the agent as you wrote them.

To run something that is not a known agent:

```sh
tmuxy agent spawn --agent cmd --label build -- npm run build
```

### Start versus spawn

`start` is `spawn` by name, and it returns once the pane has a state. An agent with tmuxy's hooks sets one when its session starts. One without hooks gets one from the screen rules. Anything can declare its own with `tmuxy pane state`.

It prints `<pane> <label> <state>`, or with `--json` adds `state`. Use `--for 60s` to set how long to wait.

| Outcome                                     | Exit                       |
| ------------------------------------------- | -------------------------- |
| The pane has a state                        | 0                          |
| The pane went away first (the agent exited) | 1                          |
| No state within `--for`                     | 1. The agent keeps running |

Any state counts as ready, `needs-input` too. An agent that opens on a login or trust prompt is ready and waiting for you. Check the state before you hand it work. An agent that never gets a state always waits out `--for`, so use `spawn` for it.

## Wait for it

```sh
# wait until the pane is no longer working
tmuxy agent wait tests --for 20m
```

`wait` takes one or more panes, by id or label. By default it returns when any of them reaches a state other than `working`.

| Option             | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `--until <states>` | Which states end the wait: `idle`, `needs-input`, `error`, `done`, `exited` |
| `--all`            | Wait for every pane, not the first                                          |
| `--now`            | Count a pane that is already in a wanted state                              |
| `--for 10m`        | Give up after this long (`30s`, `10m`, `2h`)                                |
| `--json`           | Include each pane's state and its report                                    |

| Exit | Meaning                                          |
| ---- | ------------------------------------------------ |
| 0    | A pane got there                                 |
| 1    | `--for` ran out                                  |
| 3    | A pane went away (unless you asked for `exited`) |

It checks the state every 250 ms for the first 10 seconds, then every second. A state that comes and goes between two checks is not seen.

## Get the answer

An agent says what it did with `report`, from inside its own pane:

```sh
tmuxy pane report "Fixed 3 failing tests in auth. Two were stale snapshots."
echo "long text" | tmuxy pane report -
```

Whoever started it reads it back:

```sh
tmuxy pane report -t tests
```

A report is what the pane said through tmuxy, not proof. It is at most 64 KiB and stays until the pane writes another, so check its time if you reuse a pane. It survives scrollback and a cleared screen, which a capture does not.

## A worked example

You are in an agent pane. You want a helper to run the tests and fix them while you carry on.

1. Start the helper. Tell it how to report.

   ```sh
   tmuxy agent start tests --agent claude --place split \
     --prompt "Run npm test. Fix failing tests. When done, run: tmuxy pane report '<one paragraph: what you changed>'"
   ```

   It prints something like `%12 tests idle`. The helper is ready.

2. Watch it in the tree, or let your script wait.

   ```sh
   tmuxy agent wait tests --for 20m
   ```

3. Read the report.

   ```sh
   tmuxy pane report -t tests
   ```

4. Look at the helper's pane if you doubt it. Close it when you are done.

   ```sh
   tmuxy pane capture tests --trim | tail -20
   tmuxy pane kill tests
   ```

## Bring a helper back

`tmuxy agent revive <pane>` resumes a Claude Code or Codex session in place, after the agent exited or crashed. The hooks record the session id on the pane. Revive respawns the pane with `claude --resume <id>` (or `codex resume <id>`) and a shell after it.

```sh
# can this pane be revived?
tmuxy agent revive --check %12

# do it
tmuxy agent revive %12
```

It refuses a live pane unless that pane is a shell with no child process. It refuses a pane on a server reached over SSH. The pane menu offers "Revive Agent Session" when revive can work.

Revive is for an agent that was killed or crashed. A normal session end clears the record, so a reused pane never resumes an old chat.

## Fork a conversation

```sh
tmuxy agent fork %12 --branch try-other-approach
```

This carries the pane's conversation into a new git worktree and a new tab, with Claude Code's `--fork-session`. The original conversation stays as it is. The branch defaults to `fork-` plus the first part of the session id.

The fork starts on the commit the pane is on, with its uncommitted work. Changed tracked files are copied. Untracked files come along only with `--untracked`. Only regular files inside the worktree are copied, and anything else is left behind and named. Codex has no fork.

## See also

- [[AI Agents]]
- [[Scripting with the CLI]]
- [[Send Permissions]]
- [[MCP]]
