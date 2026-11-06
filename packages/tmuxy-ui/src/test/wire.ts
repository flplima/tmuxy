/**
 * Test helpers for branded ids and wire payloads.
 *
 * Tests write ids and wire objects as plain literals and pass them through
 * the real schemas, exactly as a payload enters the client — so a fixture
 * that would not decode fails here instead of slipping past the boundary.
 */

import { Schema } from 'effect';
import { GroupId, PaneId, WindowId } from '../domain/ids';
import {
  ServerDelta,
  ServerState,
  StateUpdate,
  type ServerStateEncoded,
  type WirePaneEncoded,
  type WireWindowEncoded,
} from '../domain/wire';

/** A pane id literal (`%N`). */
export const pid = (id: string): PaneId => PaneId.make(id);
/** A window id literal (`@N`). */
export const wid = (id: string): WindowId => WindowId.make(id);
/** A group id literal (`gN`). */
export const gid = (id: string): GroupId => GroupId.make(id);

export const wireState = Schema.decodeSync(ServerState);
export const wireDelta = Schema.decodeSync(ServerDelta);
/** A `state-update` payload: a literal or a fixture read from disk. */
export const wireUpdate = Schema.decodeUnknownSync(StateUpdate);

/** A pane as the server sends it: `%0`, 80×24, active, in window `@0`. */
export const wirePane = (over: Partial<WirePaneEncoded> = {}): WirePaneEncoded => ({
  id: 0,
  tmux_id: pid('%0'),
  window_id: wid('@0'),
  content: [],
  cursor_x: 0,
  cursor_y: 0,
  width: 80,
  height: 24,
  x: 0,
  y: 0,
  active: true,
  command: 'bash',
  title: '',
  border_title: '',
  in_mode: false,
  copy_cursor_x: 0,
  copy_cursor_y: 0,
  alternate_on: false,
  mouse_any_flag: false,
  history_size: 0,
  selection_present: false,
  selection_start_x: 0,
  selection_start_y: 0,
  cursor_shape: 0,
  cursor_hidden: false,
  ...over,
});

/** A window as the server sends it: tab `@0`, active. */
export const wireWindow = (over: Partial<WireWindowEncoded> = {}): WireWindowEncoded => ({
  id: wid('@0'),
  index: 0,
  name: 'main',
  active: true,
  window_type: 'tab',
  ...over,
});

/** Session `tmuxy` as the server sends it, one `wirePane` in one `wireWindow`, decoded. */
export const wireSession = (over: Partial<ServerStateEncoded> = {}): ServerState =>
  wireState({
    session_name: 'tmuxy',
    active_window_id: wid('@0'),
    active_pane_id: pid('%0'),
    panes: [wirePane()],
    windows: [wireWindow()],
    total_width: 80,
    total_height: 24,
    ...over,
  });
