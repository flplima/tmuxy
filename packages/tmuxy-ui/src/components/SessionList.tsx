/**
 * SessionList — the way back in once detached: the session switcher's own
 * body (SessionPicker), laid on the overlay rather than hung from a control,
 * since there is no status line to hang it from. Picking a session attaches
 * to it, a restorable one is rebuilt first, and a server is connected to —
 * the switcher's own events, through the menus' dispatch.
 *
 * Connecting to a new server opens a float, which takes an attached session,
 * so that item is the status line's switcher's alone.
 */

import { useMenuDispatch } from './menus/SpecMenu';
import { SessionPicker } from './SessionPicker';

export function SessionList() {
  const dispatch = useMenuDispatch();
  return <SessionPicker withConnect={false} onChoose={(item) => dispatch(item.action)} />;
}
