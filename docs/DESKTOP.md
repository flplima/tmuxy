# Desktop-only features

tmuxy is one React UI served two ways: the **web app** (`tmuxy-server`, a
browser tab) and the **desktop app** (`tmuxy-tauri-app`, the same UI in a
WKWebView on macOS or WebKitGTK on Linux, over native IPC). Everything about
tmux — panes, tabs, floats, groups, copy mode, widgets, the CLI — is the same
on both. What follows is the list of things only the desktop app has, and
why: each one needs something a browser tab is not given.

The desktop app runs on **macOS and Linux**. There is no Windows build.

| Feature                                                                                                 | Why the web cannot have it                                                                                                                                                                                                                                                                                                                                                                                                                                 | Where it lives                                                                                                                      |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Trackpad gestures: two-finger slide between tabs, pinch to zoom a pane, pinch in to the "all tabs" view | A page never learns when the fingers leave the trackpad. A slide reaches it as `wheel` events with no phase, and the only sign of a lift is silence — the same silence as fingers resting on the pad, so every web implementation either snaps back under a pause or guesses from a timer. The shell sees the real phases (`NSEvent.phase` / `momentumPhase` on macOS; GTK's smooth-scroll stream and its stop event on Linux) and hands them to the page. | `packages/tmuxy-tauri-app/src/gestures.rs` → `window.tmuxyGesture` → `machines/actors/gestureActor.ts`; drawn by `GestureStage.tsx` |
| Several GUI windows on one tmux session, with the Window menu and its shortcuts                         | A browser tab is one window.                                                                                                                                                                                                                                                                                                                                                                                                                               | `packages/tmuxy-tauri-app/src/windows.rs`, `components/menus/WindowMenu.tsx`, `utils/guiWindows.ts`                                 |
| Window styles (iTerm2's set), the native title bar, dragging the window by its status bar               | Window chrome belongs to the shell.                                                                                                                                                                                                                                                                                                                                                                                                                        | `packages/tmuxy-tauri-app/src/window_style.rs`, `titlebar.rs`, `components/StatusBar.tsx`                                           |
| The native menu bar                                                                                     | A page has no menu bar; the web app offers the same actions from its own menus.                                                                                                                                                                                                                                                                                                                                                                            | `packages/tmuxy-tauri-app/src/gui.rs` (menu actions reach the page as `window.tmuxyMenuAction`)                                     |
| Other servers in the session menu, and `tmuxy connect` to add one                                       | A web client is already talking to the one server that serves it.                                                                                                                                                                                                                                                                                                                                                                                          | `components/SessionMenu.tsx`                                                                                                        |
| Links and files opened by the system (browser, viewer), images and files served over app schemes        | A page may only open a tab; the shell asks the OS. The web app serves the same images and files over HTTP routes instead.                                                                                                                                                                                                                                                                                                                                  | `utils/openUrl.ts`, `utils/fileUrl.ts`, `components/Terminal.tsx` (`tmuxyimg:`, `tmuxyfile:`)                                       |
| Restart the app                                                                                         | A page can only reload itself.                                                                                                                                                                                                                                                                                                                                                                                                                             | `utils/restartApp.ts`                                                                                                               |

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
the WKWebView, and returning `nil` is what swallows an event. It honours the
Trackpad preference "Swipe between pages" the way Safari does
(`isSwipeTrackingFromScrollEventsEnabled`). **Linux** connects
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
