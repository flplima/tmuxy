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
 * where the rest of the session's commands are.
 */

import type React from 'react';
import { FloatingMenu, MenuItem, MenuDivider, MenuHeader } from './floating/Menu';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  useReadOnly,
  selectSessions,
} from '../machines/AppContext';
import { isTauri } from '../tmux/adapters';

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
  const send = useAppSend();
  const readOnly = useReadOnly();
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const sessions = useAppSelectorShallow(selectSessions);
  const servers = useAppSelectorShallow((ctx) => ctx.servers);
  const currentServerId = useAppSelector((ctx) => ctx.currentServerId);
  const restorable = useAppSelectorShallow((ctx) => ctx.restorableSessions);

  // Before the poll has answered — and on a sandbox that enumerates nothing —
  // the attached session is still the one we know for certain.
  const names = sessions.length > 0 ? sessions.map((s) => s.sessionName) : [sessionName];

  const switchTo = (name: string) => {
    if (name !== sessionName) send({ type: 'SWITCH_SESSION', sessionName: name });
    onClose();
  };

  // A session that is not running but has a snapshot is offered beside the
  // ones that are: choosing it rebuilds the session and then switches to it.
  // Dimmed, like Zellij's session manager draws an exited session, because
  // it is a thing that COULD exist rather than one that does. A viewer gets
  // no such item — a rebuild is a write.
  const exited = readOnly
    ? []
    : restorable.filter((r) => !names.includes(r.name)).map((r) => r.name);
  const restore = (name: string) => {
    send({ type: 'RESTORE_SESSION', sessionName: name });
    onClose();
  };

  const connectTo = (serverId: string) => {
    if (serverId !== currentServerId) send({ type: 'CONNECT_SERVER', serverId });
    onClose();
  };

  const openConnect = () => {
    send({ type: 'OPEN_CONNECT_FLOAT' });
    onClose();
  };

  // A desktop list always holds at least localhost, so "more than one" is
  // what makes the section worth drawing; a web client's list is empty.
  const showServers = isTauri() && servers.length > 1;

  return (
    <FloatingMenu
      id="session-menu"
      label="Sessions"
      anchor={{ kind: 'element', element: anchorRef.current }}
      onClose={onClose}
      ignoreRef={anchorRef}
    >
      <MenuHeader>Sessions</MenuHeader>
      {names.map((name) => {
        const current = name === sessionName;
        return (
          <MenuItem
            key={name}
            onClick={() => switchTo(name)}
            // Switching is a `switch-client`: a change to this client alone,
            // which is why a viewer may do it as freely as a writer.
            data-session-name={name}
            data-current={current || undefined}
          >
            {/* The same filled/hollow mark the theme items use, so "which one
                am I on" reads the same everywhere in the menus. */}
            {current ? '● ' : '○ '}
            {name}
          </MenuItem>
        );
      })}
      {exited.map((name) => (
        <MenuItem
          key={`restore-${name}`}
          className="is-restorable"
          onClick={() => restore(name)}
          data-restore-session={name}
        >
          {'◌ '}
          {name}
        </MenuItem>
      ))}
      {showServers && (
        <>
          <MenuDivider />
          <MenuHeader>Servers</MenuHeader>
          {servers.map((server) => (
            <MenuItem
              key={server.id}
              onClick={() => connectTo(server.id)}
              data-server-id={server.id}
            >
              {server.id === currentServerId ? '\u25CF ' : '\u25CB '}
              {server.label}
            </MenuItem>
          ))}
        </>
      )}
      {/* Reaching a new machine is the desktop app's: the backend retargets
          its monitor at the new socket, which a web client — served by a
          server pinned to one socket at launch — has no way to do. */}
      {isTauri() && !readOnly && (
        <>
          <MenuDivider />
          <MenuItem onClick={openConnect} data-testid="session-menu-connect">
            Connect over SSH…
          </MenuItem>
        </>
      )}
    </FloatingMenu>
  );
}
