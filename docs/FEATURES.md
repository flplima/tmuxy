# Features

Everything a user or an agent can do in tmuxy, one row per capability, with how each of the five surfaces reaches it and the test that holds it. [INVARIANTS.md](INVARIANTS.md) is the engine's promises; this is the user's. [NON-GOALS.md](NON-GOALS.md) is what tmuxy leaves out.

The catalog is in three parts: panes, groups, floats and sidebars here; tabs, sessions, copy mode and widgets in [FEATURES-TABS.md](FEATURES-TABS.md); rendering, the desktop app, agents and the CLI, and configuration in [FEATURES-APP.md](FEATURES-APP.md).

## Reading a row

| Column | What it holds |
| --- | --- |
| `Id` | A stable id, by domain: `P` panes, `G` groups, `F` floats, `B` sidebars, `T` tabs, `S` sessions, `C` copy mode and scrollback, `W` widgets, `R` rich rendering, `D` the desktop and phone apps, `A` agents and the CLI, `K` configuration and themes |
| Mouse / UI | What a pointer, finger or trackpad does |
| Menu | The item's id in the app, pane, tab, window or selection menu (`components/menus/specs/`); `prefix*` for items built at run time |
| Keybinding | A default tmux binding as `<table> <key>` (`prefix -`, `pane x`, `root C-h`, `copy-mode-vi v`), from `tmuxy.defaults.conf`; a key the app answers itself as `app <keys>` |
| CLI | The `tmuxy <noun> <verb>` that does it |
| Config / Tag | The `@tmuxy-*` option or `~/.config/tmuxy/` file that turns it on or shapes it |
| Enforced by | The E2E suite, CLI suite or story that exercises it; `—` where nothing does yet |

## How it stays true

`bin/ci/features-catalog.mjs`, part of `npm run check:policy`, reads the code and these docs and fails in both directions:

| When | What fails |
| --- | --- |
| A menu item, default binding, CLI verb or user option is added with no row naming it | the code side: the item is listed with where to add it |
| A row names a menu id, binding, CLI verb or option the code no longer has | the catalog side: the row is listed |
| An `Enforced by` cell names a test by `file › title` that does not exist | `bin/ci/invariant-enforcers.mjs`, as for INVARIANTS.md |

App-answered keys (`app …`), mouse gestures and `Enforced by` paths are not read from code; a path is checked to exist.

