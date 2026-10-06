/**
 * Wire payloads sized like a real session, for the hot-path benchmarks: a
 * 4-pane 200-column state and the delta a keystroke's echo produces.
 */

export const COLS = 200;
export const ROWS = 60;
export const PANES = 4;

function row(y: number): unknown[] {
  return Array.from({ length: COLS }, (_, x) =>
    x % 7 === 0 ? { c: 'x', s: { fg: (x + y) % 256, bold: true } } : { c: 'a' },
  );
}

function pane(n: number, rows: number): Record<string, unknown> {
  return {
    id: n,
    tmux_id: `%${n}`,
    window_id: '@1',
    content: Array.from({ length: rows }, (_, y) => row(y)),
    cursor_x: 3,
    cursor_y: 4,
    width: COLS,
    height: rows,
    x: 0,
    y: 0,
    active: n === 0,
    command: 'zsh',
    title: 'host',
    border_title: '',
    in_mode: false,
    copy_cursor_x: 0,
    copy_cursor_y: 0,
    alternate_on: false,
    mouse_any_flag: false,
    paused: false,
    history_size: 2000,
    selection_present: false,
    selection_start_x: 0,
    selection_start_y: 0,
    cursor_shape: 0,
    cursor_hidden: false,
  };
}

/** A full `state-update` whose panes are `rows` tall. */
export function fullUpdate(rows: number): unknown {
  return {
    type: 'full',
    state: {
      session_name: 'tmuxy',
      active_window_id: '@1',
      active_pane_id: '%0',
      panes: Array.from({ length: PANES }, (_, n) => pane(n, rows)),
      windows: [
        { id: '@1', index: 1, name: 'main', active: true, window_type: 'tab' },
        { id: '@2', index: 2, name: 'logs', active: false, window_type: 'tab' },
      ],
      total_width: COLS,
      total_height: rows,
    },
  };
}

/** A keystroke's echo: two changed rows and the cursor of one pane. */
export function typicalDelta(seq: number): unknown {
  return {
    type: 'delta',
    delta: {
      seq,
      panes: { '%0': { content: { 10: row(10), 11: row(11) }, cursor_x: 12, cursor_y: 11 } },
    },
  };
}
