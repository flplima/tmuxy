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
| `tree` | `tmuxy widget tree` | none — the tabs/panes tree is derived from state the app already holds |
| `session` | `tmuxy widget session` | none — the sessions come from the same poll the tree uses, the servers from `list_servers`. Switch, rename, kill or detach the session, and attach to another tmux socket locally or over SSH. What the DETACHED overlay shows, which is the way back in when there is no session to draw behind it. Everyday switching is the `SessionMenu` dropdown instead: a menu costs no tmux window, and switching is a one-line question |

### A pane group's header

A group shares one header between its members: each gets an equal share of the width, its title at the left of that share and its own ⋮ and ✕ at the right, with the member not in view dimmed by a darker ground. Per-member controls are what let a parked member be closed without showing it first. An ungrouped pane keeps the plain shape: one title across the header and its buttons at the header's own right edge.

### A parked widget's name

A pane PARKED in a pane group streams no content, so there is no widget to ask for a title — all a group's tab strip has for it is tmux's `pane_title`. `bin/tmuxy/tmuxy-widget` therefore announces the widget's name over OSC 2 when it starts, so a parked member reads as `tree` rather than as the CLI's own path, and hands the title back on exit.

### A widget's definition

A widget registers a **definition**, not just a component, so it can furnish the parts of the pane
chrome it does not own: its tab `icon`, a `selectTitle` for the tab, and a `selectMenuItems`
section that leads the pane's ⋮ menu. Each is a pure function of machine context plus the pane's
widget content, so a menu that is not the widget's own child can still ask the widget what it can
currently do. Adding a widget means writing a definition and registering it in
`components/widgets/init.ts`; no shared component needs to learn its name.

Widget state that outlives a render belongs in the app machine rather than in the component, so
the menu and the pane read the same source of truth. See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md).