## Panes

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Split below | — | `pane-split-below` | `prefix -` `prefix "` `pane -` | `tmuxy pane split` | — | `tests/2-layout-navigation-panes.test.js` |
| P2 | Split right | — | `pane-split-right` | `prefix \|` `prefix \` `prefix %` `pane \|` | `tmuxy pane split` | — | `tests/2-layout-navigation-panes.test.js` |
| P3 | Focus a neighbour | click a pane | — | `root C-h` `root C-j` `root C-k` `root C-l` `root C-Left` `root C-Down` `root C-Up` `root C-Right` `pane h` `pane j` `pane k` `pane l` | `tmuxy pane select` `tmuxy nav left` `tmuxy nav right` `tmuxy nav up` `tmuxy nav down` | — | `tests/2-layout-navigation-groups.test.js` |
| P4 | Next or previous pane | — | `pane-next` `pane-previous` | — | `tmuxy nav next` `tmuxy nav prev` | — | `tests/cli/cli-nav.test.js` |
| P5 | Resize | drag a divider | — | `prefix H` `prefix J` `prefix K` `prefix L` `pane H` `pane J` `pane K` `pane L` | `tmuxy pane resize` | — | `tests/2-layout-navigation-zoom-drag.test.js` |
| P6 | Swap two panes | drag a pane onto another | `pane-swap-prev` `pane-swap-next` | `prefix >` `prefix <` `pane >` `pane <` | `tmuxy pane swap` | — | `tests/2-layout-navigation-zoom-drag.test.js` |
| P7 | Mark a pane, then swap or join with it | the MARKED badge | `pane-mark` `pane-unmark` `pane-swap-marked` `pane-join-marked` | `pane m` | — | — | `tests/2-layout-navigation-panes.test.js` |
| P8 | Join a pane from another tab | drag a pane onto a tab in the strip | — | `prefix j` `pane g` | — | — | `tests/2-layout-navigation-zoom-drag.test.js` |
| P9 | Move a pane to a new tab | drag it onto the empty strip | `pane-move-new-tab` | `pane b` | `tmuxy pane break` | — | `tests/2-layout-navigation-zoom-drag.test.js` |
| P10 | Zoom | double-click a header; pinch on a trackpad | `view-zoom` | `pane z` | `tmuxy pane zoom` | `@tmuxy-gesture-pinch-zoom` | `tests/2-layout-navigation-zoom-drag.test.js` |
| P11 | Close | the header's ✕ | `pane-close` | `pane x` | `tmuxy pane kill` | — | `tests/2-layout-navigation.test.js` |
| P12 | Rename | rename in the header | `pane-rename` | `pane ,` | — | — | `packages/tmuxy-ui/src/stories/InlineRename.stories.tsx` |
| P13 | Clear the screen | — | `pane-clear` | — | — | — | — |
| P14 | Stack a tab's panes, collapsed to headers | click a collapsed row | `tab-stack-toggle` | `pane s` `pane S` | — | — | `tests/2-layout-navigation-panes.test.js` |
| P15 | Run a command in a new pane, and wait for it | — | — | — | `tmuxy pane run` `tmuxy pane wait` | `@tmuxy-label` | `tests/cli/cli-pane.test.js` |
| P16 | List panes | the sidebar tree | — | — | `tmuxy pane list` | — | `tests/cli/cli-pane.test.js` |
| P17 | Read a pane's screen | — | — | — | `tmuxy pane capture` | — | `tests/cli/cli-pane.test.js` |
| P18 | Type or paste into a pane, asked first when it is another's | the send question's buttons | `pane-paste` `selection-send-keys` `view-send-ask` | `app Cmd+Enter` | `tmuxy pane send` `tmuxy pane paste` | `@tmuxy-send-ask` `@tmuxy-send-allow` `@tmuxy-send-allow-into` | `tests/13-send-permission.test.js` |
| P19 | Show what a pane is doing | the state mark on its header and tree row | — | — | `tmuxy pane state` | `@tmuxy-pane-state` | `tests/21-agent-states.test.js` |
| P20 | Say how a pane comes back after a restore | — | — | — | `tmuxy pane restore-cmd` | `@tmuxy-pane-restore` | `tests/15-session-snapshot.test.js` |
| P21 | The pane menu | a header's ⋮ or right-click | `menu-pane` | — | — | — | `packages/tmuxy-ui/src/stories/PaneHeaderActions.stories.tsx` |
| P22 | The prefix and the pane key table | — | — | `prefix C-a` `prefix a` `prefix p` | — | — | `tests/2-layout-navigation-tree-drag.test.js` |

## Groups

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G1 | Group a pane with another (members become header tabs) | drag a pane onto a header | `pane-add-to-group` | `prefix =` `pane =` | `tmuxy pane group` | — | `tests/2-layout-navigation-groups.test.js` |
| G2 | Switch, reorder or take out a member | click or drag a header tab | — | — | `tmuxy pane group` | — | `tests/2-layout-navigation-group-drag.test.js` |
| G3 | Group a whole tab, or ungroup it | — | — | — | `tmuxy pane group` | — | `tests/8-pane-group-tab.test.js` |

## Floats

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | Float a pane over its tab | ✕, Escape or a click on the backdrop closes it | — | `pane f` | `tmuxy pane float` | — | `tests/2-layout-navigation-float.test.js` |
| F2 | A drawer from an edge | — | — | — | `tmuxy pane float` | — | `tests/cli/cli-pane-float.test.js` |
| F3 | Floats belong to their tab | — | — | — | — | — | `tests/2-layout-navigation-float-scope.test.js` |

## Sidebars

| Id | Feature | Mouse / UI | Menu | Keybinding | CLI | Config / Tag | Enforced by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | The tree of sessions, tabs and panes | peek on hover, click to dock, drag the edge | — | `app prefix s` | `tmuxy widget tree` | — | `tests/2-layout-navigation-tree.test.js` |
| B2 | Move panes and tabs in the tree | drag a row | — | — | — | — | `tests/2-layout-navigation-tree-drag.test.js` |
| B3 | The right sidebar, a dock for a shell | click to dock | — | `app prefix S` | — | — | `tests/2-layout-navigation-dock.test.js` |
| B4 | The keys view | — | — | `app prefix ?` | — | — | `tests/2-layout-navigation-tree-drag.test.js` |
