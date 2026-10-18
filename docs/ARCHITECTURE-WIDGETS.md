# Widgets

Panes that draw something other than a terminal. Part of [ARCHITECTURE.md](ARCHITECTURE.md).

## Widgets

A **widget** is a React component rendered _in place of_ a pane's terminal. The pane is a real
tmux pane running a real process — it can be focused, navigated into, resized and closed like any
other — but what it draws is a component, not cells.

A pane declares itself a widget by printing a marker line: `__TMUXY_WIDGET__:<name>`, which
`bin/tmuxy/tmuxy-widget` emits before passing stdin through. The frontend scans pane content for
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
| `browser` | `tmuxy open [--color-filter] <file\|url\|host\|->` (alias: `tmuxy widget browser`; a scheme-less target that is not a file is read like an address bar — `localhost:3000` and an IPv4 address as `http://`, `example.com/docs` as `https://`; `--resolve` prints the resolution and opens nothing) | `__SRC__:<path or url>` — one source: an HTML file, a website, a markdown file (rendered, mermaid included), or an image. `--color-filter` writes `__COLOR_FILTER__` first, and a page or image is then recoloured into the theme: each pixel's luminance is looked up in a ramp of the theme's own tones, **darkest first**, so the page keeps its polarity — full black lands on the theme's darkest tone (gruvbox's `#282828`), full white on its lightest (`utils/themeColorFilter.ts`). The stops are sorted by tone, not by role, so `--term-background` is the dark end of a dark theme and the light end of a light one. A framed page is recoloured by a **backdrop filter on a sheet laid over the frame**, not by a `filter` on the frame: a filter on an iframe repaints only the element's own background and stops at the document boundary, leaving the page inside untouched. An image, being in the app's own document, takes a plain `filter`. Markdown is already drawn in theme colours. Under the pane header it draws an **address bar** (`BrowserNav.tsx`): back, forward, refresh, the address, and a hand-off to the system browser — see below for what its history is |
| `tree` | `tmuxy widget tree` | none — the tabs/panes tree is derived from state the app already holds |
| `session` | `tmuxy widget session` | none — the sessions come from the same poll the tree uses, the servers from `list_servers`. Switch, rename, kill or detach the session, and attach to another tmux socket locally or over SSH. What the DETACHED overlay shows, which is the way back in when there is no session to draw behind it. Everyday switching is the `SessionMenu` dropdown instead: a menu costs no tmux window, and switching is a one-line question |

### A pane group's header

A group shares one header between its members: each gets an equal share of the width, its title at the left of that share and its own ⋮ and ✕ at the right, with the member not in view dimmed by a darker ground. Per-member controls are what let a parked member be closed without showing it first. An ungrouped pane keeps the plain shape: one title across the header and its buttons at the header's own right edge.

### The browser's address bar, and whose history it is

Back and forward walk the places the PANE has been pointed — its `__SRC__` marker, then whatever was typed into the bar — held per pane in `browserStates[paneId]` as `history` + `historyIndex`. They are not the page's history, and the address is not necessarily the page's address: the frame is a separate document and, for a website, a separate origin, so neither its current URL nor its navigations can be read from the app. A bar that claimed otherwise would be wrong the first time anyone clicked a link inside the page; this one shows a thing the app actually knows.

Typing an address goes through `normalizeAddress` (`widgets/browser/view.ts`), which gives a bare host the scheme the user meant and leaves a path or an explicit scheme alone — the widget shows local files as readily as websites. Two shapes need telling apart by hand there: `localhost:3000` matches the scheme pattern but is a host and a port, and a loopback host gets `http` rather than `https`, since a dev server is rarely serving TLS and an iframe cannot fall back from a failed load the way a browser can.

**The pane's name** is the page's own `<title>` where the app may read it, and the address otherwise — the order a browser tab uses. Reading it means fetching the HTML: the frame cannot be asked (a local page runs in an opaque origin, a website is another origin, so `contentDocument` is null by design), but the bytes can be fetched for a local file through tmuxy's file route, or for a page the app itself serves. A cross-origin site is left alone — not only because the request would fail, but because firing one that is certain to fail logs a CORS error per page and gains nothing (`widgets/browser/pageTitle.ts`).

A pane PARKED in a pane group is the exception, and it is a tmux one: a stash member streams no content, so there is no widget and no page to read a title from — all a group's tab strip has for it is tmux's `pane_title`. `bin/tmuxy/tmuxy-widget` therefore announces one over OSC 2 when a widget starts (the browser passes its file name), so a parked member reads as `notes.html` rather than as the CLI's own path, and hands the title back on exit.

The hand-off to the system browser is `utils/openUrl.ts` (the desktop asks its Rust side, the web build opens a tab), and it only ever takes http(s)/mailto — so the button is disabled for a local file, with a tooltip saying why, rather than silently doing nothing.

### A widget that embeds a page

The `browser` widget renders its page in an `<iframe>`, and an iframe is a hole in the app's event
surface: every pointer event inside it belongs to that document, so the app sees none of them. Two
things therefore do not come for free, and both have to be arranged around the frame rather than
inside it.

**Activating the pane.** No mousedown reaches the pane wrapper, so the click that should make the
pane active never arrives. Focus is the one signal that does cross the boundary — clicking into a
frame blurs the parent window and makes that `<iframe>` the parent document's `activeElement` — and
`hooks/useFramedPaneFocus.ts` reads it there. The click still reaches the page, so one gesture both
focuses the pane and presses the button under the cursor, the way a terminal pane already behaves
(`usePaneMouse` focuses unconditionally and forwards the same event). A shield over an inactive
frame would instead cost a first click and take wheel scrolling away from an unfocused pane.

**Dragging over it.** A divider drag and a pane drag both run on `mousemove`/`mouseup` listeners on
`window`, which stop arriving the moment the cursor crosses into a frame: the divider froze, and the
release was swallowed too, leaving the app stuck in a resize until some later click landed outside a
frame. `WidgetPane` therefore sets `pointer-events: none` on its content for the length of a drag or
a resize (`useIsDragging` / `useIsResizing`) — nothing inside a pane needs the pointer while the app
is already using it.

A widget registers a **definition**, not just a component, so it can furnish the parts of the pane
chrome it does not own: its tab `icon`, a `selectTitle` for the tab (the browser names its pane
after the page it is showing), a `selectMenuItems` section that leads the pane's ⋮ menu, and an
`onKeyDown` for keys it claims before they reach tmux. Each is a pure function of machine context
plus the pane's widget content, so a menu that is not the widget's own child can still ask the
widget what it can currently do. Adding a widget means writing a definition and registering it in
`components/widgets/init.ts`; no shared component needs to learn its name.

Widget state that outlives a render — the browser's per-pane history and zoom — lives in the app
machine's `browser` slice rather than in the component, so the menu and the pane read the
same source of truth. See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md).
