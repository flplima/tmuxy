Short answers to the questions people ask first. Each one points to the page with the detail.

## What it is

### is this another terminal emulator?

No. tmux already does the terminal emulation, and tmuxy draws what tmux gives it. tmuxy is a UI for tmux, not a replacement for your terminal app. See [[Coming from tmux]].

### do I need to know tmux?

No. You can split, resize, drag and switch with the mouse and the menus, and learn the keys as you go. It is still real tmux underneath, so what you learn carries over.

### is it ready for production?

No. tmuxy is under active development and has not had a security audit. It is built for one user on a trusted network. Breaking changes happen. See [[Security]].

### does it work with zellij or screen?

No. tmuxy drives tmux through its control mode and nothing else. If you are moving from zellij, [[Coming from zellij]] maps the ideas across.

### which tmux versions work?

tmux 3.2 or newer. tmuxy checks `tmux -V` at start and refuses an older or missing one, with a message on how to fix it. The nightly tests cover 3.2a, 3.4, 3.5a, 3.7a and 3.8. See [[Troubleshooting]].

### does it work on Windows?

There is no Windows build of the desktop app. It runs on macOS and Linux. The web app is reached from a browser, so what matters is where the server runs. See [[Desktop or Web]].

### why not a real terminal emulator like xterm.js?

tmux already tracks every cell, color and cursor. A second emulator in the page would duplicate that and could drift from what tmux holds. tmuxy renders tmux's grid as plain page elements, which also gives you native text selection and screen reader support. The reasoning is in the [non-goals](https://github.com/flplima/tmuxy/blob/main/docs/NON-GOALS.md).

### why is there no Cmd+F?

A find box in the page could only search the history the page holds, and it holds a slice at a time. It would miss matches and not say so. Use copy mode: `prefix [`, then `/` to search down or `?` to search up. See [[Copy Mode and Scrollback]].

## Your tmux

### where are my tmux sessions?

Still there. tmuxy runs on a socket of its own (`tmuxy`), not the one your bare `tmux` uses. The desktop app lists **my tmux** in the session menu. For the web server, start it with `TMUX_SOCKET=default tmuxy server`. See [[Quick Start]].

### can I use my own tmux.conf?

Yes, but it is off by default. Run `tmuxy config use-tmux-conf on`, and tmuxy sources `~/.tmux.conf` after its defaults and before your `tmuxy.conf`. Then it restores the few settings it cannot work without. See [[Configuration]].

### why does it use Ctrl+a?

It is the screen-style prefix tmuxy ships with. Press it twice (or `prefix a`) to send a literal `Ctrl+a` to a program. To change it, set `prefix` in your `tmuxy.conf`. See [[Keybindings]].

### what happens to my sessions when tmuxy crashes or updates?

They keep running. tmux is its own process on its own socket, so tmuxy can go away and come back. tmuxy also saves each session's shape on every change and can rebuild it when the session is gone. See [[Tabs and Sessions]].

### does it save my running programs?

It saves the shape: tabs, splits, floats, groups, each pane's folder and its program. It cannot resume a running process. A restored pane offers its program at the prompt, or runs it with `tmuxy session restore <name> --run`.

### what happens when I close the window or the browser tab?

The session stays. tmuxy is only a client of tmux, and closing it detaches. Open it again and you are back where you were.

### can two people share a session?

Not as a feature. tmuxy assumes one user, and everyone who reaches a server has full control of the session. Several of your own clients can watch one session at once. When their sizes differ, the grid follows the smallest by default. See [[Security]].

## Safety and privacy

### does it phone home?

No. tmuxy collects no telemetry and does not check for updates. Every connection it can make is listed in the [telemetry doc](https://github.com/flplima/tmuxy/blob/main/docs/TELEMETRY.md). The tmuxy.sh website is separate and does use analytics.

### is it safe to open it to the internet?

No. Anyone who reaches the server gets a shell as you, and there is no TLS. The server listens on `127.0.0.1` by default. Use an SSH tunnel or a VPN, or put a password and a TLS proxy in front. See [[Remote Access]].

### why did it ask me before typing into another pane?

Typing into another pane is how one program could drive another, so tmuxy asks you first. You can allow or refuse callers by rule. See [[Send Permissions]].

### are plugins safe?

A plugin runs as you, without a sandbox, and can read and type into every pane. That is why the install gate shows what it can do and asks first. Read the code before you say yes. See [[Plugins]].

## Using it

### can I use it from my phone?

Yes, in the browser, and it is experimental. Start a server, reach it over a VPN or an SSH tunnel, and open the page. There is a phone layout with a key row. See [[Phone and Tablet]].

### can my AI agent use it?

Yes. Agents already work well in tmux, and tmuxy adds a CLI, hooks that show what each agent is doing, and an MCP endpoint (`tmuxy mcp`). See [[AI Agents]] and [[MCP]].

### why does the Linux AppImage not start?

It needs FUSE at runtime. On Debian and Ubuntu, install `libfuse2`. See [[Troubleshooting]].

### how do I update it?

You do it the way you installed it: `brew upgrade`, or a new download from the [Releases page](https://github.com/flplima/tmuxy/releases). tmuxy never checks for a new version on its own.

### can I change how it looks?

Yes. There are built-in themes, light and dark modes, transparency options and your own CSS. See [[Themes and Appearance]].

### are images and links supported?

Yes. OSC 8 links work, and images in the iTerm2, Kitty and Sixel protocols draw inline. See [[Rich Rendering and Previews]].

### where are its config files?

Run `tmuxy config paths`. Your files live in `~/.config/tmuxy`, which tmuxy never writes after the first run, so you can symlink it from a dotfiles repo.

### how do I report a bug?

Open an issue and include `tmuxy --version`, `tmux -V` and how you run it. A short redacted trace helps a lot. A security problem does not go in a public issue. See [[Troubleshooting]] and [[Contributing]].

## See also

- [[Troubleshooting]]
- [[Tips and Tricks]]
- [[Security]]
