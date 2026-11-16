# Sandboxes

`bin/sandbox` runs one agent in one container, reached through one loopback
port. It is meant for an agent with permissions skipped: inside, nothing is
worth guarding, so nothing needs a prompt. Work leaves only as a git bundle the
host checks before anything is pushed.

A sandbox buys isolation and a preview URL. It does not buy CPU or memory: it
runs the same compiler on the same cores, and every sandbox holds its own
`node_modules`, `target/` and dev stack.

`bin/devcontainer` is a different thing: a convenience container that
bind-mounts the checkout (and the main `.git`), shares gh, SSH and Claude login
volumes, starts as root and publishes four ports. Use it to work in a
container yourself; use a sandbox to hand a container to an agent.

## Commands

| Command | What it does |
| --- | --- |
| `bin/sandbox up <slug> [--from <branch>] [--memory 4g] [--pids 4096]` | Creates the network, the volumes and the container, then returns. Inside, the container clones `<branch>` (default `main`) from GitHub over HTTPS onto `sandbox/<slug>` and runs `npm ci`. Never builds the image; it says how old the one it uses is. |
| `bin/sandbox ls` | Every sandbox, from the Docker labels: slug, branch, status, port |
| `bin/sandbox preview <slug>` | Starts the dev server (with its Vite) and Storybook inside, on demand, and prints `http://127.0.0.1:<port>/` and `/storybook/` |
| `bin/sandbox shell <slug> [cmd…]` | A login shell inside, or one command |
| `bin/sandbox claude <slug>` | Attaches to `claude --dangerously-skip-permissions` in a `claude` session of the sandbox's own tmux, starting it on the first call |
| `bin/sandbox logs <slug> [init\|dev\|storybook] [-f]` | The start-up log (clone, install, proxy), the dev server's, or Storybook's |
| `bin/sandbox collect <slug>` | Bundles `sandbox/<slug>` out, checks it in a quarantine repository, asks, and pushes only on `y` (below) |
| `bin/sandbox down <slug> [--purge]` | Removes the container and its network. The workspace and cargo volumes stay, so `up` again resumes the branch; `--purge` removes them and the quarantine too |

The host port is Docker's pick and changes when the container restarts; `ls`
and `preview` print the current one. A sandbox runs the branch it cloned, so
the one-port routes need that branch to carry the environment switches below.

The slug is checked (`[a-z0-9-]`, up to 40) because it names a container, a
network, two volumes and a branch. The branch is a Docker label set at `up`;
`collect` reads it from there, never from inside the sandbox.

The image is the shared `tmuxy-dev` one, built by `bin/devcontainer build` from
`.devcontainer/Dockerfile`, which carries Caddy for this. What runs inside is
`.devcontainer/sandbox/`: `init.sh` (the main process), `preview.sh` and the
`Caddyfile`. `up` copies that directory from the host checkout into the
container before it starts, so the clone cannot change how the proxy or the
start-up behave.

## What the container gets

| Setting | Value | Why |
| --- | --- | --- |
| User | uid 1000, `--cap-drop ALL`, `no-new-privileges` | No root, no sudo, no capability to regain either |
| Memory | `--memory` and `--memory-swap` equal (default 4g) | A build that runs out fails loudly inside, instead of the host's out-of-memory killer taking the whole container at high swap with no error anywhere |
| Processes | `--pids-limit` (default 4096) | A fork bomb stops at the cgroup |
| Network | its own bridge network, `tmuxy-sbx-<slug>` | Sandboxes cannot reach each other |
| Ports | only `127.0.0.1::8080`, Docker picks the host port | One way in, loopback only: a sandbox is an unauthenticated shell |
| Workspace | named volume `tmuxy-sbx-ws-<slug>`, a fresh `git clone` from GitHub over HTTPS | No host checkout and no host `.git` inside, not even read-only: it holds stashes, unpushed branches and the hooks path |
| Cargo registry | named volume `tmuxy-sbx-cargo-<slug>` | Kept across `down`/`up` without sharing a writable volume with another sandbox |
| Credentials | `CLAUDE_CODE_OAUTH_TOKEN` when the caller has it set, passed by name so it is on no command line | Nothing else: no gh login, no SSH key, no git credentials, no `~/.claude` |
| Environment | `TMUX`, `TMUX_PANE`, `TMUX_BIN` and `TMUXY_PASSWORD` are unset before any docker call | Nothing of the host's tmux reaches inside |
| Labels | `dev.tmuxy.sandbox`, `dev.tmuxy.branch`, `dev.tmuxy.from` | `ls`, `collect` and the port lookup read these |

