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

## Not sent

- Modifier bits (shift, alt, ctrl) on a report.
- The cell's size in pixels (`CSI 16 t`): a program that wants to map pixels
  to cells has no way to ask yet.
- Touch: a tap or a swipe on a phone is not turned into reports
  (`usePaneTouch.ts`).
