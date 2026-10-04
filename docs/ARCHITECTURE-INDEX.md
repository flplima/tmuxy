# Architecture Index

Feature-to-files retrieval map for agents.

| Feature                                                    | Key files                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tmux control-mode command routing                          | `packages/tmuxy-core/src/command_router.rs`<br>`packages/tmuxy-ui/src/tmux/adapters.ts`                                                                                                                                                          |
| Backend state aggregation and emit                         | `packages/tmuxy-core/src/control_mode/state.rs`<br>`packages/tmuxy-server/src/state.rs`                                                                                                                                                          |
| SSE/HTTP server flow                                       | `packages/tmuxy-server/src` (see docs references)                                                                                                                                                                                                |
| Frontend state machine                                     | `packages/tmuxy-ui/src` (XState machine and hooks)                                                                                                                                                                                               |
| CLI dispatcher and event queue                             | `bin/tmuxy-cli`                                                                                                                                                                                                                                  |
| Tauri bridge and desktop shell                             | `packages/tmuxy-tauri-app`                                                                                                                                                                                                                       |
| GUI windows on one session, and the Window menu            | `packages/tmuxy-tauri-app/src/windows.rs`<br>`packages/tmuxy-ui/src/components/menus/WindowMenu.tsx`<br>`packages/tmuxy-ui/src/utils/guiWindows.ts`                                                                                              |
| Window styles (iTerm2's set)                               | `packages/tmuxy-tauri-app/src/window_style.rs`                                                                                                                                                                                                   |
| Menus, the tab preview, and the one-surface-at-a-time rule | `packages/tmuxy-ui/src/components/floating/Menu.tsx`<br>`packages/tmuxy-ui/src/components/floating/useFloatingSurface.ts`<br>`packages/tmuxy-ui/src/components/floating/surfaceRegistry.ts`<br>`packages/tmuxy-ui/src/components/TabPreview.tsx` |
| Browser widget: a page framed in the viewer's browser      | `packages/tmuxy-ui/src/components/widgets/browser/TmuxyBrowser.tsx`<br>`packages/tmuxy-ui/src/components/widgets/browser/source.ts`                                                                                                              |
| Browser widget: a page rendered by an engine on the SERVER | `packages/tmuxy-server/src/browser/` (discover, engine, pipe, process, session, verbs, client)<br>`packages/tmuxy-ui/src/components/widgets/browser/SessionView.tsx`<br>`bin/tmuxy/tmuxy-browser-pane`                                           |
| Copy mode behavior                                         | `docs/COPY-MODE.md` + related UI files                                                                                                                                                                                                           |
| Rich rendering / OSC / image protocols                     | `docs/RICH-RENDERING.md`                                                                                                                                                                                                                         |
| Performance harnesses                                      | `perf`<br>`packages/tmuxy-ui/scripts`                                                                                                                                                                                                            |
| E2E and helper layers                                      | `tests`<br>`tests/helpers`                                                                                                                                                                                                                       |

## Related docs

- `docs/ARCHITECTURE.md`
- `docs/STATE-MANAGEMENT.md`
- `docs/DATA-FLOW.md`
- `docs/TMUX.md`
- `docs/RUNBOOK.md`
- `docs/CI-TRIAGE.md`
