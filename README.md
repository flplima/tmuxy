> [!WARNING]
> *This project is under active development. Not ready for production. See [docs/SECURITY.md](docs/SECURITY.md).*

# tmuxy

The missing tmux GUI you didn't know you needed.

![tmuxy](https://github.com/user-attachments/assets/1e65bc85-8f6a-4771-95e3-83684531d879)

## why?

tmux is the best tool for agent-driven development, but it lacks a good UX.
**tmuxy** fixes that by adding an interface layer with a smoother UX on top of tmux, accessible from anywhere.

- **Agent-friendly**: AI agents already love tmux. Why create a new tool? Instead, tmuxy offers a better UI to watch them in their work.
- **Beginner-friendly**: Do you know what `<prefix> %` does? Me neither! tmuxy won't judge you for using the mouse and the system menus.
- **Mobile-friendly**: Combines the tmux power of detachable sessions with the convenience of the browser. Start something on your laptop, pick it up from your phone. No app required. (but a VPN is highly recommended)
- **Web-friendly**: Built on web technologies to unlock richer interfaces. Pane group tabs, pane floats, image rendering, markdown preview, while behind the scenes it's still tmux!

## how it works

A Rust backend connects to tmux via [control mode](https://github.com/tmux/tmux/wiki/Control-Mode) and streams the terminal state to the frontend.

There are two ways to use tmuxy: the **Web App mode** and the **Desktop App mode**.
In the web app, communication happens via HTTP/SSE. It is fast, I promise you. But it's even faster if you use the desktop app (built with Tauri), that skips the network layer and talks to the same Rust core through IPC.


```
       ┌──────────────┐
       │     tmux     │
       │(control mode)│
       └──────┬───────┘
              │
       ┌──────▼───────┐
       │ rust backend │
       └─┬──────────┬─┘
       HTTP        IPC
         │          │
  ┌──────▼────┐ ┌───▼───────┐
  │  browser  │ │ tauri app │
  └───────────┘ └───────────┘
```

## install

### macOS

```bash
brew install --cask flplima/tap/tmuxy
```

The desktop app is unsigned (no Apple Developer subscription), so the
cask runs `xattr -dr com.apple.quarantine /Applications/tmuxy.app`
automatically on install to skip the macOS Sequoia
"Apple could not verify…" dialog.

If you grabbed the DMG directly from the [Releases page](https://github.com/flplima/tmuxy/releases) instead, run that yourself before launching:

```bash
xattr -dr com.apple.quarantine /Applications/tmuxy.app
```

### Linux

Homebrew casks are macOS-only, so on Linux install the formula (no `--cask`):

```bash
brew install flplima/tap/tmuxy
```

This installs the AppImage as the `tmuxy` command. Running it needs FUSE
(`libfuse2` on Debian/Ubuntu) at runtime.

Prefer a native package? Grab the `.deb` or `.AppImage` directly from the
[Releases page](https://github.com/flplima/tmuxy/releases).

## getting started (development)

```bash
git clone github.com/flplima/tmuxy.git
cd tmuxy
npm run devcontainer
# I strongly recommend using the devcontainer, unless you don't mind
# messing with your host tmux sessions while vibe coding

# From here, ask your AI agent for help.
# Good luck!
```

## license

[MIT](LICENSE)
