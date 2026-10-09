# Patches against upstream vt100 0.16.2

This directory is a fork of the `vt100` crate (crates.io `vt100-0.16.2`,
https://github.com/doy/vt100-rust), wired into the workspace through
`[patch.crates-io]` in the root `Cargo.toml`. Only `src/` differs from the
published crate. Each change below exists because tmux lays text out one way
and upstream vt100 another, and tmuxy re-emulates tmux's output cell for cell
(see `docs/RICH-RENDERING.md`, "Character width parity").

## `grid.rs`

- **`scroll_delta`**: a monotonic `i64` counter of whole-screen scrolls (+1 per
  row scrolled off the top, −1 per reverse scroll), exposed as
  `Grid::scroll_delta` and `Screen::scroll_delta`. Scrolls inside an active
  scroll region do not count. tmuxy-core's OSC 8 cell→URL map shifts its marks
  by the delta between two reads so a link stays on the text it was written on.
- **Cursor-preserving vertical reflow in `set_size`**: shrinking first drops
  rows below the cursor, and only then scrolls rows off the top into
  scrollback; growing pulls rows back out of scrollback. Upstream's
  `Vec::resize` truncated at the bottom and lost the rows for good, which
  rendered a pane empty after un-zooming. Covered by
  `tests/pane_reflow_parity.rs` and `tests/zoom_resize_probe.rs` in tmuxy-core.
- **`col_back_tab`**: moves to the previous multiple-of-8 tab stop, for CBT.
- **`col_wrap` on degenerate grids**: saturating arithmetic and an `if let`
  instead of an `unwrap`, so a one-row or one-column grid cannot underflow or
  panic (`tests/degenerate_size.rs`).

## `perform.rs`

- Extra CSI dispatches: **HPA** (`` ` ``, as CHA), **HPR** (`a`, as CUF),
  **CHT** (`I`), **CBT** (`Z`), **REP** (`b`, repeats the last printed graphic
  character, tracked in a new `last_char` field) and **HVP** (`f`, as CUP).

## `screen.rs`

- **Port of tmux's `screen_write_combine`** (`Screen::combine`, replacing
  upstream's width-0 branch of `text`): a zero-width joiner, VS16 or a
  combining mark merges into the cell before the cursor; so does the character
  that follows a ZWJ, a skin-tone modifier after an emoji it may attach to
  (tmux's `utf8_should_combine` table), and the second regional indicator of a
  flag. VS16 and a completed pair widen a narrow cell to two columns, the way
  tmux does with `variation-selector-always-wide on`. U+3164 HANGUL FILLER is
  dropped, as tmux drops it. Covered by the `zwj_*`, `regional_indicator_*` and
  `skin_tone_*` tests in tmuxy-core.
- **Wide-continuation background**: the second half of a wide character is
  cleared with the character's own attributes rather than the defaults, so a
  wide glyph on a coloured row (an editor's cursor line) leaves no
  default-background hole beside it.
- **Width clamp**: a character is never wider than the grid, and a zero-column
  grid draws nothing instead of indexing a cell that does not exist.

## `cell.rs`

- `Cell::can_append` makes the fixed content buffer's capacity check exact (the
  character's UTF-8 length, not a constant margin) and is shared with
  `combine`; `set_wide` is `pub(crate)` so the widen path can use it.
