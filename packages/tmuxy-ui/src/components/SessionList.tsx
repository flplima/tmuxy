/**
 * The session switcher's body on the detached overlay. A new session comes
 * first, since the session just left may have been the last one. No
 * "connect" item: connecting to a new server opens a float, which needs an
 * attached session.
 */

import { useMenuDispatch } from './menus/SpecMenu';
import { SessionPicker } from './SessionPicker';

export function SessionList() {
  const dispatch = useMenuDispatch();
  return (
    <SessionPicker withConnect={false} withNewSession onChoose={(item) => dispatch(item.action)} />
  );
}
