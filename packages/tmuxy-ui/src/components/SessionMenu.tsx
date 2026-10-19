/**
 * SessionMenu — the session switcher: a dropdown, not a surface.
 *
 * Switching session is a one-line question ("which of these?"), and it used to
 * be answered by a float running a whole widget in a real tmux pane — a window
 * to create, a pane to spawn, a keyboard cursor of its own, and the tab behind
 * it dimmed while you read four names. A menu anchored to the thing you
 * clicked says the same thing without taking the screen.
 *
 * What it lists is the sessions on the socket this client is attached to
 * (`serversActor` polls them), which is the set `switch-client` can reach —
 * instant, and as available to a viewer as to a writer, since it changes only
 * this client.
 *
 * Servers are a second section, and only when there is more than one to
 * choose: attaching to another socket is not a `switch-client` but a
 * retarget of the backend's monitor (`connect_server`), which is a Tauri
 * command — a web client is served by a server pinned to one socket at
 * launch, so its list holds nothing to offer. Adding a server is a FORM, and
 * a form needs somewhere to type, so that one item opens a pane.
 *
 * The other session verbs (new, rename, detach, kill) live in the app menu,
 * where the rest of the session's commands are. The list itself is the
 * `sessionSwitcherSpec` (domain/menus).
 */

import type React from 'react';
import { FloatingMenu } from './floating/Menu';
import { useAppSelector } from '../machines/appHooks';
import { sessionSwitcherSpec } from '../domain/menus/sessionSwitcher';
import { renderSpec, useMenuDispatch } from './menus/SpecMenu';
import { useMenuEnv } from './menus/menuEnv';
import { belowElement, useNativeMenu } from './menus/useNativeMenu';

interface SessionMenuProps {
  /**
   * The control the menu hangs from. An element rather than a point, because
   * the surface measures both to keep the menu on screen — and which SIDE it
   * opens on follows from that: the status line's switcher is a 27px strip on
   * the last row of the window, so its menu is placed above rather than off
   * the bottom of the screen (`positionSurface`).
   */
  // `useRef<T>(null)` yields `RefObject<T | null>`; the menu reads `.current`
  // only once it is open, by which point React has attached the element.
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

export function SessionMenu({ anchorRef, onClose }: SessionMenuProps) {
  const env = useMenuEnv();
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const currentServerId = useAppSelector((ctx) => ctx.currentServerId);
  const spec = useAppSelector((ctx) => sessionSwitcherSpec(ctx, env));
  const dispatch = useMenuDispatch();

  const choose = (action: Parameters<typeof dispatch>[0]) => {
    // Picking the session or server already attached changes nothing.
    const same =
      action.kind === 'event' &&
      ((action.event.type === 'SWITCH_SESSION' && action.event.sessionName === sessionName) ||
        (action.event.type === 'CONNECT_SERVER' && action.event.serverId === currentServerId));
    if (!same) dispatch(action);
    onClose();
  };
  const inApp = useNativeMenu(spec, choose, belowElement(anchorRef.current), onClose);
  if (!inApp) return null;

  return (
    <FloatingMenu
      id="session-menu"
      label="Sessions"
      anchor={{ kind: 'element', element: anchorRef.current }}
      onClose={onClose}
      ignoreRef={anchorRef}
    >
      {renderSpec(spec, choose)}
    </FloatingMenu>
  );
}
