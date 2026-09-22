# Agent instructions for tmuxy

**[AGENTS.md](../AGENTS.md) is the instruction file for every agent, this one
included.** Read it: the coding rules, the tmux control-mode constraint, the
test guidelines, the doc index and the commands to run before wrapping up all
live there, and they are not repeated here. A copy would only be a second thing
to keep current, and the copy is what goes stale.

## First commands

1. `bash bin/bootstrap`
2. `npm run check:fast`

## What is different about the Copilot cloud session

- The environment is an ephemeral GitHub Actions runner built by
  `.github/workflows/copilot-setup-steps.yml`. `.devcontainer/` does not apply
  here — a custom container image and `devcontainer.json` are not supported for
  this agent.
- The tooling on top of Node, Rust and tmux comes from `bin/install-dev-tools`,
  the same list the devcontainer image installs. If something an agent needs is
  missing, add it there rather than to this file or the workflow.
- The browser is `agent-browser`'s, and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
  points the Playwright-driven suites at that same binary.
