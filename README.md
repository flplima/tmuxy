> [!WARNING]
> _This project is under active development. Not ready for production. See [docs/SECURITY.md](docs/SECURITY.md)._

# tmuxy

The missing tmux GUI you didn't know you needed.

![tmuxy](https://github.com/user-attachments/assets/1e65bc85-8f6a-4771-95e3-83684531d879)

## why?

tmux is the best tool for agent-driven development, but it lacks a good UX.
**tmuxy** fixes that by adding an interface layer with a smoother UX on top of tmux, accessible from anywhere.

- **Agent-friendly**: AI agents already love tmux. Why create a new tool? Instead, tmuxy offers a better UI to watch them in their work.
- **Beginner-friendly**: Do you know what `<prefix> %` does? Me neither! tmuxy won't judge you for using the mouse and the system menus.
- **Mobile-friendly (Experimental)**: Combines the tmux power of detachable sessions with the convenience of the browser. Start something on your laptop, pick it up from your phone. No app required. (A VPN is highly recommended)
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

tmuxy drives a real tmux, so it needs **tmux 3.4 or newer** (`tmux -V`). Homebrew and the `.deb` install it for you, and the app tells you at launch if it is missing or too old.

### macOS

```bash
brew install --cask flplima/tap/tmuxy
```

The desktop app is signed and notarized by Apple, so it opens without a
Gatekeeper warning — whether you install it with the cask or download the DMG
from the [Releases page](https://github.com/flplima/tmuxy/releases).

### Linux

Homebrew casks are macOS-only, so on Linux install the formula (no `--cask`):

```bash
brew install flplima/tap/tmuxy
```

This installs the AppImage as the `tmuxy` command. Running it needs FUSE
(`libfuse2` on Debian/Ubuntu) at runtime.

Run `tmuxy` once and it adds itself to the applications menu, so the GUI is
launchable without the terminal from then on. Set `TMUXY_NO_DESKTOP_ENTRY=1`
to skip that.

Prefer a native package? Grab the `.deb` or `.AppImage` directly from the
[Releases page](https://github.com/flplima/tmuxy/releases).

## running tmuxy

### Desktop App

Launch `tmuxy` from your applications menu or terminal.

### Web App (Headless / Remote)

Start the server on loopback (`127.0.0.1:9000` by default):

```bash
tmuxy server                # start background server on port 9000
tmuxy server status         # view status and port
tmuxy server stop           # stop the running server
```

Open `http://localhost:9000` in any browser. For remote machines, access over an SSH tunnel (`ssh -NL 9000:localhost:9000 user@host`) or set a password with `TMUXY_PASSWORD=... tmuxy server --host 0.0.0.0` (see [docs/SECURITY.md](docs/SECURITY.md)).

### Where are my existing tmux sessions?

They are still there — tmuxy just isn't looking at them yet.

tmuxy runs tmux on a **socket of its own** (`tmuxy`), not the one your bare
`tmux` command uses. That is deliberate: it means tmuxy cannot disturb the
session you are working in, and an update or a crash cannot take your real work
with it.

To point it at your own tmux server instead:

- **Desktop app** — the session menu lists **my tmux** under _Servers_ whenever
  that server has sessions. Pick it; the app reconnects in place.
- **Web** — the server binds its socket at launch, so tell it at launch:

  ```bash
  TMUX_SOCKET=default tmuxy server
  ```

Attaching to your own server applies only the settings tmuxy cannot work
without — it will not touch your prefix, your status line or your bindings
there. Your own `~/.tmux.conf` is not loaded on tmuxy's own socket by default
either; `tmuxy config use-tmux-conf on` changes that (see
[docs/TMUX.md](docs/TMUX.md)).

### Keybindings & CLI Overview

| Keybinding           | Action                              |
| -------------------- | ----------------------------------- |
| `Alt+H/J/K/L`        | Move to the pane left/down/up/right |
| `Ctrl+←/↓/↑/→`       | The same, with arrow keys           |
| `Ctrl+Tab`           | Next tab / window                   |
| `Ctrl+Shift+D`       | Split pane vertical (below)         |
| `Ctrl+Shift+E`       | Split pane horizontal (right)       |
| `Ctrl+Shift+W`       | Close current pane                  |
| `Ctrl+Shift+T`       | New tab / window                    |
| `Ctrl+Shift+[` / `]` | Previous / next tab                 |
| `Ctrl+Shift+F`       | Toggle float for current pane       |
| `Ctrl+Shift+Z`       | Zoom / unzoom active pane           |
| `Ctrl+Shift+A`       | Select the pane's scrollback        |
| `Ctrl+Shift+C`       | Copy the selection                  |
| `Ctrl+Shift+N`       | New window (desktop app)            |
| `Ctrl+Shift+1`…`9`   | Focus window 1…9 (desktop)          |

On macOS these are the `Cmd` shortcuts you would expect instead: `Cmd+A`,
`Cmd+C`, `Cmd+N` and `Cmd+1`…`9`. A _window_ here is an OS window — several can
watch one session, each on its own tab (Window ▸ New Window).

All mutations are also accessible from the terminal via the `tmuxy` CLI:

```bash
tmuxy pane float            # float the current pane or target pane
tmuxy pane unfloat          # unfloat back into the tiling layout
tmuxy queue push <id> <msg> # push message to an agent/pane queue
tmuxy queue pop <id>        # pop message (blocking or timed)
tmuxy ask <id> "question"   # ask confirmation in another pane
tmuxy tree                  # open interactive session/tab/pane tree
```

## getting started (development)

```bash
git clone https://github.com/flplima/tmuxy.git
cd tmuxy
npm run devcontainer
# I strongly recommend using the devcontainer, unless you don't mind
# messing with your host tmux sessions while vibe coding

# From here, ask your AI agent for help.
# Good luck!
```

The same `.devcontainer/` works in three places:

| Where                             | How it starts                  | Credentials                       |
| --------------------------------- | ------------------------------ | --------------------------------- |
| `bin/devcontainer` (plain Docker) | `npm run devcontainer`         | Named volumes; log in once inside |
| VS Code Dev Containers            | "Reopen in Container"          | Same named volumes                |
| GitHub Codespaces                 | "Create codespace" on the repo | Injected by Codespaces            |

No script hardcodes a workspace path — each derives the repo root from its own
location — so the workspace may live wherever the host puts it. Codespaces
ignores `runArgs` and the credential volumes; the scripts that maintain those
no-op when `$CODESPACES` is set. Enable **prebuilds** for the repo before using
Codespaces in anger: the image builds tmux and the Rust toolchain from source
and is slow cold.

GitHub Copilot's cloud coding agent uses neither — it bootstraps from
`.github/workflows/copilot-setup-steps.yml`.

## license

[MIT](LICENSE)
