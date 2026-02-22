# tmuxy

The missing tmux GUI you didn’t know you needed.

> **Warning:** This project is under development and has been entirely vibe-coded. Be careful!

## why?

tmux is the best tool for agent-driven development, but it lacks a good UX.

tmuxy fixes that by adding an interface layer with a smoother UX and accessible from anywhere. Behind the scenes, it's still good ol' tmux, ready to be managed by you and your AI agents.

- **Agent-friendly**: Great for watching your AI coding agents on long-lived sessions.
- **Beginner-friendly**: Do you know what `<prefix> %` does? Me neither! It's okay if you don't know tmux, just use the system menus and the full mouse support. I won't judge you.
- **Mobile-friendly**: Run it on your server and access it from your phone. No app installation required. (but please use a VPN!)
- **Web-friendly**: Built on web technologies enabling fancy stuff like image rendering and markdown previews out-of-box. And who knows what else, maybe a plugin system?

## how it works

A Rust backend connects to tmux via [control mode](https://github.com/tmux/tmux/wiki/Control-Mode), streaming real-time terminal state over HTTP to a React frontend in a Tauri desktop app or in your browser.

```
┌──────────────────┐
│  Browser/Tauri   │
└──────────────────┘
          │
      HTTP/SSE
          │
          ▼
┌──────────────────┐
│     Rust API     │
└──────────────────┘
          │
  tmux control mode
          │
          ▼
┌──────────────────┐
│    tmux server   │
└──────────────────┘
```

## getting started

1. Run `git clone github.com/flplima/tmuxy.git`
2. From here, ask your AI agent for help.
3. Good luck!
