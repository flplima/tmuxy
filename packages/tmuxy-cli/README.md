# tmuxy-cli

The `tmuxy` command: `bin/tmuxy-cli` (the noun-verb dispatcher) and the
helper scripts under `bin/tmuxy/` that it, the key bindings and the UI run.

`bin/` ships with the app. tmuxy-core embeds every script in it
(`packages/tmuxy-core/src/session/assets.rs`) and writes them to
tmuxy's data dir (`~/.local/share/tmuxy/bin/`, read-only and marked
generated) on launch, so `bin/` here has the same layout as the installed
copy. A new helper under `bin/tmuxy/` must be added to that list; a Rust test
fails until it is. The scripts find tmuxy's three directories (config, data,
state) with `tmuxy_config_dir`, `tmuxy_data_dir` and `tmuxy_state_dir` in
`bin/tmuxy/_lib`, which resolve them as tmuxy-core does.

- **Mutations go through `tmux run-shell`.** An external `tmux` command that
  mutates while control mode is attached crashes tmux 3.3a–3.5a. `_run_safe`
  and `_run_shell` in `bin/tmuxy/_lib` are the way in; read-only calls
  (`display-message -p`, `list-panes`) may run directly. See
  [docs/TMUX.md](../../docs/TMUX.md).
- **The contract with scripts and agents** (`tmuxy --help`): exit codes
  0 ok · 1 failed · 2 bad command line · 3 target not found or ambiguous ·
  4 no tmux server · 130 interrupted, and a wait (`pane run --wait`,
  `pane wait`) exits with the program's own status. `--json` works on every
  command: a mutation answers `{"ok":true,…}`, a failure
  `{"ok":false,"error","code"}` on stdout. A target is a pane id or a label
  (`@tmuxy-label`, else the pane title; `_resolve_target` in `bin/tmuxy/_lib`);
  an ambiguous label changes nothing. Every pane- and window-scoped command
  names the caller's pane (`CALLER_T`): tmux would otherwise resolve a
  target-less command from the CLI's unattached client to the session's
  current window, not the caller's.
- **Tests:** `npm run test:cli` (`tests/cli/`, against mock `tmux` and
  `tmuxy-server` binaries; `cli-contract.test.js` holds the contract above).
- **Dev install:** the repo root's `bin/bootstrap` links this `bin/tmuxy-cli` as
  `~/.local/bin/tmuxy`.
