tmuxy draws more than text. Links click, images show inline, and a markdown file or HTML page can open in a pane. It is still tmux underneath.

## Links

Programs can mark links with the OSC 8 escape sequence. tmuxy draws them as real links.

```bash
# A clickable link.
printf '\e]8;;https://example.com\e\\Click me\e]8;;\e\\\n'

# Many tools emit OSC 8 on their own.
ls --hyperlink=auto
```

Plain URLs in the output work too, but only while you hold the link modifier: `Cmd` on macOS, `Ctrl` elsewhere. Then click.

A link opens in a new browser tab on the web. The desktop app opens `http`, `https` and `mailto` links in your system browser. A URL longer than the pane counts as one link on every row it covers.

## Images

tmuxy shows images from three protocols. It needs a tool that sends one of them.

| Protocol                        | Try it with                                                               |
| ------------------------------- | ------------------------------------------------------------------------- |
| iTerm2 inline images (OSC 1337) | `imgcat path/to/image.png`                                                |
| Kitty graphics                  | `kitten icat path/to/image.png`                                           |
| Sixel                           | `img2sixel path/to/image.png` or `chafa --format sixel path/to/image.png` |

Inside a tmuxy session each of these renders in the pane. The images stay anchored to their cells. They scroll with the text and show again in scrollback.

A screen clear (`clear`) removes an image. So does leaving a full-screen program. A new image drawn at the same spot replaces the old one, so a preview that repaints does not flicker.

tmuxy sets `allow-passthrough on` for you. You do not need a tmux setting for any of this.

## Unicode and text styles

Wide characters, emoji, faint text, and double-width or double-height lines (DEC line sizes, Kitty text sizing) are drawn. Nothing to configure.

## Titles

A program sets the pane's title with OSC 2, and the title shows in the pane's header.

```bash
# Set this pane's title.
printf '\e]2;my title\a'
```

You can also rename a pane yourself (see [[Panes Groups and Floats]]).

## Program icons

Each pane's header wears an icon for the program running in it. Claude Code, Antigravity and Codex have their own. For others, set `@tmuxy-icon-<process>` in `tmuxy.conf`:

```bash
# One or two ASCII characters.
set -g @tmuxy-icon-fish '>_'

# Or an SVG file in ~/.config/tmuxy/icons/ (here, claude.svg).
set -g @tmuxy-icon-claude claude.svg
```

Icons are drawn in the text's colour. While a pane has a state (working, waiting, failed), the state's mark replaces the icon. See [[Configuration]].

## Say what a program is doing

A program can report its state in its own output. No hook and no install, a `printf` is enough. This uses the [program status protocol](https://www.superlogical.com/rex/docs/build/program-status). The pane's mark shows it, and the tree, the tabs and the [[Sidebars Palette and Inbox]] read it.

| Reported  | Pane state  |
| --------- | ----------- |
| `working` | working     |
| `blocked` | needs-input |
| `done`    | unread      |
| `error`   | error       |
| `idle`    | idle        |
| `clear`   | unset       |

A new shell prompt (if your shell marks prompts) ends `working` and `blocked`. A shell that does not mark prompts ends nothing, so a program should send `clear` itself before it exits.

## Preview a markdown file or a web page

```bash
# Preview a file in this pane.
tmuxy open notes.md
tmuxy open report.html

# With no file: index.html, or README.md, from the current directory.
tmuxy open
```

`tmuxy open` is short for `tmuxy widget preview`. The pane turns into a viewer. It reloads when the file changes, and it keeps your scroll position. Press `Ctrl+C` to end the preview and get your shell back.

| Option       | Meaning                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `--net`      | Let the page load from the network. Off by default, so a page is offline and shows only what sits beside it |
| `--no-theme` | Draw the page in its own colours, not the theme's                                                           |

Markdown shows in the theme's colours. Mermaid code fences draw as diagrams, and YAML front matter shows as a block above the document.

In a markdown preview these keys scroll: `j` and `k`, `space` and `b`, `Ctrl+d` and `Ctrl+u`, `g` and `G`.

To print the tree sidebar's content in a pane, use `tmuxy widget tree`.

### What a previewed page may do

A preview treats the file as hostile.

- **Reads:** a page may load stylesheets, scripts, images and fonts from its own folder only. Hidden names (`.ssh`, `.env`, `.git`, `..`) and symlinks that leave the folder are refused. A document can be up to 8 MiB.
- **HTML pages** run in a sandboxed frame. It has no cookies, no storage, no access to tmuxy, and cannot open windows or submit forms. Without `--net`, it cannot fetch anything.
- **Markdown** is cleaned before it is shown. Scripts, styles, frames and event handlers are removed. A remote image loads only with `--net`.
- **Links** open in your system browser when they are `http(s)` or `mailto`. They never navigate tmuxy.

Only a pane that asked to be a preview draws one. A program that prints the marker line cannot turn a shell pane into a widget.

### Pages that talk back

A page can send a line to the pane it is shown in, and a plugin can read it with `tmuxy pane listen`. _On main, not in a release yet._

- A page calls `tmuxy.emit(value)`.
- Form controls in a markdown preview (`<input>`, `<select>`, `<textarea>`) send a JSON line as you change them.

```bash
# In another pane: print the lines a preview pane receives.
tmuxy pane listen %3 --from-start
```

The line is data. A plugin should parse it and never run it. See [[Plugins]] for more.

## See also

- [[Copy Mode and Scrollback]]
- [[Plugins]]
- [[Security]]
- [[CLI Reference]]
