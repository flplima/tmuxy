# Permissions file

`permissions.json`, in the config directory (`~/.config/tmuxy`), holds the user's rules for what a caller may type into another pane's shell. It is absent until the user writes it, and tmuxy never writes it.

This is the first version. It reads `Send(...)` rules only, and it can only make a send **stricter** than it is without the file. The parts of the wider design that are not built yet are listed under [Not in this version](#not-in-this-version).

## What it is for, and what it is not

A coding agent in one pane can type into another with `tmuxy pane send -t` or the MCP endpoint's `pane_send_keys`. Both ask the user in the target pane first ([SECURITY.md](SECURITY.md)). The file adds rules on top of that question: commands that are refused without asking, and commands that are asked about even when a tmux option would have skipped the question.

It is a guardrail for an agent that cooperates, not a sandbox. Every process of the same Unix user holds the tmux socket and can type into any pane with raw `tmux`, and a plugin's commands run unsandboxed. The rules bind only callers that go through tmuxy. Close the other door in the agent's own permissions (for Claude Code: deny `Bash(tmux *)`, `Bash(tmuxy run *)` and `Bash(tmuxy config *)`), as SECURITY.md describes.

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
| `shells` | The programs a `Send` rule is about. Optional; without it: zsh, bash, fish, sh, dash, ash, nu. |

A rule is `Send(<pattern>)`. The pattern is matched against the whole command, `*` standing for any run of characters. `Send(npm test)` is that command and no other; `Send(gh *)` is `gh` with arguments. Runs of spaces and tabs count as one space, in the pattern and in the command.

## What counts as a command

A `Send` rule judges a command a shell will run, so three things must hold before a rule is even tried:

1. **The target pane runs a shell** from `shells`. Text typed into an editor or an agent's prompt is not a shell command, and the file has nothing to say about it.
2. **The keys are text and then exactly one `Enter`, last.** No Enter, an Enter in the middle, `C-m`, a newline inside the text, a paste, or a key name among the text (tmux reads `Up`, `C-c` and the like as keys) is not one command. It is asked.
3. **The line holds no shell operator**: `;`, `|`, `&`, `>`, `<`, a backtick, `$(` or `!!`, quoted or not. Such a line may run more than the command its first word names (`gh pr list; rm -rf x` matches `Send(gh *)`). It is asked, whatever the rules say.

## What a send gets

| The file | The send |
| --- | --- |
| No file | As without the feature: asked, unless a tmux option skips the question. |
| A file that is not rules | **Refused**, every send into another pane, with the reason. It is never read as "no rules": one of them may have been the deny for exactly this send. |
| No section binds the caller, or the target runs no shell | As without the file. |
| A `deny` rule matches | **Refused.** Exit 1 (`forbidden` over MCP), nothing typed, no question put up. |
| An `ask` rule matches, no rule matches, or it is not a command the rules can judge | **Asked**, even where `@tmuxy-send-ask off` or an `@tmuxy-send-allow` entry would have skipped the question. |
| An `allow` rule matches | **Asked**, in this version. The match is reported by `tmuxy config permissions`. |

A send into the caller's own pane is never the file's business.

The file is read from disk for every send (`tmuxy_core::permissions`, called by `tmuxy-verbs/src/send_cli.rs` and `tmuxy-server/src/mcp/tools/open.rs`). Nothing caches it and nothing mirrors it into tmux options, where a process on the socket could rewrite it. An edit holds from the next send on. A question already on screen is not asked again.

`tmuxy config permissions` says whether the file reads as rules, and `tmuxy config permissions --caller claude --into zsh -- 'gh pr list' Enter` says what that send would get, without sending anything.

## Known limits

- A pattern matches text, not meaning. `Send(gh *)` also matches `gh api -X DELETE …`, and a shell alias or function can stand in front of the program a rule names.
- `deny` rules are easy to step around on purpose (`command rm`, `/bin/rm`, `X=1 rm`). They stop mistakes, not intent.
- A caller is named by what it says it is. Since this version only restricts, a caller that lies about its name can only escape a restriction, never gain a permission.
- A program can start in the target pane between the check and the keys.

## Not in this version

Each of these is a decision still to take, and none is built:

- **An `allow` rule skipping the question.** It needs two answers first: how tmuxy knows the caller is who it says (a verified pane ancestry, an agent tag), and what happens to text already half typed at the target's prompt, which the allowed command would be appended to.
- **Rules for operations other than typing** (`read`, `layout`, `destroy`, `focus`, `admin` with scopes such as `self`, `tab`, `session`). A rule of any kind but `Send` makes the file invalid today, so that none is ever written and silently not enforced.
- **Scopes by pane ownership** (`descendants`), which needs tmuxy to record which pane opened which.
- **Asking for operations other than a send**, and an "always allow" answer that writes a rule.
- **Retiring `@tmuxy-send-ask` and `@tmuxy-send-allow`.** They still decide every send the file does not bind.
