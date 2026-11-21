Pick a theme, switch light and dark, tweak one colour, or make your own. Changes repaint every open window as you save.

## Pick a theme

Open the app menu, then View ▸ Theme. Pick a theme and a mode.

The built-in themes are:

| Theme       | File             |
| ----------- | ---------------- |
| Default     | `default.css`    |
| Catppuccin  | `catppuccin.css` |
| Dracula     | `dracula.css`    |
| Fallout     | `fallout.css`    |
| Gruvbox     | `gruvbox.css`    |
| Nord        | `nord.css`       |
| Solarized   | `solarized.css`  |
| Tokyo Night | `tokyonight.css` |

Each one has a dark and a light face. The mode choices are **Dark Mode**, **Light Mode** and **System**, which follows your operating system. A mode a theme has no palette for is greyed out.

To pin a choice in your config:

```bash
# In ~/.config/tmuxy/tmuxy.conf
set -g @tmuxy-theme nord
# dark, light or auto
set -g @tmuxy-theme-mode auto
```

A pinned option is greyed out in the menu. Delete the line to hand the choice back. See [[Configuration]].

You can also keep a theme per session with profiles. See [[Configuration]]. A plugin can ship themes too (see [[Plugins]]).

## Make your own theme

A theme is one CSS file that sets `--*` variables. The built-ins are in `~/.local/share/tmuxy/themes/`. They are read-only and rewritten on every launch, so copy one.

```bash
mkdir -p ~/.config/tmuxy/themes
cp ~/.local/share/tmuxy/themes/nord.css ~/.config/tmuxy/themes/mine.css
```

Edit `mine.css`, then pick **Mine** in the Theme menu. Every save repaints the open windows.

A file named like a built-in (`nord.css`) replaces that built-in. Any other name adds a theme.

A theme declares a palette per mode:

```css
:root.theme-dark {
  --term-background: #101010;
}
:root.theme-light {
  --term-background: #fafafa;
}
```

## Change one thing without a theme

There are two ways. Pick the first that fits.

**`@tmuxy-css-<variable>`** sets one variable. The name is the variable without its `--`. The value is one CSS value, so a script or an agent can set it from a pane.

```bash
set -g @tmuxy-css-term-background '#101010'
set -g @tmuxy-css-theme-accent '#7aa2f7'
```

A value with a comment, a backslash or `url(` is ignored. Put those in `custom.css`.

**`~/.config/tmuxy/custom.css`** takes any CSS, loaded after the theme. Use it for a font size, a hidden header or a tab strip tweak. Set a variable the way themes do so it wins:

```css
:root.theme-dark,
:root.theme-light {
  --term-background: #101010;
}
```

The `--*` variables are a stable contract. Class names are not, and a release can rename one. From strongest to weakest: `custom.css`, then `@tmuxy-css-*`, then the theme.

### The main variables

Copy any built-in theme to see the whole list.

| Group       | Variables                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Terminal    | `--term-background`, `--term-foreground`, and the 16 ANSI colours: `--term-black`, `--term-red`, `--term-green`, `--term-yellow`, `--term-blue`, `--term-magenta`, `--term-cyan`, `--term-white`, and each with a `bright-` name (`--term-bright-red`) |
| Surfaces    | `--bg-black`, `--bg-dark`, `--bg-dark-alt`, `--bg-medium`, `--bg-highlight`, `--bg-highlight-alt`, `--bg-elevated-alt`                                                                                                                                 |
| Text        | `--text-primary`, `--text-secondary`, `--text-muted`, `--text-dimmed`, `--text-subtle`, `--text-quiet`, `--text-dark`                                                                                                                                  |
| Borders     | `--border-light`, `--border-medium`                                                                                                                                                                                                                    |
| Accents     | `--accent-blue-light`, `--accent-green`, `--accent-orange`, `--theme-accent`                                                                                                                                                                           |
| Links       | `--link-color`, `--link-hover`, `--link-active`                                                                                                                                                                                                        |
| Errors      | `--error-color`, `--error-light`                                                                                                                                                                                                                       |
| Cursor      | `--cursor-bg`, `--cursor-text`, `--cursor-inactive`                                                                                                                                                                                                    |
| Pane header | `--pane-header-text-active`, `--pane-header-text-inactive`                                                                                                                                                                                             |
| Status line | `--tmux-status-bg`                                                                                                                                                                                                                                     |

## Text size

| What             | Linux and web                                 | macOS               |
| ---------------- | --------------------------------------------- | ------------------- |
| Bigger / smaller | `Ctrl` and `+` / `-`, or `Ctrl` and the wheel | `Cmd` and `+` / `-` |
| Reset            | View ▸ Make Text Normal Size                  | `Cmd+0`             |

The View menu has Make Text Bigger, Make Text Smaller and Make Text Normal Size.

## Cursor blink and animations

```bash
# Every cursor stays steady.
set -g @tmuxy-cursor-blink off
# No pane morphs, swaps, resizes or float animations.
set -g @tmuxy-animations off
```

View ▸ Blinking Cursor does the first from the menu, and the choice is remembered. A program that asks for a steady cursor still gets one while blinking is on.

## Transparency, blur and dimming

How much of each surface is painted. 0.0 is fully clear and 1.0 is opaque.

| Option                         | Default | What it covers                                        |
| ------------------------------ | ------- | ----------------------------------------------------- |
| `@tmuxy-opacity`               | `1`     | Window chrome: title bar, sidebar, gaps between panes |
| `@tmuxy-active-pane-opacity`   | `1`     | The active pane's background                          |
| `@tmuxy-inactive-pane-opacity` | `0.7`   | Other panes' backgrounds                              |
| `@tmuxy-active-text-opacity`   | `1`     | The active pane's header and text                     |
| `@tmuxy-inactive-text-opacity` | `0.7`   | Other panes' header and text. This is the focus cue   |
| `@tmuxy-blur`                  | `off`   | Native blur behind the window, macOS only             |
| `@tmuxy-transparency`          | `on`    | Off paints everything opaque and clears the blur      |

The desktop app's window is opaque by default. Lower `@tmuxy-opacity` and the desktop shows through the chrome, blurred on macOS with `@tmuxy-blur on`. A browser always paints the page opaque, so there the theme's background shows through. In the macOS app, View ▸ Enable Window Transparency flips `@tmuxy-transparency` and remembers it.

To dim inactive panes less, raise `@tmuxy-inactive-pane-opacity` and `@tmuxy-inactive-text-opacity`. To drop transparency altogether:

```bash
set -g @tmuxy-transparency off
```

## Desktop window styles

Window ▸ Window Style, in the desktop app, offers the same set iTerm2 does:

- Normal, Full Screen, Maximized, No Title Bar
- Full-Width Top of Screen, Full-Width Bottom of Screen
- Full-Height Left of Screen, Full-Height Right of Screen
- Top of Screen, Bottom of Screen, Left of Screen, Right of Screen

On macOS the title bar is transparent, so No Title Bar hides the three window buttons.

## Native menus

The desktop app uses the macOS menu bar. Context menus are native on macOS and Linux. To use tmuxy's own themed menus instead:

```bash
set -g @tmuxy-native-menus off
```

## See also

- [[Configuration]]
- [[Desktop or Web]]
- [[Plugins]]
- [[Tips and Tricks]]
