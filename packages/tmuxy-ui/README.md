# tmuxy-ui

The React frontend shared by the web app, the desktop app and the demo. The
project-wide rules are in the root [AGENTS.md](../../AGENTS.md); these are the
ones specific to this package.

## React + XState

1. **Avoid `useEffect`** — side effects belong in the state machine, not components.
2. **Components are for rendering** — business logic goes in XState machines.
3. **Derive, don't sync** — derive values from state instead of syncing them with `useEffect`.
