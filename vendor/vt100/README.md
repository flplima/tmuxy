# vt100 (tmuxy fork)

A fork of the `vt100` terminal-emulation crate, version 0.16.2, that
`tmuxy-core` uses to re-emulate each pane's output. The root `Cargo.toml`
patches `vt100` to this directory, so `tmuxy-core` still depends on
`vt100 = "0.16"` and resolves here.

Upstream: https://github.com/doy/vt100-rust (MIT, see `LICENSE`).

What this fork changes, and why, is in `PATCHES.md`. Keep that file current
when `src/` changes: it is the only record of the delta, and the only way to
rebase onto a newer upstream.
