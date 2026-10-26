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
- **An unused alternate screen holds no rows**: `Grid::free_rows` drops them,
  `Screen` calls it when the application leaves the alternate screen (tmux
  drops it then too, so re-entering with `?47` starts blank), and `set_size`
  leaves a grid with no rows unallocated instead of filling it on every
  resize. Upstream kept a full grid per pane that had ever run a full-screen
  program, and allocated one on the first resize for panes that never had.
  Covered by `tests/terminal_fidelity.rs` in tmuxy-core.
- **Scrollback rows keep only what they show**: a row moving off the screen
  goes through `Grid::push_scrollback`, which drops its blank tail
  (`Row::trim_blank_tail`); every way back onto a screen already resizes the
  row to the grid's width. A full-width row per line of `seq` output was most
  of a pane's memory at 256 rows of reflow history. Covered by
  `tests/terminal_fidelity.rs` in tmuxy-core.
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
- **`Screen::take_scrollback` / `restore_scrollback`** (`Grid` has the same
  pair): the rows above the screen moved from one screen to another, so
  tmuxy can rebuild a pane's screen from a `capture-pane` without forgetting
  the history that scrolled off it — which is all the history an observer has.
- **DECSCUSR** (`CSI Ps SP q`, dispatched in `perform.rs`): the cursor style
  the application last asked for, `Screen::cursor_shape`. tmuxy draws the
  cursor itself and used to scan the raw bytes for the sequence beside the
  parser; the parser is where every other escape is read.

## Removed: the serializers

tmuxy reads the screen cell by cell and never turns one back into a byte
stream, so upstream's `Screen::{state,contents,rows,input_mode,attributes,
cursor_state}_formatted`, `Screen::{state,contents,rows,input_mode}_diff`,
the `Grid`, `Row` and `Attrs` writers behind them, and the whole `term`
module (the escape-code builders, with the `itoa` dependency) are gone —
about 1,300 lines no caller reached. `Screen::contents`, `rows`,
`cursor_position` and the cell accessors stay.

## `cell.rs`

- `Cell::can_append` makes the fixed content buffer's capacity check exact (the
  character's UTF-8 length, not a constant margin) and is shared with
  `combine`; `set_wide` is `pub(crate)` so the widen path can use it.
