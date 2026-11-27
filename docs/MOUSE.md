# Mouse reports to a program in a pane

A program in a pane that turns mouse tracking on gets the mouse the way a
terminal would give it: the UI builds SGR mouse reports itself and types them
into the pane. tmux's own mouse handling is not in the path. This page says
which modes a program can ask for, where the UI learns them, and what it
sends.

## What a program can ask for

| Mode              | Escape   | What the program gets                                                         |
| ----------------- | -------- | ----------------------------------------------------------------------------- |
| Press and release | `?1000h` | A report for each press and release, at the cell under the pointer            |
| Button motion     | `?1002h` | The same, plus a report while a button is held and the pointer moves (a drag) |
| Any motion        | `?1003h` | The same, plus a report when the pointer moves with no button held (hover)    |
| SGR encoding      | `?1006h` | Reports as `ESC [ < button ; x ; y M` (press, motion) or `m` (release)        |
| SGR-Pixels        | `?1016h` | The same reports, with x and y in pixels instead of cells                     |

Reports are always SGR, whatever encoding the program chose: a program that
asked for none of the extended ones still reads SGR. Positions are 1-based,
so the first cell, and the first pixel, is 1.

## Where the UI learns the modes

Each pane carries three flags on the wire (`TmuxPane` in
`tmuxy-core/src/state_types.rs`, `client.ts` in the UI).

| Flag                | Mode         | From the pane's output               | From tmux                      |
| ------------------- | ------------ | ------------------------------------ | ------------------------------ |
| `mouse_any_flag`    | any tracking | the parser's `mouse_protocol_mode`   | `#{mouse_any_flag}`            |
| `mouse_all_flag`    | 1003         | the parser's mode is any-motion      | `#{mouse_all_flag}`            |
| `mouse_pixels_flag` | 1016         | the parser's encoding is `SgrPixels` | none: tmux does not track 1016 |

The parser (`packages/vt100`, see its `PATCHES.md`) sees an escape the moment
the program sends it; `list-panes` agrees on the next poll. A capture refill
rebuilds the parser from the screen, which holds no modes, so
`fresh_terminal` in `control_mode/state/pane_output.rs` sets them again from
the pane's flags. Without that the flags would flap on every refill.

tmux cannot say a program asked for pixels, so the pixels flag lives only in
the pane's state. When `list-panes` says the pane tracks no mouse at all, the
pane forgets it, and tells the parser too (`forget_mouse_pixels`), so the next
program in the pane gets cells unless it asks for pixels itself.

## What the UI sends

The handlers are `components/terminal/usePaneMouse.ts` and
`paneMouseHelpers.ts`; the wheel goes through `scrollUtils.ts`.

| Event                                    | Report                                      |
| ---------------------------------------- | ------------------------------------------- |
| Press                                    | the button (0 left, 1 middle, 2 right), `M` |
| Release                                  | the button pressed, `m`                     |
| Move with a button held                  | the button plus 32, `M`                     |
| Move with no button held, only with 1003 | 35 (32 for motion, 3 for no button), `M`    |
| Wheel                                    | 64 up, 65 down, one report a row            |

**The position.** In cells, the cell under the pointer. With SGR-Pixels, the
pointer's offset in CSS pixels from the top-left corner of the pane's cell
grid (the scroll container, inside the pane's padding), rounded down, plus 1,
never below 1 (`reportPosition`). The unit is the CSS pixel, the same unit
the cell size is measured in, so a program that knows the cell size can turn
a pixel into a cell.

**How often.** In cells, a hover report goes only when the cell changes. In
pixels the position changes on nearly every pointer event, so motion, hover
and drag alike, is sent at most once an animation frame, the latest, and only
when it moved since the last report. A press or release drops a motion still
waiting for its frame, which would land after it. Hover over the pane's header
sends nothing.

**On the wire.** Every report goes out as `send-keys -H`, never pasted: tmux
3.7a eats an SGR sequence pasted into a mouse-tracking pane
([TMUX-VERSION-BUGS.md](TMUX-VERSION-BUGS.md)). The keystroke batcher
(`infra/transport/keyBatching.ts`) keeps mouse reports in a batch of their
own: a run of motion reports waiting in one frame goes as its latest, one
that repeats the report before it is dropped, and a key typed for the same
pane first flushes the mouse reports waiting for it, so the stream keeps the
order the user made it in and a stream of moves cannot hold a key back.

A program that asked for neither 1003 nor 1016 gets the bytes it always got:
`usePaneMouseReports.test.tsx` holds that, and
`tests/1-input-interaction-mouse-pixels.test.js` holds both modes on a real
tmux.

## The cell size

A pixel is only of use to a program that knows how big a cell is. The pane's
`TIOCGWINSZ` cannot say: tmux fills it with 16 by 32 pixels a cell, its
default for a client that has no terminal of its own, and a control-mode
client has no way to give it another. So the UI tells programs its cell
another way.

**Announced.** Each client writes the cell it draws, in the CSS pixels its
reports count in (the grid's `charWidth` and `charHeight`), to the global
option `@tmuxy-cell-px`, as `9x24` (up to two decimals: `8.5x17`). A program
reads it with `tmuxy run display-message -p '#{@tmuxy-cell-px}'`. Global, so
a pane of any session reads it; the server watches it with a subscription of
its own, as it watches the theme, and ships it to every client in the state
(`cell_px`).

**When a client writes it** (`cellSizeClaim` in `domain/cellSize.ts`): once
a connection has a state, if the option is unset or holds another size; and
again each time its own cell changes (a font, a line height, a browser zoom,
a grid fitted to another client's window). Never because the option changed:
two clients with different fonts would rewrite it at each other forever. The
last client to measure wins.

**Scaled reports.** A program counts pixels in the announced cell, so a client
whose own cell differs scales its pixel reports to it: each axis of the
pointer's offset times the announced side over its own, then rounded down,
plus 1. With the announced cell 9 by 24 and this client's 10 by 26, a pointer
15 px into the grid is 13.5 announced pixels, reported as 14. With no size
announced, or with this client's own (as written, so 8.5333 is 8.53), a report
is the client's own pixel, as before. The dock, drawn in a smaller font,
scales from its own cell the same way. Cell reports are never scaled.

**Asked.** A program can ask the terminal: `CSI 16 t` for the cell, answered
`CSI 6 ; height ; width t`, and `CSI 14 t` for the pane's text area, answered
`CSI 4 ; rows × height ; columns × width t`, whole pixels, rounded, height
first, as xterm has it. tmux 3.4 and later answer both themselves, from their
16 by 32, and nothing stops that answer reaching the program; so tmuxy answers
only on tmux 3.2 and 3.3, which do not, and only with a size announced. The
reply is typed into the pane that asked with `send-keys -H`, by the first
member of a session group only (two desktop windows share a pane, and each
monitor reads its output). A pane gets four replies a second at most. On tmux
3.4 and later the option is the one way to learn the real size.
`control_mode/cell_size.rs` holds the rules; [SECURITY-CONTENT.md](SECURITY-CONTENT.md)
says what pane output may cause here.

`tests/1-input-interaction-cell-size.test.js` holds the option and the
queries on a real tmux, against the cell and grid the page draws;
`cellSize.test.ts` (the domain's and the machine's) holds the write rule with
two clients, and `usePaneMouseReports.test.tsx` the scaling.

## Not sent

- Modifier bits (shift, alt, ctrl) on a report.
- Touch: a tap or a swipe on a phone is not turned into reports
  (`usePaneTouch.ts`).
