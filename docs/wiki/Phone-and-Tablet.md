Open your tmux session in a phone or tablet browser, type into it, and get a notification when a pane needs you. This part of tmuxy is experimental, so expect rough edges.

## Reach it from your phone

The phone talks to `tmuxy server`, not to the desktop app. Start the server, then pick a way to reach it.

```sh
# on the machine that runs tmux
tmuxy server
```

The server listens on loopback only, so the phone cannot see it yet. [[Remote Access]] has the safe ways to fix that. A VPN is the easiest from a phone: install it on both ends, bind tmuxy to the VPN address, and open `http://<vpn address>:9000`.

Do not put the server on a public address without a password and TLS.

## The phone layout

tmuxy switches to the phone layout when the screen is touch-first or narrower than 600 px. The terminal is always 80 columns by 24 rows. The text shrinks until 80 columns fit across the screen.

Top to bottom, upright:

| Part        | What it is                                                                 |
| ----------- | -------------------------------------------------------------------------- |
| Tab strip   | Your tabs, as on the desktop. Tap one to switch to it, `+` opens a new one |
| Terminal    | The pane, with tmux's status line under it                                 |
| Key row     | Two rows of six keys, edge to edge                                         |
| Bar         | A handle you drag to resize the terminal                                   |
| Bottom view | Menu, tree or side pane, one at a time                                     |

On a session shared with a desktop, a phone shrinks that desktop's window to 80 x 24 too, as any smaller client does.

### The key row

| Key           | What it does                                                                        |
| ------------- | ----------------------------------------------------------------------------------- |
| `esc`, `tab`  | Send that key                                                                       |
| `ctrl`, `alt` | Latch for the next key, from the row or from the phone keyboard                     |
| prefix        | Presses the tmux prefix as one chord. It lights up while armed. Tap again to cancel |
| keyboard      | Brings the phone keyboard up or away                                                |
| arrows        | Repeat while held. Slide onto a neighbor to hand over                               |
| `enter`       | Send enter                                                                          |
| mic           | Listens until you pause, then types what it heard. Tap again to stop early          |

The mic uses your browser's speech recognition. If the browser has none, or the site may not use the microphone, a notice says so.

### The bar and the bottom view

Drag the bar down to zoom the terminal. Drag it up from its own size to fold the terminal and keys away. Drag down again to bring them back. A double tap on the bar moves it with the zoom it sets. The zoom and the fold are remembered per device.

The bottom view has three pages, picked from the tab bar along its top or with a sideways swipe:

- **Menu**: the app menu as a list. Submenus open as pages.
- **Tree**: your tabs and panes. It is in front at first.
- **Side pane**: a terminal pinned beside your work, like the desktop's right column.

### Held sideways

Turn the phone and the layout goes flat, like a desktop, under the same tab strip. The terminal sits in the middle, the status line and one row of twelve keys along the bottom. The tree is on the left, under the menu button. The side pane is on the right.

## Touch gestures

| Gesture                | What it does                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Tap a pane             | Focus it. An open keyboard follows                                                                 |
| Tap the focused pane   | Put the keyboard up or away, like the key row's keyboard key                                       |
| Double tap             | Zoom the terminal to twice its size around the point. Then pan with a finger                       |
| Hold                   | Select the word under your finger in copy mode. Drag to extend. Copy and Cancel show over the pane |
| Slide sideways         | Switch tabs                                                                                        |
| Slide on the side pane | Nothing. It is not a tab                                                                           |

## The keyboard

A phone keyboard covers the page instead of resizing it. tmuxy follows the visible area. The bottom view gives way first, then the terminal is cut short and scrolled to keep your cursor row in view. The text never shrinks for a keyboard.

## Install it as an app

Add the page to your home screen and it opens full screen, without browser bars. The layout stays clear of the status bar, the home indicator and the notch.

1. Open the tmuxy page in the phone's browser.
2. Use the browser's "Add to Home Screen" (or "Install app") action.
3. Open it from the home screen.

## Notifications when a pane needs you

tmuxy can push a notice to your phone when a pane needs you. That is handy when an agent stops to ask.

1. Open the app menu, then View.
2. Tick **Notify When a Pane Needs You**.
3. Accept the browser's permission prompt.

Each device turns it on for itself. A notice goes out when a pane:

- enters `needs-input` or `error`
- has a result (`unread`, after a program says it is done) that nobody has looked at

The notice carries the pane's name, its session and tab, and the host name. It is encrypted for your device, so the push service (Apple, Google or Mozilla, whichever your browser uses) sees that something arrived and when, not what it says.

The menu item shows a reason when it cannot work:

| Label                    | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| (off in tmuxy.conf)      | `@tmuxy-notify off` is set. No device gets notices                 |
| (blocked by the browser) | You denied the permission. Allow it in the browser's site settings |
| No item                  | Your browser does not support push                                 |

Only `tmuxy server` sends them. The desktop app and the demo never do. To turn them off for every device, put this in your `tmuxy.conf`:

```
set -g @tmuxy-notify off
```

## The e-ink page

For browsers too old to run the app, such as a Kindle Scribe's, add `?kindle` to the address:

```
http://<address>:9000/?kindle
```

It draws the active tab as a black-on-white character grid with box-drawing dividers. Colour is dropped. Bold, underline, inverse and faint stay. It redraws at most every 700 ms and only the rows that changed, to spare the screen.

You get a text box with a Send button, key buttons, a tap on a pane to focus it, tab buttons, and A- and A+ to change the font size. A session larger than the screen scrolls.

## See also

- [[Remote Access]]
- [[Security]]
- [[AI Agents]]
- [[Sidebars Palette and Inbox]]
