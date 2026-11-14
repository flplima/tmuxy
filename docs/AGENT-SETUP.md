# Agent setup

`tmuxy agent install|uninstall|status [agent]...` puts tmuxy into a coding agent's own config: lifecycle hooks that set the pane's state, and the tmuxy skill. What the hooks do is in [TMUX-TAGS.md](TMUX-TAGS.md); this is what is installed where, and how to tell whether it is current.

## Where things go

| Agent | Hooks | Skill |
| --- | --- | --- |
| `claude` | `$CLAUDE_CONFIG_DIR/settings.json` (else `~/.claude/`) | `$CLAUDE_CONFIG_DIR/skills/tmuxy` |
| `codex` | `$CODEX_HOME/hooks.json` (else `~/.codex/`) | `~/.agents/skills/tmuxy` |
| `agy` | `~/.gemini/config/hooks.json` | `~/.gemini/config/skills/tmuxy` |

With `--project` they go under the project instead: Claude Code's hooks in its local settings (settings.local.json, a hook names a path on this machine) and its skill in its skills folder, Codex's hooks in the project's .codex folder, Antigravity's in .agents, and the Codex and Antigravity skill in .agents/skills.

A skill tmuxy wrote has a `.tmuxy-version` file beside its `SKILL.md`; one without it is someone else's, and `install` leaves it alone unless `--force`, which moves it aside. A settings file gets a `.tmuxy-bak` copy before tmuxy first changes it, and a symlinked one is written through to its target.

## Status

`tmuxy agent status` compares each agent's hooks and skill with what an install would write now, by content:

| State | Means |
| --- | --- |
| `current` | what `install` would write now |
| `outdated` | tmuxy's, but not that; it says why: an event missing, a setting changed, the skill's text or version changed |
| `missing` | not there |
| `foreign` | a `tmuxy` skill tmuxy did not write |
| `unreadable` | the settings file is not JSON, or cannot be read |

Hooks installed with another `--hook-command` path still count as current: the path is read back from the installed command. `--json` adds an `agents` list, each with `found` and its hooks' and skill's `path`, `state` and `why`.

`install --dry-run` writes nothing and says, per item, "would be installed", "would be updated" or "up to date".

## Tests

`tmuxy-verbs/src/agents/tests.rs` builds every agent directory under one fresh temp dir and asserts it. In a test build, every write refuses a path outside the system's temp dir, and a test checks that the refusal holds. The E2E suite's environment drops `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `CRUSH_SKILLS_DIR`, which the verbs prefer to `HOME` (`tests/helpers/tmux-socket.js`).
