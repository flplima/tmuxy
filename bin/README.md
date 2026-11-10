# bin/

Scripts for working on tmuxy: the dev loop, environment setup, and the checks
CI runs. Nothing here ships in a release. The `tmuxy` CLI itself is
`packages/tmuxy-cli/`.

The top level is what a person or an agent runs by hand. `bin/ci/` is what the
workflows and the lint gate run for you.

## Top level

| Script              | Purpose                                                                                                                                                                                       | Run by                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `bootstrap`         | First run in a fresh checkout: `npm ci`, the extra rustup targets, a placeholder UI `dist`, and a `~/.local/bin/tmuxy` link to this checkout's CLI when no `tmuxy` is there yet.              | You, once; the devcontainer; the cloud agent's setup workflow            |
| `dev-server`        | The dev server (`cargo watch` + Vite HMR on port 9000, tmux socket `tmuxy-dev`) with `run`, `start`, `stop`, `restart`, `status` and `logs`. Stops every process it spawned, not only itself. | `npm start`, `npm stop`, `npm restart`, `npm logs`                       |
| `devcontainer`      | Builds and runs the devcontainer with plain Docker: `up`, `down`, `shell`, `run`, `logs`, `build`. One container and one host port per worktree.                                              | You                                                                      |
| `install-dev-tools` | The tooling on top of `npm ci` and Rust that an agent's environment needs: apt extras, `cargo-watch`, `agent-browser`, and with `--full` the Tauri driver and `wasm-bindgen`.                 | The devcontainer image; the cloud agent's setup workflow                 |
| `lint-gate`         | The one list of what is formatted, linted, type-checked and clippy'd. `format` rewrites; `check [<step>...]` is read-only; `steps` lists the step names.                                      | The pre-commit hook (`format`), the pre-push hook, CI's `lint` job       |
| `toolchain`         | The versions and package names every environment is built with, written once: Node, tmux, rust targets, the Tauri driver, `wasm-bindgen`, apt package sets. Also builds tmux from source.     | CI's composite actions, the Dockerfile, `bootstrap`, `install-dev-tools` |

## bin/ci/

### The policy check

`npm run check:policy` runs `bin/ci/policy.mjs`, the `policy` step of the lint
gate. It holds a few rules itself (no tmux subprocess beside control mode, no
blind waits in the suites, workflow invariants) and calls one module per rule
for the rest:

| Module                    | Rule                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `doc-paths.mjs`           | Every path and CI job name a doc quotes exists.                                                                       |
| `duplication.mjs`         | Duplicated lines may not grow past the count in `ratchets.json`.                                                      |
| `file-token-limit.mjs`    | No tracked file is over 5,000 tokens (bytes / 4).                                                                     |
| `homes.mjs`, `homes.json` | Each shared fact and each dangerous call (a spawned process, a tmux command) is written only in the files allowed to. |
| `import-cycles.mjs`       | The UI has no import cycles.                                                                                          |
| `invariant-enforcers.mjs` | Every test an `Enforced by` cell of `docs/INVARIANTS.md` names exists.                                                |
| `workflow-pins.mjs`       | Every remote action is pinned to a commit sha, and every `cargo install` in CI to a locked version.                   |

`complexity.mjs` is a lint-gate step of its own (`complexity`), since it lints
the UI a second time: the count of long and branchy functions may not grow
past `ratchets.json`.

### What the workflows run

| Script             | Purpose                                                                                                              | Workflow                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `apt-get`          | `sudo apt-get` with a 10-minute deadline and retries, since apt can hang with no output until the job times out.     | Every job that installs packages             |
| `ci-changes.mjs`   | From the files a push changed, says which long jobs (desktop, v86 probe, audit) it can skip.                         | `lint-and-tests.yml`                         |
| `e2e-plan.mjs`     | Turns `tests/e2e-suites.json` into the E2E job matrix for a tier (`commit`, `full`).                                 | `lint-and-tests.yml`                         |
| `nightly-issue`    | Keeps one tracking issue per nightly workflow: `report` comments or opens it, `resolve` closes it after a green run. | `nightly-v86.yml`, `nightly-tmux-matrix.yml` |
| `plugin-index.mjs` | Builds the plugin index: every public repository tagged `tmuxy-plugin` whose manifests pass `tmuxy plugin check`.    | `plugin-index.yml`, every six hours          |
| `wait-for-server`  | Waits until an http URL answers 2xx, or a `tcp://host:port` accepts a connection.                                    | Every job that starts a server first         |

### Tests

A `*.test.mjs` file tests the script beside it and runs with `npm test` (the
`scripts` project in `vitest.config.mjs`). Three of them cover more than one
file:

| Test                       | Holds                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ci-supply-chain.test.mjs` | The workflow pins, the Dependabot settings, and where the release build's signing secrets go.                             |
| `crate-graph.test.mjs`     | The path filters in the workflows match cargo's crate graph (`packages/tmuxy-core/tests/generated/crate-graph.gen.json`). |
| `toolchain.test.mjs`       | Nothing names a Node release of its own instead of asking `bin/toolchain`.                                                |

## Adding a script

- Something a person runs goes at the top level; something only a workflow or
  the lint gate runs goes in `bin/ci/`.
- A version or a package name goes in `toolchain`, never in a workflow.
- A new repo rule is a module in `bin/ci/` that `bin/ci/policy.mjs` imports, with
  its test beside it.
- Add a row here.
