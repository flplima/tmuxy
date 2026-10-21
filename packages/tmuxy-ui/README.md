# tmuxy-ui

The React frontend shared by the web app, the desktop app and the demo. The
project-wide rules are in the root [AGENTS.md](../../AGENTS.md); these are the
ones specific to this package.

## React + XState

1. **Avoid `useEffect`** — side effects belong in the state machine, not components.
2. **Components are for rendering** — business logic goes in XState machines.
3. **Derive, don't sync** — derive values from state instead of syncing them with `useEffect`.

## Stylesheets

1. **A component owns its CSS.** The rules for a component live in a `.css` file beside it, imported by it (`WindowTabs.tsx` → `WindowTabs.css`). `styles/` holds only the surfaces several components share — the pane grid, the terminal, the sidebars, the tab overview — and `styles.css` the tokens.
2. **Nothing floats by a number of its own.** Everything laid over the pane grid takes its rung from the `--z-*` ladder in `styles.css`, so the stacking order can be read in one place; a bare `z-index` above the grid is a bug.
