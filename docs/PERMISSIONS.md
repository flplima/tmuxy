# Permissions file

`permissions.json`, in the config directory (`~/.config/tmuxy`), holds the user's rules for what a caller may type into another pane's shell. It is absent until the user writes it, and tmuxy never writes it.

This is the first version. It reads `Send(...)` rules only, and it can only make a send **stricter** than it is without the file. The parts of the wider design that are not built yet are listed under [Not in this version](#not-in-this-version).

## What it is for, and what it is not

A coding agent in one pane can type into another with `tmuxy pane send -t` or the MCP endpoint's `pane_send_keys`. Both ask the user in the target pane first ([SECURITY.md](SECURITY.md)). The file adds rules on top of that question: commands that are refused without asking, and commands that are asked about even when a tmux option would have skipped the question.

It is a guardrail for an agent that cooperates, not a sandbox. Every process of the same Unix user holds the tmux socket and can type into any pane with raw `tmux`, and a plugin's commands run unsandboxed. The rules bind only callers that go through tmuxy. Close the other doors in the agent's own permissions (for Claude Code: deny `Bash(tmux *)`, `Bash(tmuxy run *)`, `Bash(tmuxy config *)` and the server binary called directly), as SECURITY.md describes.

## The file

```
{
  "callers": {
    "claude": {
      "allow": ["Send(gh *)", "Send(npm test)"],
      "ask":   ["Send(gh pr merge *)"],
      "deny":  ["Send(rm *)", "Send(sudo *)"]
    },
    "*": { "deny": ["Send(shutdown *)"] }
  },
  "shells": ["zsh", "bash", "fish"]
}
```

| Key | What it holds |
| --- | --- |
| `callers` | One section per caller name, and `*` for every caller. A caller is named as the send question names it: the program in front in its pane (`claude`, `codex`), its process when it runs in no pane, and for an MCP client both the name it introduced itself with and `mcp`. |
| `allow`, `ask`, `deny` | Lists of rules. `deny` beats `ask` beats `allow`, across the caller's own section and `*` together. A command no rule matches is asked. |
| `shells` | The programs an `ask` or `allow` rule is about. Optional; without it: zsh, bash, fish, sh, dash, ash, nu. |

A rule is `Send(<pattern>)`. The pattern is matched against the whole command, `*` standing for any run of characters. `Send(npm test)` is that command and no other; `Send(gh *)` is `gh` with arguments. Runs of spaces and tabs count as one space, in the pattern and in the command.

## What a rule is tried against

The two kinds of rule are tried against different things, on purpose. Being wrong about a `deny` only refuses a send, so it is tried wide. Being wrong about an `allow` would skip a question, so it is tried narrow.

**A `deny` rule** is tried first, against everything in the keys that could be a command:

- the text as a whole, each of its lines, and each piece of a line between shell operators (`ls; rm -rf x` is refused by `Send(rm *)`, as `rm -rf x` alone is);
- with or without an Enter, typed or pasted, and with key names read both as keys and as text;
- whatever program the target pane runs. A shell behind `ssh` or `sudo -s`, a shell the list does not name and an editor all read the same keys.

**An `ask` or `allow` rule** judges one command a shell will run, so three things must hold before one is tried. Where one does not, the send is asked:

1. **The target pane runs a shell** from `shells`. In any other program the rules cannot tell what the keys will do.
2. **The keys are text and then exactly one `Enter`, last.** No Enter, an Enter in the middle, `C-m`, a newline inside the text, a paste, or a key name among the text (tmux reads `Up`, `C-c` and the like as keys) is not one command.
3. **The line holds no shell operator**: `;`, `|`, `&`, `>`, `<`, a backtick, `$(`, a parenthesis, a brace, `!`, or `^` at its start, quoted or not. Such a line may run more than the command its first word names (`gh pr list; ls` matches `Send(gh *)`).

## What a send gets

| The file | The send |
| --- | --- |
| No file | As without the feature: asked, unless a tmux option skips the question. |
| A file that is not rules | **Refused**, every send into another pane, with the reason. It is never read as "no rules": one of them may have been the deny for exactly this send. A key written twice in one object is such a file: a plain reader would keep the second and drop the first. |
| No section binds the caller | As without the file. |
| A `deny` rule matches | **Refused.** Exit 1 (`forbidden` over MCP), nothing typed, no question put up. |
| A section binds the caller and no `deny` rule matches | **Asked**, even where `@tmuxy-send-ask off` or an `@tmuxy-send-allow` entry would have skipped the question. That is an `ask` rule, no rule, keys the rules cannot judge, a target that is not a listed shell, and in this version an `allow` rule too (the match is reported by `tmuxy config permissions`). |

A section binds its caller even with no rules in it: naming a caller says the file is about it, and everything it sends is then asked.

A send into the caller's own pane is never the file's business.

The file is read from disk for every send (`tmuxy_core::permissions`, called by `tmuxy-verbs/src/send_cli.rs` and `tmuxy-server/src/mcp/tools/open.rs`). Nothing caches it and nothing mirrors its rules into tmux options, where a process on the socket could rewrite them. An edit holds from the next send on. A question already on screen is not asked again.

`tmuxy config permissions` says whether the file reads as rules and which callers it has a section for, and `tmuxy config permissions --caller claude --into zsh -- 'gh pr list' Enter` says what that send would get, without sending anything.

## What the caller does not get to decide

`tmuxy pane send` runs in the caller's own process, so nothing the caller hands it decides whether the rules are read (`tmuxy-verbs/src/permissions_file.rs`):

- **Where the file is.** It is read from the config directory of the app that configured the tmux server, which the server holds as the option `@tmuxy-config-dir`. The caller's own `XDG_CONFIG_HOME` does not move it. A tmux server no tmuxy of this version configured has no such option, and the caller's own config directory is then all there is.
- **Which pane the caller runs in.** "The target is my own pane" is believed only when the pane's process is the caller or an ancestor of it. A caller that cannot show it is treated as running in no pane, so its send is checked and asked.
- **Over MCP** neither arises: the server reads the file in its own environment and binds every client under its own name, `mcp` and `*`.

What the caller does decide is **its name**. A caller is named by the program in its pane or by what it says its process is, and it can send from a pane it opened. So a named section holds only for a caller that gives that name, and **`*` is the only section a caller cannot leave**. Rules that must hold for everyone go under `*`. `tmuxy config permissions` says so when the file has none.

## Known limits

- **The file is about typing into a pane, not about running commands.** `tmuxy pane run` and `tmuxy pane float`, and their MCP counterparts, start the program they are given in a new pane with no question ([SECURITY.md](SECURITY.md)). `deny: ["Send(rm *)"]` does not stop `tmuxy pane run rm -rf x`. Close those in the agent's own permissions too if the deny list is meant as "my agent cannot run this through tmuxy".
- A pattern matches text, not meaning. `Send(gh *)` also matches `gh api -X DELETE …`, and a shell alias or function can stand in front of the program a rule names.
- `deny` rules are easy to step around on purpose (`command rm`, `/bin/rm`, `X=1 rm`, a line typed in two sends). What gets past one is still asked, so they stop mistakes and the question stops the rest.
- A `deny` rule also refuses its text where it is no command, such as a message to another agent's prompt that begins with `rm `.
- Any process of the same user can empty or remove the file, and nothing says so afterwards.
- A program can start in the target pane between the check and the keys.

## Not in this version

Each of these is a decision still to take, and none is built:

- **An `allow` rule skipping the question.** It needs two answers first: how tmuxy knows the caller is who it says (its pane is verified today, its name is not), and what happens to text already half typed at the target's prompt, which the allowed command would be appended to.
- **Rules for operations other than typing** (`read`, `layout`, `destroy`, `focus`, `admin` with scopes such as `self`, `tab`, `session`). A rule of any kind but `Send` makes the file invalid today, so that none is ever written and silently not enforced.
- **Scopes by pane ownership** (`descendants`), which needs tmuxy to record which pane opened which.
- **Asking for operations other than a send**, and an "always allow" answer that writes a rule.
- **Retiring `@tmuxy-send-ask` and `@tmuxy-send-allow`.** They still decide every send the file does not bind.
