# Telemetry and Network Connections

**tmuxy collects no telemetry.** The server, the desktop app and the CLI send
nothing about you, your machine or your sessions to us or to anyone else: no
analytics, no crash reports, no usage counters, no update check. Every
connection tmuxy makes is listed below, with what starts it and how to stop it.

This page covers tmuxy itself. The programs you run in its panes make their own
connections, which tmuxy neither sees nor controls. The website at
[tmuxy.sh](https://tmuxy.sh) is a separate thing and has a section of its own
(it does use analytics). If something here is wrong, or a connection is missing,
treat it as a bug and open an issue.

## The app (server, desktop, CLI)

| What connects | When | To where | What is sent | How to turn it off |
| --- | --- | --- | --- | --- |
| The web server listens | While `tmuxy server` runs | Inbound on `127.0.0.1:9000` by default (`--host`, `--port`) | It serves the UI, the state stream (`/events`: everything the session shows) and takes commands and keystrokes (`/commands`, `/api/*`) | Do not run `tmuxy server`, or keep the loopback default; see [SECURITY-NETWORK.md](SECURITY-NETWORK.md) |
| The browser UI talks to the server it came from | While a tab of the web UI is open | The same origin that served it | Keystrokes, commands, its viewport size; the trace, only when tracing is on (below) | Close the tab |
| The web UI loads the Font Awesome stylesheet | Each load of the web UI, unless the browser has it cached | `cdnjs.cloudflare.com` | An ordinary stylesheet request: your IP address, user agent and the page's origin as `Referer` | Block the host in the browser. The desktop app never makes this request: its Content-Security-Policy refuses it. The UI draws no icon from it (its icons come from the bundled Nerd Font). |
| The desktop app | Never, on its own | Nowhere: it serves no HTTP and talks to tmux over a local socket | Nothing | Nothing to turn off |
| A remote server over SSH | When you attach the desktop app to a saved SSH server | The host you added, through your own `ssh` and its config | tmux commands and your keystrokes go out; the session's screen comes back | Do not attach one; remove it from `~/.config/tmuxy/servers.json`. See [TMUX-CONFIG.md](TMUX-CONFIG.md#remote-servers-over-ssh-desktop-app) |
| `tmuxy session connect <host>` | When you run it (also from the switcher's "Connect over SSH…") | The host you name, through `ssh -o BatchMode=yes` | `true`, `tmux -V` and a session listing, to check the host before saving it | Do not run it |
| A link you click | When you click a link in a pane or a preview | Your default browser opens it (desktop), or the browser follows it (web) | Whatever a browser sends to that site; tmuxy only hands over `http(s)` and `mailto` links | Do not click it |
| A preview opened with `--net` | When you run `tmuxy open --net <file>` and the document references remote resources | The hosts the document names | Whatever the document's images, styles and scripts request | Leave out `--net`: by default a preview fetches nothing remote. See [SECURITY-CONTENT.md](SECURITY-CONTENT.md#a-preview-reads-one-file) |
| The trace | When tracing is on: by default in a development build, by your own choice in a release | A local file (`trace.ndjson` in the state directory); a browser client posts its events to its own server's `/trace`, which writes them there | Action names and timings, never what you type or what programs print | It is off unless you turn it on (the Debug menu). See [TRACING.md](TRACING.md) |
| The dev proxy | `tmuxy server --dev` only, a contributor's setup | `localhost:9001` (Vite) | The page requests it forwards | Do not pass `--dev` |
| The WebDriver plugin | Test builds of the desktop app only, built with the `webdriver` feature | Inbound on a local port (4445) | WebDriver commands from the test runner | A release build does not contain it |

What stays on the machine and is easy to mistake for a connection: the git
branch badges in the tree run `git` locally on the panes' directories and
return nothing for an SSH server; session snapshots, the theme files and the
saved-servers list are local files.

### Updates

tmuxy does not check for updates. Neither the desktop app nor the server asks
anywhere whether a newer version exists. You update it the way you installed
it: `brew upgrade` (Homebrew has analytics of its own, which `brew analytics
off` turns off) or a new download from GitHub Releases.

## The website (tmuxy.sh)

The website is a static page with the demo in it. It runs a copy of tmuxy in a
virtual machine inside your browser tab; that machine has no network.

| What connects | When | To where | What is sent | How to turn it off |
| --- | --- | --- | --- | --- |
| The page and its files | When you open the site | GitHub Pages, which hosts it | Ordinary page requests (IP address, user agent), logged under GitHub's own privacy terms | Do not open the site |
| Google Analytics | On each visit, when the site was built with an analytics id, as the published site is | Google (`googletagmanager.com`, `google-analytics.com`) | A page view, and these events: using the demo, switching its tab (with the tab's name), copying an install command (with the OS it was for), and clicking the GitHub, releases, DeepWiki or share links | A content blocker, your browser's tracking protection, or Google's opt-out add-on; the demo works the same without it |
| The CheerpX runtime | When your browser can run it (the page is cross-origin isolated) | `cxrtnc.leaningtech.com`, Leaning Technologies' CDN | The script request; what the runtime does after it loads is Leaning Technologies' | A browser that cannot isolate the page runs the demo on v86 instead, from the site itself |
| The demo's nyan cat | When the demo starts | `gist.githubusercontent.com` | The image request | Block the host; the demo starts without the picture |

## Related

- [SECURITY-NETWORK.md](SECURITY-NETWORK.md) — where the server listens and how to expose it safely
- [TRACING.md](TRACING.md) — the local trace and its redaction boundary
- [DESKTOP.md](DESKTOP.md) — what only the desktop app does, SSH servers among it
