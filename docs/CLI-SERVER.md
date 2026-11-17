# `tmuxy server` reference

Generated from `--help` by `node bin/ci/cli-reference.mjs`; the other commands are in [CLI.md](CLI.md).

## `tmuxy server`

```text
Tmuxy production server with embedded frontend

Usage: tmuxy-server [OPTIONS] [COMMAND]

Commands:
  stop       Stop the running server
  status     Show server status: whether it runs, and whether the service is installed and active
  install    Keep the server running at login (and, on Linux, at boot), as a systemd user service or a launchd agent. A non-loopback --host needs a password in `server.env` in tmuxy's config dir
  uninstall  Stop the service and remove the file `install` wrote
  trace      Inspect a local action-trace file: print a summary, or export a Chrome-trace/Perfetto timeline with `--export` (docs/TRACING.md)
  session    Save, restore, list or forget session snapshots. Backs `tmuxy session save|restore|snapshots|forget`
  agent      Wire coding agents (Claude Code, Codex, Antigravity) into tmuxy: hooks that show their state, and the tmuxy skill. Backs `tmuxy agent`
  plugin     Install, list, update and remove plugins, and run their actions. Backs `tmuxy plugin` (docs/PLUGINS.md)
  config     The config files tmuxy-core owns: `paths`, `reload`, `init`, `use-tmux-conf`, `doctor`. Backs `tmuxy config`
  keymap     Every key binding, and the file and line it comes from. Backs `tmuxy keymap`
  skill      Print the agent guide (the tmuxy skill). Backs `tmuxy skill`
  help       Print this message or the help of the given subcommand(s)

Options:
      --port <PORT>          Port to listen on [default: 9000]
      --host <HOST>          Address to listen on. The default is reachable from this machine only (and through an SSH tunnel). Any other address needs --password, or --no-auth to serve it open [default: 127.0.0.1]
      --password <PASSWORD>  Require HTTP Basic auth with this password (any username is accepted). Falls back to the TMUXY_PASSWORD env var. Prefer TMUXY_PASSWORD to keep the secret out of `ps`
      --no-auth              Serve a non-loopback --host with no password. Anyone who can reach the port gets a shell as you, so only on a network where that is already true of everyone on it (a container's published port, a private VPN)
      --allowed-host <HOST>  A hostname requests may be addressed to besides loopback ones — the public name of a reverse proxy that forwards its `Host`. Repeatable; also read from TMUXY_ALLOWED_HOSTS (comma-separated)
      --no-restore           Start a missing session empty even when a snapshot of it exists (`TMUXY_NO_RESTORE=1` does the same)
      --dev                  Run in development mode (proxy to Vite dev server)
      --trace [<PATH>]       Enable local action tracing to an NDJSON file (see docs/TRACING.md). Pass a path to choose the file, or bare `--trace` for the default under the state dir. Off by default on release builds; the trace never leaves this machine. `DO_NOT_TRACK=1` or `TMUXY_NO_TRACE=1` force it off
  -h, --help                 Print help
```
