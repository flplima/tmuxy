# Agent inbox bridge (spike)

> _A spike, off by default. Nothing here is on unless `@tmuxy-send-inbox` is `on`._

`tmuxy pane send` types keys into a pane. For a coding agent that has a messaging inbox of its own, typing is the worst way in: the keys land in whatever the user half-typed, and a key that reaches a prompt could answer it. Claude Code binds a per-session inbox socket on the machine, and a message posted there arrives as a message, never as keys. This spike posts to that inbox instead of typing.

## what Claude Code documents

From its public docs on cross-session messaging:

- Each session with messaging on binds a Unix socket (a named pipe on native Windows) and exports its path to hooks as `CLAUDE_CODE_MESSAGING_SOCKET`, before any `SessionStart` hook runs.
- It also exports a per-session token, `CLAUDE_CODE_MESSAGING_TOKEN`. A connection may open with an auth line carrying it. On macOS and Linux the line is optional.
- The socket is restricted to the user. A connection that sends no complete line within 30 seconds is closed.
- A message from outside the session runs through the session's inbound controls (`crossSessionInbound`: accept, hold or refuse). A session that bypasses permission prompts holds it for the user by default.
- **A message can never approve anything.** It never counts as the user's consent and cannot answer a pending permission prompt. Commands in it arrive as plain text.
- A message reaches the agent between tool calls while it works, or starts a turn when it is idle.

What the docs do not give is the line a script writes to post a message. Only the auth line is documented. See [open questions](#open-questions).

## how the spike works

```
 Claude Code session in pane %3
   │ SessionStart hook (tmuxy agent install)
   │   records the Claude process above it (pid and start time) and
   │   CLAUDE_CODE_MESSAGING_SOCKET's path, never the token, in the
   │   pane's @tmuxy-agent-inbox (only with @tmuxy-send-inbox on)
   ▼
 tmuxy pane send -t %3 --inbox 'the tests pass now'
   │ the same question as any send into another pane
   │ refused when the bridge is off, no inbox is recorded,
   │ the program in front is not Claude Code, the recorded process has
   │ ended, the pane is at a prompt, or a word is a key name
   ▼
 the path checked: absolute, a .sock socket (not a symlink), owned by
 the user, in a directory owned by the user and writable by no one else
   ▼
 one line posted to the socket, then the connection closes
```

- **The path, never the token.** A pane option is readable by anything that can talk to the tmux server. The token would let a process pass as the session's own child. The hook never records it, and tmuxy never reads another process's environment to find it.
- **No fallback to typing.** If the bridge cannot post, the send fails with exit 1 and nothing is typed.
- **Still refused at a prompt.** The inbox could take a message while the agent waits at a permission prompt, and Claude Code guarantees the message cannot answer it. tmuxy refuses anyway, so the rule stays one rule: nothing is delivered to a pane at a prompt.
- **Pinned to the session's own process.** The hook records the Claude Code process it runs under, by pid and start time, beside the path. A post goes only while that very process still runs and `claude` is in front of the pane. A session that dies without its `SessionEnd` hook leaves its record behind, but a later process at the same pid, or at the same path, never receives its posts. `SessionEnd` takes the record off.
- **Same entry points.** `--inbox` goes with `--queue` and `--wait`. The question, the queue and the wait work as for typed keys. Only the last step changes.
- **Text, not keys.** With `--inbox` the arguments are joined with spaces into one message, and a final `Enter` is dropped. A message is submitted whole, so any other key name (`C-c`, `Up`, `Escape`) is refused.

`tmuxy-core/src/ask/inbox.rs` holds the path checks and the post. `tmuxy-verbs/src/send_cli.rs` routes `--inbox`, and `packages/tmuxy-cli/bin/tmuxy/agent-hook` records the path.

## how it is tested

Only against a fake socket server that the tests start in a private temporary directory. No test connects to, lists or posts to a real session's socket.

- The post: one line arrives at the fake server, with the text intact.
- The checks: a symlink to a socket, a plain file, a relative path, a path without `.sock`, and a socket in a directory others can write are each refused, and nothing is posted.
- The send: bridge off, no inbox recorded, a program other than Claude Code, a record whose process has ended (a stale path), a pane at a prompt, and a key name each exit 1 with nothing posted and nothing typed.
- The hook: with the bridge on it records the Claude process and the path, and never passes the token to tmux. Off, with no Claude process above it, or with a path with odd characters, it records nothing. `SessionEnd` takes the record off.
- The record: it holds for a process that still runs, not for the same pid with another start time.

## open questions

1. **The message line.** The docs document the auth line and nothing else. The spike posts `{"type":"message","text":…}`, an assumption that only the fake server accepts. The format is assumed from the public docs and untested against a real session: verify it before enabling the bridge, or have it documented upstream.
2. **Is a socket post the right door?** Claude Code also documents channels, an MCP server that pushes events into a session. A channel is a supported contract with a sender check. It can also relay permission prompts, which tmuxy must never use. The bridge could be a tmuxy channel instead.
3. **Which agents.** Only Claude Code has an inbox today. Codex and Antigravity keep typed sends.
4. **The token.** Without it, a post from tmuxy is a peer message: delivered to a session that prompts for permissions, held for the user in one that bypasses them. That is the stricter side. Recording the token would make tmuxy pass as the session itself, which the spike refuses to do.
5. **On by default?** It stays off until the format is known and the bridge is tested against a real session.
