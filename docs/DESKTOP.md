# Desktop-only features

tmuxy is one React UI served two ways: the **web app** (`tmuxy-server`, a
browser tab) and the **desktop app** (`tmuxy-tauri-app`, the same UI in a
WKWebView on macOS or WebKitGTK on Linux, over native IPC). Everything about
tmux — panes, tabs, floats, groups, copy mode, widgets, the CLI — is the same
on both. What follows is the list of things only the desktop app has, and
why: each one needs something a browser tab is not given.

The desktop app runs on **macOS and Linux**. There is no Windows build.

| Feature | Why the web cannot have it | Where it lives |
| --- | --- | --- |
| Trackpad gestures: two-finger slide between tabs, pinch to zoom a pane, pinch in to the "all tabs" view | A page never learns when the fingers leave the trackpad. A slide reaches it as `wheel` events with no phase, and the only sign of a lift is silence — the same silence as fingers resting on the pad, so every web implementation either snaps back under a pause or guesses from a timer. The shell sees the real phases (`NSEvent.phase` / `momentumPhase` on macOS; GTK's smooth-scroll stream and its stop event on Linux) and hands them to the page. | `packages/tmuxy-tauri-app/src/gestures.rs` → `window.tmuxyGesture` → `machines/actors/gestureActor.ts`; drawn by `GestureStage.tsx` |
| Several GUI windows on one tmux session, with the Window menu and its shortcuts | A browser tab is one window. | `packages/tmuxy-tauri-app/src/windows.rs`, `components/menus/WindowMenu.tsx`, `utils/guiWindows.ts` |
| Window styles (iTerm2's set), the native title bar, dragging the window by its status bar | Window chrome belongs to the shell. On macOS the title bar is transparent and full-size — the status bar is the title bar — so "No Title Bar" hides the three window buttons (and the page drops the room it keeps for them) rather than rewriting the window's decorations, which would rebuild the style mask without the full-size-content bit and leave a bare title strip above a pushed-down page. A style change that leaves full screen or a maximized frame waits for that exit to land before it applies. Each applied style is announced to the page as `window-style`. | `packages/tmuxy-tauri-app/src/window_style.rs`, `titlebar.rs`, `components/StatusBar.tsx`, `utils/guiWindows.ts` |
| Window transparency: the blurred desktop behind the chrome (macOS), and View ▸ Enable Window Transparency to turn it off | A page cannot see through its own browser window; the desktop's window is transparent and puts a native blur behind the page. The switch is `@tmuxy-transparency`, remembered in `tmuxy.state.json` in the state dir (unless the user's `tmuxy.conf` sets it, which pins it: the item is greyed out and says so): off, the page paints its surfaces opaque and every window's blur is cleared at once; the opacities and `@tmuxy-blur` keep their values for when it goes back on. | `packages/tmuxy-tauri-app/src/gui/window_setup.rs`, `monitor/emitter.rs` (`emit_theme_settings`)<br>`packages/tmuxy-ui/src/utils/appearanceManager.ts` |
| Native menus: the menu bar (macOS) and native popups for every context menu (macOS + Linux) — not the session switcher, whose filter box a native popup cannot hold — built from the frontend's menu spec; the in-app menus are the fallback, and what `@tmuxy-native-menus off` keeps | A page has no menu bar and no native popups; the web app draws the same specs with its own floating menu. The desktop sets the bar from the page (`NativeMenuBar`), debounced on the spec's shape and on window focus so the focused window owns it; a popup that is refused falls back to the in-app menu in the same gesture. An item's icon is the in-app menu's own strokes, rasterised in the page in the system's menu text colour — the platform takes a plain bitmap, not a template it recolours — so the bar is rebuilt when the system appearance changes. | `packages/tmuxy-ui/src/domain/menus/` (the specs, and `icons.ts`)<br>`packages/tmuxy-ui/src/infra/menus/nativeMenu.ts`, `nativeIcons.ts`<br>`packages/tmuxy-ui/src/components/menus/NativeMenuBar.tsx`, `useNativeMenu.ts`, `menuHost.ts` |
| Other servers in the session menu, and `tmuxy session connect` to add one | A web client is already talking to the one server that serves it. | `components/SessionMenu.tsx` |
| Links opened by the system (browser, viewer), images served over an app scheme | A page may only open a tab; the shell asks the OS. The web app serves the same images over an HTTP route instead. | `utils/openUrl.ts`, `components/Terminal.tsx` (`tmuxyimg:`) |
| Restart the app | A page can only reload itself. | `utils/restartApp.ts` |
| The `tmuxy` shorthand in `~/.local/bin`, which runs the CLI through the app that was opened last | A page cannot install anything on the machine. The app writes the shorthand on every launch and records its own path in `launcher` in the state dir — this machine's fact, never in the config dir a dotfiles repo may hold — which the shorthand reads, resolving the state dir as the app does. The CLI's scripts are mirrored into the data dir (`~/.local/share/tmuxy/bin`), where the config and the UI name them; an AppImage's own mount point changes on every launch. | `packages/tmuxy-core/src/session/assets.rs` (`refresh_launcher`), `packages/tmuxy-tauri-app/src/cli.rs` |

The switch for all of it is `isTauri()` (`utils/platform.ts`), set from the
Tauri IPC bridge being present; `main.tsx` also marks the document with
`data-desktop` for styling. Nothing else probes the platform.

## Trackpad gestures

The pane grid follows the fingers (`GestureStage` writes each step as an inline
`transform`, nothing re-renders), the tab being pulled in is drawn beside it
from its real panes, and the release decides: past the mark the tab switches
at once and the grid runs home; short of it the grid slides back. The
decision and the drawing are `machines/app/actions/gestures.ts` and
`utils/gestures.ts`; the only thing the shell supplies is _where the fingers
are and when they lift_.

**The contract** (one call per native scroll event the shell claims):

```
window.tmuxyGesture('slide', phase, dx, dy, t)
```

- `phase`: `began` · `changed` · `ended` · `cancelled` · `momentum` ·
  `momentum-ended`. The fingers are on the pad from `began` to `ended` or
  `cancelled`, for as long as that takes — a pause is simply no event. The
  momentum phases are the tail macOS sends after a lift; Linux has none.
- `dx`, `dy`: points, positive when the fingers move right or down (the
  content follows the fingers).
- `t`: the event's own timestamp in seconds, so the speed a release carries
  on at is measured on the device's clock.

**What the shell claims.** A scroll stream whose first steps are horizontal
(the same axis rule the actor used to apply, `|dx| > 1.5·|dy|`) from a
touchpad (`hasPreciseScrollingDeltas` on macOS; a touchpad device on Linux),
while `@tmuxy-gesture-swipe-tabs` is on — the page is told the flag through
a command whenever it changes. The claimed events, and the momentum tail
that follows them, never reach the webview: the page does not scroll on
them, and nothing has to `preventDefault`. Vertical scrolls and mouse wheels
are left alone. A slide over a pane whose program tracks the mouse is still
claimed: Ghostty gates its tab switch on that, but Claude Code and nvim track
the mouse, so the gate left most tabs with no slide at all, and what such a
program gives up is only a horizontal two-finger scroll.

**macOS** installs an `NSEvent` local monitor for `.scrollWheel` from Rust
(`objc2-app-kit`): it runs before `-[NSApplication sendEvent:]`, so before
the WKWebView, and returning `nil` is what swallows an event. It does not
consult the Trackpad preference "Swipe between pages": that switch is about
page history, the two-finger scroll arrives whatever it says, and
`@tmuxy-gesture-swipe-tabs` is the one setting for the tab slide. **Linux** connects
`scroll-event` on the WebKitGTK widget: two-finger motion is
`GDK_SCROLL_SMOOTH` ending in a stop event at lift-off, before any kinetic
scrolling, and `Propagation::Stop` is what swallows it.

A pinch needs none of this: WebKit reports it to the page itself as
`gesturestart` / `gesturechange` / `gestureend` with the cumulative scale, and
those have phases. The actor keeps a ctrl+wheel pinch too, which is how
libinput's pinch arrives on WebKitGTK.

The web build runs none of the gesture code: `AppProvider` leaves the
machine's no-op gesture actor in place off the desktop, so the browser keeps
its own wheel, pinch-zoom and history swipe. The Storybook stories under
_Mocked App / Trackpad Gestures_ opt the actor in (`config.desktopGestures`)
and drive it with the shell's own calls, which is how the JS half is tested
on the web build; the native half is covered by the desktop suite.
