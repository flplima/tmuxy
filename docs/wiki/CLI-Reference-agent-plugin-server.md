Every subcommand and flag of `tmuxy agent`, `tmuxy plugin` and `tmuxy server`. The rest of the CLI is on [[CLI Reference]].

The flags common to every command (targets, `--json`, exit codes) are on [[CLI Reference]].

## agent

Show what Claude Code, Codex and Antigravity are doing on their tree rows: working, waiting for you, done, failed. Their hooks report to tmuxy, and the tmuxy skill is installed alongside so the agent knows the CLI.

| Command                                            | What it does                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `tmuxy agent install [agents...]`                  | Add the hooks and the skill. Default: every agent found                      |
| `tmuxy agent uninstall [agents...]`                | Remove them and leave everything else as it was                              |
| `tmuxy agent status [agents...]`                   | Each item is current, outdated, missing, foreign, unreadable or unsupported  |
| `tmuxy agent wait <pane>...` **(main)**            | Wait for agents in panes to stop                                             |
| `tmuxy agent spawn [-- cmd...]` **(main)**         | Start an agent in a new pane of your own tab, with its task                  |
| `tmuxy agent start <label> [-- cmd...]` **(main)** | Spawn an agent by name and return once it is ready                           |
| `tmuxy agent revive <pane>` **(main)**             | Bring an exited agent back into the same conversation                        |
| `tmuxy agent fork <pane>` **(main)**               | Carry a pane's agent conversation on in a new worktree and tab (Claude Code) |

The agents are `claude`, `codex`, `agy`, `opencode`, `pi` and `crush`. OpenCode, Pi and Crush take the skill only.

| Flag                    | Applies to                 | Meaning                                                                                                         |
| ----------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--hooks-only`          | install                    | Only the hooks                                                                                                  |
| `--skill-only`          | install                    | Only the skill                                                                                                  |
| `--project`             | install, uninstall, status | This project's config (`./.claude`, `./.codex`, `./.agents`) instead of the home folder's                       |
| `--dry-run`             | install, uninstall         | Say what would change, write nothing                                                                            |
| `--force`               | install                    | Replace a tmuxy skill tmuxy did not write                                                                       |
| `--until <states>`      | wait                       | States to wait for, comma-separated: `idle`, `needs-input`, `error`, `done`, `exited`. Default: any but working |
| `--all`                 | wait                       | Wait until every pane counts, not the first                                                                     |
| `--now`                 | wait                       | Count a pane already in a wanted state                                                                          |
| `--for <duration>`      | wait, start                | Give up after `30s`, `10m`, `2h` (exit 1). `start` defaults to `60s`                                            |
| `--agent <name>`        | spawn, start               | `claude` (default), `codex`, `gemini` or `cmd` (runs the command after `--`)                                    |
| `--label <L>`           | spawn                      | Name the pane. Must be unused                                                                                   |
| `--cwd <dir>`           | spawn, start               | Start in this folder                                                                                            |
| `--prompt <text>`       | spawn, start               | The agent's task                                                                                                |
| `--prompt-file <file>`  | spawn, start               | The task, from a file                                                                                           |
| `--permission-mode <M>` | spawn, start               | Passed to the agent as written                                                                                  |
| `--place stack\|split`  | spawn, start               | `stack` (default) is a collapsible row, `split` is a split below the caller's pane                              |
| `--focus`               | spawn, start               | Move the focus to the new pane                                                                                  |
| `--check`               | revive                     | Only say whether it can be revived: `ok`, or why not with exit 1                                                |
| `--branch <B>`          | fork                       | The new worktree's branch. Default: `fork-<start of the id>`                                                    |
| `--untracked`           | fork                       | Copy the pane's untracked files too                                                                             |

## plugin

Install, list, update and remove plugins, and run their actions. See [[Plugins]].

| Command                                          | What it does                                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmuxy plugin install [source]`                  | Install by index name, from GitHub `<owner/repo[/subdir][@ref]>`, or link a folder with `--path`. With no source, install exactly what `plugins.json` lists |
| `tmuxy plugin search [query]`                    | Search the plugin index                                                                                                                                     |
| `tmuxy plugin list [--json]`                     | The installed plugins                                                                                                                                       |
| `tmuxy plugin update [name]`                     | Move plugins to the latest commit of their ref. Asks again                                                                                                  |
| `tmuxy plugin remove <name>`                     | Uninstall a plugin. Its config stays unless `--purge`                                                                                                       |
| `tmuxy plugin config <name> [key [value]]`       | List, read or set a plugin's settings                                                                                                                       |
| `tmuxy plugin path <name>`                       | Where a plugin is installed                                                                                                                                 |
| `tmuxy plugin action <plugin>:<id> [-- args...]` | Run an action on a pane                                                                                                                                     |
| `tmuxy plugin log <name>`                        | What a plugin ran, and how it exited                                                                                                                        |
| `tmuxy plugin check [dir]`                       | Validate a plugin folder's manifest and commands. Default `.`                                                                                               |
| `tmuxy plugin new <name>`                        | Write `tmuxy-<name>/` to start from                                                                                                                         |
| `tmuxy plugin <verb> [args...]`                  | An installed plugin's own command                                                                                                                           |

