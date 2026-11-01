# AI Contribution Policy

Coding with AI agents (Claude Code, Antigravity, Codex, Cursor, Copilot) is welcome here. That is how I build tmuxy too.

To keep reviews fast and protect the codebase from unverified code, follow these four rules when working with an agent.

## 1. Point your agent at `AGENTS.md`

[AGENTS.md](AGENTS.md) is the single instruction file in this repository. Before your agent writes code, have it read [AGENTS.md](AGENTS.md) plus the docs for the area you are changing:

- [docs/TMUX.md](docs/TMUX.md) for control-mode safety and tmux 3.2-3.8 quirks
- [docs/INVARIANTS.md](docs/INVARIANTS.md) for cross-layer promises
- [docs/TESTS.md](docs/TESTS.md) before writing or editing any test
- Folder guides when working in [tests/README.md](tests/README.md), [packages/tmuxy-ui/README.md](packages/tmuxy-ui/README.md), or [packages/tmuxy-cli/README.md](packages/tmuxy-cli/README.md)

## 2. Read and own every line

Read your diff line by line before opening a PR. Remove dead code, unused helpers, and speculative abstractions your agent left behind.

You are responsible for understanding and defending your changes. A human, not an agent, answers review comments.

## 3. Enforce the hard guardrails

Do not let an agent cross these lines:

- **No raw mutating `tmux` subprocesses:** Mutations must flow through control mode or `tmux run-shell`, and `neww` must never be called directly (it crashes tmux 3.3a-3.5a). See [docs/TMUX.md](docs/TMUX.md).
- **No skipped tests or weakened linters:** Never commit `it.skip` / `test.skip`, and never disable or weaken ESLint or Clippy rules.
- **No DOM-only assertions or blind sleeps:** Tests must follow real user paths, verify visible geometry (`getBoundingClientRect()`), and wait on conditions rather than arbitrary timeouts. See [docs/TESTS.md](docs/TESTS.md).

## 4. Share what ran and what you checked by hand

In your PR description, mention:

1. What you tested by hand (and in which mode: web, desktop, or Storybook).
2. Which verification commands your agent ran (for example `npm run check:fast`, `npm run test:cli`, `cargo test --workspace`, or an E2E suite from [docs/CI-TRIAGE.md](docs/CI-TRIAGE.md)).

This is context for review, not a gate against AI use. For large changes touching core seams (control mode, server state, client sequencer/machines, or security boundaries), open an issue or early draft PR first so we agree on the shape before your agent writes a large patch.
