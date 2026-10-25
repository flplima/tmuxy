# tmuxy-cli

The `tmuxy` command: `bin/tmuxy-cli` (the noun-verb dispatcher) and the
helper scripts under `bin/tmuxy/` that it, the key bindings and the UI run.

`bin/` ships with the app. tmuxy-core embeds every script in it
(`packages/tmuxy-core/src/session/assets.rs`) and writes them to
`~/.config/tmuxy/bin/` on launch, so `bin/` here has the same layout as the
installed copy. A new helper under `bin/tmuxy/` must be added to that list;
a Rust test fails until it is.

- **Mutations go through `tmux run-shell`.** An external `tmux` command that
  mutates while control mode is attached crashes tmux 3.3a–3.5a. `_run_safe`
  and `_run_shell` in `bin/tmuxy/_lib` are the way in; read-only calls
  (`display-message -p`, `list-panes`) may run directly. See
  [docs/TMUX.md](../../docs/TMUX.md).
- **Tests:** `npm run test:cli` (`tests/cli/`, against mock `tmux` and
  `tmuxy-server` binaries).
- **Dev install:** the repo root's `bin/bootstrap` links this `bin/tmuxy-cli` as
  `~/.local/bin/tmuxy`.
