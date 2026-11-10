# tmuxy-cli

The `tmuxy` command: `bin/tmuxy-cli` (the noun-verb dispatcher) and the
helper scripts under `bin/tmuxy/` that it, the key bindings and the UI run.

`bin/` ships with the app. tmuxy-core embeds every script in it (its build
script reads the directory, `packages/tmuxy-core/build.rs`) and writes them to
tmuxy's data dir (`~/.local/share/tmuxy/bin/`, read-only and marked
generated) on launch, so `bin/` here has the same layout as the installed
copy. The scripts find tmuxy's three directories (config, data, state) with
`tmuxy_config_dir`, `tmuxy_data_dir` and `tmuxy_state_dir` in `bin/tmuxy/_lib`,
which resolve them as tmuxy-core does. The values the scripts share with
tmuxy-core (the stash session's name, the pane-title format, the `@tmuxy-*`
option names and window types, the default socket and session, the exit
codes and the JSON failure's shape) are generated from it into
`bin/tmuxy/_options`, which `_lib` sources; a Rust test
(`tmuxy-core/tests/generated_constants.rs`) fails when the file is stale, and
writes it with `UPDATE_GENERATED=1`. The UI's copy is
`tmuxy-ui/src/domain/tmuxyConstants.gen.ts`, from the same test.

- **The server binary's verbs answer what a script would only copy.** Every
  command whose work is tmuxy-core's — `run` and `tab create`, `session
connect` and `connect`, `config`, `pane send`/`paste`, `pane float`, the
  pane groups, `agent`, `session save|restore|…`, `plugin`, `trace`, `skill`,
  `pane capture --format html` — is a `tmuxy-verbs` verb (`tmuxy-server <verb>`, the desktop app's `tmuxy
server <verb>`); the script resolves its target and caller and forwards.
  `--json` is handed on, and the verb answers through the contract below
  (`tmuxy_core::cli_contract`). `find_server_cmd` in `bin/tmuxy/_lib` is
  the one place a script finds the binary, on every host; the in-browser
  guests have no server and ship `tmuxy-verbs` instead, which runs every
  verb but the ones on tmuxy-core's async transport (`session save|…`,
  `session connect`, `connect`, `plugin`, `trace`) and answers those as not
  available here, under the contract.

- **Mutations go through `tmux run-shell`.** An external `tmux` command that
  mutates while control mode is attached crashes tmux 3.3a–3.5a. `_run_safe`
  and `_run_shell` in `bin/tmuxy/_lib` are the way in; read-only calls
  (`display-message -p`, `list-panes`) may run directly. See
  [docs/TMUX.md](../../docs/TMUX.md).
- **A script tells the server what it does** on the `run-shell` line that
  starts it, as a shell assignment ahead of the script (`tmux_compat.rs` in
  tmuxy-core reads them): `TMUXY_EFFECT=settle` for one that changes tmux in
  several steps (`pane-group add`, `float-create`), so the clients are not
  shown the steps; `TMUXY_EFFECT=relist-windows` for one that writes options tmux does
  not announce (`stack`), so the windows are re-listed behind it.
- **The contract with scripts and agents** (`tmuxy --help`): exit codes
  0 ok · 1 failed · 2 bad command line · 3 target not found or ambiguous ·
  4 no tmux server · 130 interrupted, and a wait (`pane run --wait`,
  `pane wait`) exits with the program's own status. `--json` works on every
  command: a mutation answers `{"ok":true,…}`, a failure
  `{"ok":false,"error","code"}` on stdout. A target is a pane id or a label
  (`@tmuxy-label`, else the pane title; `_resolve_target` in `bin/tmuxy/_contract`);
  an ambiguous label changes nothing. Every pane- and window-scoped command
  names the caller's pane (`CALLER_T`): tmux would otherwise resolve a
  target-less command from the CLI's unattached client to the session's
  current window, not the caller's.
- **`tmuxy server stop` and `status` find the server by its port**: the pid
  file is a shortcut, and when it is missing or names a dead or foreign
  process they ask the OS which tmuxy process listens on the port (see
  [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)).
- **`tmuxy pane state <word>` takes only the words core knows** (the
  `PaneStateName` list generated into `_options`, plus `clear`); any other
  word is a usage error, exit 2, and nothing is written.
- **`tmuxy run` allows tmux's reads** — `show-environment` and
  `show-prompt-history` like `list-panes` or `show-options` — and the
  arranging commands (`ARRANGE_VERBS`), and refuses the rest
  (`route_cli_run` in `packages/tmuxy-core/src/command_router/cli_run.rs`).
- **Tests:** `npm run test:cli` (`tests/cli/`, against mock `tmux` and
  `tmuxy-server` binaries; `cli-contract.test.js` holds the contract above,
  and `cli-guest-verbs.test.js` runs the guests' real `tmuxy-verbs`, which it
  builds with cargo, as the only verbs binary).
  A verb is tested in Rust: its logic in `tmuxy-verbs`, and against a real
  tmux in `packages/tmuxy-server/tests/` (`cli_verbs.rs`, `pane_groups.rs`).
- **Dev install:** the repo root's `bin/bootstrap` links this `bin/tmuxy-cli` as
  `~/.local/bin/tmuxy`, unless a `tmuxy` is already there (an installed app's wrapper).
