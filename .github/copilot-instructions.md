# Agent Instructions for tmuxy (Copilot profile)

## First commands to run

1. `bash bin/agent-bootstrap`
2. `npm run agent:fast-check`

## Repository constraints

- Route tmux mutations through control mode; do not add shell/subprocess tmux paths.
- Use existing scripts/workflows/tests; do not introduce new tooling unless required.
- Keep changes surgical and update docs when behavior changes.
- Run checks that match changed areas before finalizing.

## High-signal command map

- Fast validation: `npm run agent:fast-check`
- Full validation: `npm run agent:full-check`
- E2E only: `npm run test:e2e`
- Tauri E2E only: `npm run test:tauri`
- Rust workspace tests: `cargo test --workspace`
- CI parity lint: `npm run lint && npm run lint:tests && (cd packages/tmuxy-ui && npx tsc --noEmit)`

## Key docs

- `docs/ARCHITECTURE.md`
- `docs/TMUX.md`
- `docs/DATA-FLOW.md`
- `docs/TESTS.md`
- `docs/CI-TRIAGE.md`
- `docs/ARCHITECTURE-INDEX.md`

## Copilot-specific note

- GitHub Copilot cloud agent runs `.github/workflows/copilot-setup-steps.yml` before session start.
- The local devcontainer is a contributor environment and is not used by Copilot cloud sessions.
