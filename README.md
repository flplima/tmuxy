> [!WARNING]
> *This project is under active development. Not ready for production. See [docs/SECURITY.md](docs/SECURITY.md).*

# tmuxy

The missing tmux GUI you didn't know you needed.

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

## getting started

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