`init.sh` ends by exec'ing Caddy, so the container's main process is never a
shell: `bin/dev-server start` reaps shells parented to pid 1 that have no CPU
time, and a waiting `init.sh` is exactly that. Caddy dials Vite by the name
`localhost`, since Node binds it to `::1` first.

Inside there is a tmux server of its own (the default socket; the preview's
server uses `tmuxy-dev`), its own `/tmp`, its own ports and the image's
Chromium, so E2E runs and dev servers in two sandboxes never meet. Commits are
authored with the host's `user.name` and `user.email`, copied into the clone's
local config.

Use a model token minted only for sandboxes (`claude setup-token`), know how to
revoke it, and cap its usage: it is the one thing inside worth stealing.

## One port

Caddy listens on 8080 inside and is the only published port. The app and
Storybook share the origin, so the HMR sockets of both must go through it too.

| Request | Goes to | Why |
| --- | --- | --- |
| `/storybook/` with a websocket upgrade | Storybook (6006), prefix kept | Vite upgrades only on the exact base path; a stripped upgrade hangs with no error |
| `/storybook/*` | Storybook, prefix stripped | `STORYBOOK_BASE=/storybook/` makes module URLs carry the prefix |
| `/storybook-server-channel`, `/vite-inject-mocker-entry.js`, `/@id/__x00__virtual:/@storybook/*` | Storybook | Three absolute URLs Storybook writes without the base |
| `/wasm/*`, `/v86/*`, `/v86-img/*` | Storybook | Static dirs the v86 stories fetch by absolute path |
| `/__vite_hmr` | Vite (9001), directly | `TMUXY_VITE_HMR_PATH`; the server's dev proxy drops `Upgrade` |
| everything else, `/themes/*` included | `tmuxy-server --dev` (9000) | The app |

The environment switches, all set by `up` and all off when unset:

| Variable | Read by | Effect when set |
| --- | --- | --- |
| `STORYBOOK_BASE` | `packages/tmuxy-ui/.storybook/main.ts` | Vite `base` set to it, and the builder's HMR port dropped so the client dials the page's port |
| `STORYBOOK_ALLOWED_HOSTS` | the same | `core.allowedHosts`, for a proxy reached by a name that is not localhost or an IP |
| `TMUXY_VITE_HMR_PATH` | `packages/tmuxy-ui/vite.config.ts` | HMR on that path of the page's own port, instead of port 9001 |

With none set, Storybook and the app's Vite behave exactly as before
(`tests/dev_ports.rs` still holds the 9001 pair). The dev server binds
127.0.0.1 inside (`TMUXY_DEV_HOST`), so Caddy is the only way to it.

Known costs of sharing an origin: Storybook and the app share local storage,
so loading a story can clear the app's phone-split preference and a theme story
can overwrite the saved theme. The story probes keep using Storybook's own
port. `/storybook/*` and both sockets bypass tmuxy-server's request guard,
which is why the port is loopback only. A host name other than localhost needs
allow-listing in three places: `TMUXY_ALLOWED_HOSTS`, `STORYBOOK_ALLOWED_HOSTS`
and the HMR route. Reach a sandbox from another machine through an SSH tunnel,
never a name that publishes it.

Measured in a spike: Storybook's dev server holds about 500 MB, Vite about
630 MB with its esbuild child, Caddy 16 MB. That is why the stack starts only
on `preview`.

## Getting work out: collect

