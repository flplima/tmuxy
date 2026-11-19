Control what an agent or a script may type into a pane that is not its own. The default is to ask you first.

## The question

When something runs `tmuxy pane send -t <pane>` or `tmuxy pane paste -t <pane>` into another pane, that pane shows a question:

```
claude wants to send npm test. Allow?   [Yes] [No]
```

The sender blocks until you answer. Yes types the keys. No, or a timeout, types nothing. The MCP tool `pane_send_keys` asks the same question.

A few rules hold whatever you set:

- **A send into the caller's own pane never asks.** The caller counts as being in a pane only when that pane's process is one of its ancestors.
- **Nothing is typed at a prompt.** If the target needs you or shows an approval dialog, the send is refused, asked or not. A key there could answer it for you.
- **A paste shows its text** as it will land, in the question.
- **A send that skips the question marks the target pane `unread`**, so keys never land in a pane unseen. The mark clears once you look at that pane.

Callers who give up waiting can set `--timeout SECONDS` on the send.

## Switch the question off, or skip it for some

Put these in your `tmuxy.conf` (`tmuxy config init` writes a starter one):

```
# never ask (also: View, Ask Before Sending Keys)
set -g @tmuxy-send-ask off

# don't ask these callers or panes
set -g @tmuxy-send-allow claude,%3

# don't ask when the target pane runs one of these programs
set -g @tmuxy-send-allow-into claude,agy
```

Then run `tmuxy config reload`.

| Option                   | Skips the question when                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `@tmuxy-send-ask off`    | Always                                                                        |
| `@tmuxy-send-allow`      | The caller is on the list, by name (`claude`) or pane id (`%3`)               |
| `@tmuxy-send-allow-into` | The target pane runs one of those programs. Meant for agents typing to agents |

`@tmuxy-send-allow-into claude,agy` also lets MCP clients type into those agents without asking. What it types, that agent then acts on with its own permissions.

An agent cannot change these options through tmuxy.

## Your own rules: permissions.json

_On main, not in a release yet._

`~/.config/tmuxy/permissions.json` holds your rules for what a caller may type into another pane's shell. It does not exist until you write it. tmuxy never writes it.

The file can only make sends stricter than they are without it. This is the first version, and it reads `Send(...)` rules only.

```json
{
  "callers": {
    "claude": {
      "allow": ["Send(gh *)", "Send(npm test)"],
      "ask": ["Send(gh pr merge *)"],
      "deny": ["Send(rm *)", "Send(sudo *)"]
    },
    "*": { "deny": ["Send(shutdown *)"] }
  },
  "shells": ["zsh", "bash", "fish"]
}
```

| Key                    | What it holds                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `callers`              | One section per caller name, and `*` for every caller                                          |
| `allow`, `ask`, `deny` | Lists of rules. `deny` beats `ask` beats `allow`                                               |
| `shells`               | The programs an `ask` or `allow` rule is about. Without it: zsh, bash, fish, sh, dash, ash, nu |

A caller is named the way the question names it:

- the program in front in its pane (`claude`, `codex`)
- the shell it was typed into, when typed at a prompt (`zsh`)
- its process, when it runs in no pane
- for an MCP client, the name it introduced itself with, and `mcp`

A rule is `Send(<pattern>)`. The pattern matches the whole command, and `*` stands for any run of characters. `Send(npm test)` is that command and no other. `Send(gh *)` is `gh` with any arguments. Runs of spaces count as one space.

### What a send gets

| The file                                      | The send                                                      |
| --------------------------------------------- | ------------------------------------------------------------- |
| No file                                       | Asked, unless an option above skips the question              |
| Not valid rules                               | Refused for every send into another pane, with the reason     |
| No section binds the caller                   | As without the file                                           |
| A `deny` rule matches                         | Refused. Exit 1, nothing typed, no question                   |
| A section binds the caller, no `deny` matches | Asked, even where `@tmuxy-send-ask off` would have skipped it |

A section binds its caller even when it is empty. Naming a caller says the file is about it. In this version an `allow` rule does not skip the question. It is reported by the checker, and the send is still asked.

A `deny` rule is tried wide. It looks at the whole text, each line, and each piece between shell operators, so `ls; rm -rf x` is refused by `Send(rm *)`. It applies whatever program the target runs.

An `ask` or `allow` rule judges one command a shell will run. It applies only when the target runs a shell from `shells`, and the keys are text followed by exactly one `Enter`, with no shell operator (`;`, `|`, `&`, `>`, `<`, a backtick, `$(` and so on). Anything else is asked.

The file is read on every send, so an edit holds from the next send on.

### Check a rule without sending

```sh
# does the file read as rules, and which callers does it name?
tmuxy config permissions

# what would this send get?
tmuxy config permissions --caller claude --into zsh -- 'gh pr list' Enter
```

It prints allow, ask, deny or none. Nothing is sent. It exits 1 for a file that is not rules and for a send it denies.

Rules for everyone go under `*`. A named section holds only for a caller that gives that name, and a caller can name itself anything. `*` is the one section a caller cannot leave.

## The send queue

_On main, not in a release yet._

A busy pane can make a script wait. `--queue` puts the send in line while the pane is working or at a prompt, then sends it as any send does, question included.

```sh
# prints the send's id and waits its turn
tmuxy pane send -t agent --queue 'next task' Enter

# what is waiting for this pane
tmuxy pane queue -t agent

# take one back before any of it goes in
tmuxy pane queue -t agent --retract <id>
```

Sends in line go one turn at a time, first come first served. A queued send waits out a prompt and never answers one. A retracted send exits 1 and sends nothing.

Anyone who can run the CLI can retract any queued send.

## Known limits

This is a guardrail for an agent that cooperates. It is not a sandbox.

- Any process of your user can run raw `tmux` on the socket and type into any pane. Close that door in the agent's own permissions. For Claude Code, deny `Bash(tmux *)`, `Bash(tmuxy run *)` and `Bash(tmuxy config *)`.
- `tmuxy pane run` and `tmuxy pane float` start the program they are given with no question. `deny: ["Send(rm *)"]` does not stop `tmuxy pane run rm -rf x`.
- Patterns match text, not meaning. `Send(gh *)` also matches `gh api -X DELETE ...`, and an alias can stand in front of a program.
- `deny` rules are easy to step around on purpose (`command rm`, `/bin/rm`, a line typed in two sends). What gets past one is still asked.
- A `deny` rule also refuses its text where it is no command, like a message to another agent that begins with `rm `.
- Any process of your user can empty or remove the file.
- A program can start in the target pane between the check and the keys.
- Plugins are not bound by any of this.

See [[Security]] for the wider picture.

## See also

- [[Security]]
- [[AI Agents]]
- [[MCP]]
- [[Scripting with the CLI]]
