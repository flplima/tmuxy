# Widgets

Panes that draw something other than a terminal. Part of [ARCHITECTURE.md](ARCHITECTURE.md).

## Widgets

A **widget** is a React component rendered _in place of_ a pane's terminal. The pane is a real
tmux pane running a real process — it can be focused, navigated into, resized and closed like any
other — but what it draws is a component, not cells.

A pane declares itself a widget by printing a marker line: `__TMUXY_WIDGET__:<name>`, which
`packages/tmuxy-cli/bin/tmuxy/tmuxy-widget` emits before passing stdin through. The frontend scans pane content for
it (`components/widgets/registry.ts`), and everything the pane prints after the marker is the
widget's content — the channel a widget's script uses to hand it a payload. The marker alone is
not enough: it is pane output, and anything a pane prints could forge it, so `tmuxy-widget` also
tags the pane with `@tmuxy-pane-widget` out of band before printing, and the frontend renders a
widget only when that tag names the same one (see [SECURITY.md](SECURITY.md) and the option
schema in [TMUX.md](TMUX.md)). The process must stay
alive; closing the pipe fires the wrapper's EXIT trap, which clears the marker and hands the pane
back to a shell. That is what ctrl+c in a widget pane does.

| Widget | Started by | Content it reads |
| --- | --- | --- |
| `tree` | `tmuxy widget tree` | none — the tabs/panes tree is derived from state the app already holds |
| `preview` | `tmuxy open [--net] [--no-theme] [file]` (alias: `tmuxy widget preview`; without a file, `index.html` or `README.md` in the current directory) | `__FILE__:<name>` and `__REV__:<fingerprint>` — the file's name and a line rewritten in place whenever the file changes (inotify where there is one, a poll every second otherwise). The file itself never travels in pane output: the widget reads it with `read_preview`, which tmux authorises (below). A markdown document is drawn by the app, mermaid fences as diagrams and YAML front matter as a block of its own above it, in the theme's colours; an HTML page is drawn in a sandboxed frame, in the theme's colours unless `--no-theme` |

### A preview: what it reads, and the page it frames

A preview's path is a pane option, `@tmuxy-pane-preview`, written by `tmuxy-widget-preview` out of band like the widget tag, and the widget asks for the document by naming its pane, never a path (`read_preview`, both transports, `tmuxy_core::preview`). What it links — stylesheets, scripts, images, fonts — it may read only from the document's own folder. Why, and what else holds, is [A Preview Reads One File](SECURITY-CONTENT.md#a-preview-reads-one-file).

A new rev is the cue to read the document again; the old one stays on screen meanwhile, and on a failed read, so a save never blanks the pane. A markdown document is replaced inside the scroller it was drawn in, so the reader stays where they were. A page is composed by the client (`widgets/preview/previewPage.ts`) — its local resources inlined as code and `data:` URLs, the theme and a small bridge script put first — staged with the backend, and loaded by the frame from a URL that carries the page's own policy as a header. A new composition is a new URL, so the frame reloads, and it reopens at the scroll position the bridge last reported.

The frame is the same hole in the event surface the old browser widget was, and it is handled the same way: the pane is activated from the focus moving into the frame (`hooks/useFramedPaneFocus.ts`), and the pane's content takes no pointer while the app is dragging a divider or a pane. The keyboard is the page's while the user is in it, so the bridge sends a Ctrl or Alt chord pressed there back to the app, replayed on the pane: Ctrl+C reaches `WidgetPane` and ends the widget, the prefix reaches the keyboard actor. In the markdown view the pager keys scroll (`j`/`k`, space and `b`, `ctrl-d`/`ctrl-u`, `g`/`G`), and any other plain key stops at the widget rather than being typed into a pane where nothing reads it.

### A pane group's header

A group shares one header between its members: each gets an equal share of the width, its title at the left of that share and its own ⋮ and ✕ at the right, with the member not in view dimmed by a darker ground. Per-member controls are what let a parked member be closed without showing it first. An ungrouped pane keeps the plain shape: one title across the header and its buttons at the header's own right edge.

### A parked widget's name

A pane PARKED in a pane group streams no content, so there is no widget to ask for a title — all a group's tab strip has for it is tmux's `pane_title`. `packages/tmuxy-cli/bin/tmuxy/tmuxy-widget` therefore announces the widget's name over OSC 2 when it starts, so a parked member reads as `tree` rather than as the CLI's own path, and hands the title back on exit.

### A widget's definition

A widget registers a **definition**, not just a component, so it can furnish the parts of the pane
chrome it does not own: its tab `icon`, a `selectTitle` for the tab, and a `selectMenuItems`
section that leads the pane's ⋮ menu. Each is a pure function of machine context plus the pane's
widget content, so a menu that is not the widget's own child can still ask the widget what it can
currently do. Adding a widget means writing a definition and registering it in
`components/widgets/init.ts`; no shared component needs to learn its name.

Widget state that outlives a render belongs in the app machine rather than in the component, so
the menu and the pane read the same source of truth. See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md).
