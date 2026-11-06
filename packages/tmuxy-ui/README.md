# tmuxy-ui

The React frontend shared by the web app, the desktop app and the demo. The
project-wide rules are in the root [AGENTS.md](../../AGENTS.md); these are the
ones specific to this package.

## React + XState

1. **Avoid `useEffect`** — side effects belong in the state machine, not components.
2. **Components are for rendering** — business logic goes in XState machines.
3. **Derive, don't sync** — derive values from state instead of syncing them with `useEffect`.

## Layers

`src/` is four layers, and an import only points down them — ESLint's `no-restricted-imports` holds it (`eslint.config.js`):

| Folder | Holds | Imports |
| --- | --- | --- |
| `domain/` | The model and the vocabulary: wire schemas, ids, ops, decoders of `@tmuxy-*` options, the menu spec's vocabulary (`domain/menus/`). Pure. | `domain/` only |
| `infra/` | The platform and the transport: the desktop shell (`desktop.ts`), the clipboard, the remembered preferences (`prefs.ts`), the theme and font managers, and the DOM the machines read (`infra/dom/`, with the grid's class names in `terminalDom.ts`). | `domain/` |
| `machines/` | The XState machines, their actors, selectors and the types of their state; the drag, resize and gesture machines each keep their own geometry (`machines/drag/`, `machines/gestures/`). | `domain/`, `infra/` |
| `components/` | Rendering, in feature folders where a feature has several files (`terminal/`, `phone/`, `gestures/`, `menus/` with the app's menu specs in `menus/specs/`); a hook lives beside the component that uses it. | everything below |

A type or helper two layers share lives in the lower one. A test may reach up a layer: it drives the seam.

## Stylesheets

1. **A component owns its CSS.** The rules for a component live in a `.css` file beside it, imported by it (`WindowTabs.tsx` → `WindowTabs.css`). `styles/` holds only the surfaces several components share — the pane grid, the terminal, the pane header, the sidebars, the tab overview, the phone layout — and `styles.css` the tokens.
2. **Nothing floats by a number of its own.** Everything laid over the pane grid takes its rung from the `--z-*` ladder in `styles.css`, so the stacking order can be read in one place; a bare `z-index` above the grid is a bug.