| Flag             | Applies to           | Meaning                                                                   |
| ---------------- | -------------------- | ------------------------------------------------------------------------- |
| `--path <DIR>`   | install              | Link a local folder, used in place                                        |
| `--yes`          | install, update      | Do not ask. Needs a `--sha` for every commit fetched                      |
| `--sha <COMMIT>` | install, update      | A commit you reviewed. Once per commit the gate shows, or comma-separated |
| `--purge`        | remove               | Also delete the plugin's config folder                                    |
| `--force`        | remove               | Also remove the plugins that depend on it                                 |
| `--unset`        | config               | Put the setting back to its default                                       |
| `--pane <PANE>`  | action               | The pane it is about. Default: the caller's                               |
| `--wait`         | action               | Wait for the command and exit with its status                             |
| `-f`, `--follow` | log                  | Keep printing as it grows                                                 |
| `-j`, `--json`   | every plugin command | Answer in JSON                                                            |

A secret setting with no value is read from the terminal with echo off. Without a terminal, `install` needs `--yes` and a `--sha` for each commit.

## server

`tmuxy server [options]` starts the web server.

| Flag                    | Meaning                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port <PORT>`         | Port to listen on. Default `9000`                                                                                                                  |
| `--host <HOST>`         | Address to listen on. Default `127.0.0.1`. Any other address needs `--password`, or `--no-auth`                                                    |
| `--password <PASSWORD>` | Require HTTP Basic auth with this password (any username). Falls back to `TMUXY_PASSWORD`. Prefer the variable, which keeps the secret out of `ps` |
| `--no-auth`             | Serve a non-loopback `--host` with no password. Anyone who can reach the port gets a shell as you                                                  |
| `--allowed-host <HOST>` | A hostname requests may use besides loopback, such as a reverse proxy's public name. Repeatable. Also `TMUXY_ALLOWED_HOSTS`, comma-separated       |
| `--no-restore`          | Start a missing session empty even when a snapshot exists. Also `TMUXY_NO_RESTORE=1`                                                               |
| `--dev`                 | Development mode (proxy to the Vite dev server)                                                                                                    |
| `--trace [<PATH>]`      | Write a local action trace. Off by default on release builds. `DO_NOT_TRACK=1` or `TMUXY_NO_TRACE=1` force it off                                  |

| Command                             | What it does                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `tmuxy server stop`                 | Stop the running server                                                                               |
| `tmuxy server status [--json]`      | Whether it runs, and whether the service is installed and active                                      |
| `tmuxy server install` **(main)**   | Keep the server running at login (and at boot on Linux), as a systemd user service or a launchd agent |
| `tmuxy server uninstall` **(main)** | Stop the service and remove the file `install` wrote                                                  |

`server install` takes `--port <PORT>` (default `9000`), `--host <HOST>` (default `127.0.0.1`), `--allowed-host <HOST>`, `--no-linger` (on Linux, the service then runs only while you are logged in), `--dry-run` and `--json`. A non-loopback `--host` needs a line `TMUXY_PASSWORD=<secret>` in `server.env` in tmuxy's config folder, with mode `0600`. `tmuxy config paths` shows where. `server uninstall` takes `--dry-run` and `--json`.

## See also

- [[CLI Reference]]
- [[Sub-agents]]
- [[Plugins]]
- [[Remote Access]]