The container is not where the risk is. Three attacks were reproduced against
the naive way of getting a branch out:

| Naive step | What a hostile sandbox did with it |
| --- | --- |
| `git fetch` from the sandbox's repository | An `alternates` file and a symlinked ref pulled another repository's history into the branch, and a tag was planted |
| Check the branch out on the host | The branch's hooks ran as the host user, since the repository's hooks path is in-tree; `checkout`, `worktree add` and `merge` all ran them |
| Push the branch | Its workflow files ran in CI with every repository secret, before any review |

So `collect` treats everything that comes out as hostile input:

| Step | What it does |
| --- | --- |
| Quarantine | A fresh bare repository in the host's state dir (`~/.local/state/tmuxy/sandbox/quarantine-<slug>.git`), with no global or system git config and an empty hooks directory. It is seeded from trusted sources only: this checkout's `origin/*` and `main`, and `main` from GitHub |
| Bundle | Inside, `git bundle create` of `refs/heads/sandbox/<slug>` alone, leaving out the commits the host already has, piped out through a size cap (`SANDBOX_BUNDLE_MAX_MB`, default 200) |
| Fetch | `bundle verify`, then one refspec to `refs/heads/sandbox/<slug>`, `--no-tags`, with `transfer.fsckObjects`. Any other ref in the quarantine refuses |
| Refuse | Any change under `.github/workflows/` or `.github/actions/`, and a branch that shares no history with `main` |
| Flag | Other `.github/` files and hooks, `bin/`, `.devcontainer/`, `.claude/`, `.agents/`, `AGENTS.md`, `.gitmodules`, `.gitattributes`, `.npmrc`, `.cargo/`; a `package.json` whose `scripts` changed; a lockfile entry from outside npm's registry or crates.io; a `Cargo.toml` patch, git or path dependency; symlinks; new executables; merges; more than 50 commits |
| Show | The commits and the diffstat, with control characters stripped so the text cannot drive the terminal |
| Ask | `y` pushes; anything else, or no terminal answer, stops |
| Push | Only that branch, to GitHub over HTTPS, with the host's credentials and still no hooks; then prints the `gh pr create --draft` line |

Never check out, build or test a sandbox branch on the host before it is
merged: review it on GitHub or in another sandbox. The quarantine is for
reading with `git log` and `git diff`, nothing else.

## Before the first run

| Who | What |
| --- | --- |
| GitHub | Release secrets in environments restricted to the tags and branches that need them, and a pull request required on `main` |
| Host | The host's SSH daemon unreachable from Docker networks, or password login off |
| Host | The repository's hooks path pointed outside every worktree |
| You | A dedicated `claude setup-token` for sandboxes, exported as `CLAUDE_CODE_OAUTH_TOKEN` in the shell that runs `up` |
| Agent | One measurement run (peak memory, peak pids, wall time for the gates and one E2E shard) to set `--memory` and `--pids` from numbers rather than the defaults |

## Next steps (not in v0)

| Step | What it adds |
| --- | --- |
| Allow-list egress proxy | An internal network whose only way out is a proxy allowing the model API, npm and crates.io, first in logging mode. It also moves Caddy to a front container outside, since a container on an internal network cannot publish a port and a proxy inside belongs to the agent |
| Index page on a fixed port | One page listing every sandbox from the Docker labels, with its preview links |
| Golden pre-warmed volume | A volume with a clone of `main`, `node_modules`, `target/` and the cargo registry, copied per sandbox so `up` skips the install and the cold build; unchanged files keep their mtimes, so only touched crates rebuild |
| Collect broker | The agent drops a request in an outbox; the host pushes automatically when the diff avoids the flagged paths and writes the CI verdict back |
| Model token outside | The token held by a gateway outside the sandbox, so nothing inside can be stolen at all |

## Related

- [SECURITY.md](SECURITY.md): the threat model, and the LLM-assisted development risks a sandbox answers
- [TESTS.md](TESTS.md): the sockets and isolation the E2E suite expects
