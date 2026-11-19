tmuxy runs two ways: as a desktop app, or as a web server you open in a browser. Pick one here, or use both on the same session.

## Choose

- **One machine, one screen:** use the desktop app. It is the fastest and has the most features.
- **A remote box, a phone or a tablet:** run the web server and open it in a browser.
- **No GUI on the machine:** the web server is the only option.

Panes, tabs, floats, groups, copy mode and the CLI behave the same in both.

## Start the desktop app

```bash
# From a terminal (or launch it from your applications menu)
tmuxy

# Open the GUI on this socket's session
tmuxy gui
```

It runs on macOS and Linux. It talks to the same Rust core as the web app through local IPC, with no network in between.

## Start the web server

```bash
tmuxy server            # start it in the background on port 9000
tmuxy server status     # is it running, and on which port
tmuxy server stop       # stop it
```

Then open `http://localhost:9000`. By default the server listens on `127.0.0.1`, so only this machine can reach it.

| Option                  | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `--port <PORT>`         | Port to listen on (default `9000`)                              |
| `--host <HOST>`         | Address to listen on (default `127.0.0.1`)                      |
| `--password <PASSWORD>` | Require HTTP Basic auth with this password. Any username works. |
| `--no-auth`             | Serve a non-loopback `--host` with no password                  |
| `--allowed-host <HOST>` | A public name for a reverse proxy. Repeatable.                  |
| `--no-restore`          | Start a missing session empty, even if a snapshot exists        |

### Open it to other machines

Anyone who reaches the port gets a shell as you. Put a password on it, and prefer a VPN or an SSH tunnel.

```bash
# Safest: keep the loopback default and tunnel in
ssh -NL 9000:localhost:9000 user@host

# Or listen on every address, with a password from the environment
# (TMUXY_PASSWORD keeps the secret out of `ps`)
TMUXY_PASSWORD='pick-something-long' tmuxy server --host 0.0.0.0
```

`--no-auth` is only for networks where everyone on them could already get a shell as you, like a container's published port or a private VPN. The full story is in [[Security]].

### Keep it running after you log out

```bash
# A systemd user service on Linux, a launchd agent on macOS
tmuxy server install
```

_On main, not in a release yet._ A non-loopback `--host` needs the password in a `server.env` file in the config folder (`tmuxy config paths` shows where), as a line `TMUXY_PASSWORD=<secret>` with mode `0600`. Add `--dry-run` to see what it would write. `tmuxy server uninstall` undoes it.

## What only the desktop app has

A browser tab is not given these things.

- **Trackpad gestures:** two-finger slide between tabs, pinch to zoom a pane, pinch in for the all-tabs view.
- **Several windows** on one session, with the Window menu.
- **Window styles**, the native title bar and the native menu bar.
- **Transparency and blur** behind the window (blur on macOS).
- **Other servers** in the session menu, including remote hosts over SSH (`tmuxy session connect`).
- **Links** open in your system browser.
- **Restart the app** from the menu.

The reasons, one by one, are in [docs/DESKTOP.md](https://github.com/flplima/tmuxy/blob/main/docs/DESKTOP.md).

## Side by side

|                         | Desktop app  | Web app                               |
| ----------------------- | ------------ | ------------------------------------- |
| Runs on                 | macOS, Linux | Any browser, served by `tmuxy server` |
| Transport               | Local IPC    | HTTP and SSE                          |
| Needs a server process  | No           | Yes                                   |
| Several windows         | Yes          | One per browser tab                   |
| Trackpad gestures       | Yes          | No (the browser keeps them)           |
| Remote servers over SSH | Yes          | No                                    |
| Reach it from a phone   | No           | Yes (experimental)                    |
| Password                | Not needed   | Required off loopback                 |

## See also

- [[Installation]]
- [[Remote Access]]
- [[Phone and Tablet]]
- [[Security]]
