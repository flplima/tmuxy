/**
 * The session switcher: the attached socket's sessions, the ones a snapshot
 * could bring back, and on the desktop the known servers and the way to a
 * new one.
 */

import type { AppMachineContext } from '../../machines/types';
import { event, separator, tidy, type MenuEnv, type MenuNode, type MenuSpec } from './spec';

export function sessionSwitcherSpec(ctx: AppMachineContext, env: MenuEnv): MenuSpec {
  const { sessionName, sessions, servers, currentServerId, restorableSessions } = ctx;
  // Before the poll has answered — and on a sandbox that enumerates nothing —
  // the attached session is still the one we know for certain.
  const names = sessions.length > 0 ? sessions.map((s) => s.sessionName) : [sessionName];
  // A session that is not running but has a snapshot is offered beside the
  // ones that are: choosing it rebuilds the session and then switches to it.
  // A viewer gets no such item — a rebuild is a write.
  const exited = env.readOnly
    ? []
    : restorableSessions.filter((r) => !names.includes(r.name)).map((r) => r.name);
  // A desktop list always holds at least localhost, so "more than one" is
  // what makes the section worth drawing; a web client's list is empty.
  const showServers = env.isTauri && servers.length > 1;

  return tidy([
    { kind: 'header', label: 'Sessions' },
    ...names.map((name): MenuNode => {
      const current = name === sessionName;
      return {
        kind: 'item',
        id: `session:${name}`,
        // The same filled/hollow mark the theme items use, so "which one am I
        // on" reads the same everywhere in the menus.
        label: `${current ? '● ' : '○ '}${name}`,
        data: { 'session-name': name, ...(current ? { current: 'true' } : {}) },
        // Switching is a `switch-client`: a change to this client alone,
        // which is why a viewer may do it as freely as a writer.
        action: event({ type: 'SWITCH_SESSION', sessionName: name }),
      };
    }),
    ...exited.map(
      (name): MenuNode => ({
        kind: 'item',
        id: `restore:${name}`,
        label: `◌ ${name}`,
        className: 'is-restorable',
        data: { 'restore-session': name },
        action: event({ type: 'RESTORE_SESSION', sessionName: name }),
      }),
    ),
    showServers && separator,
    showServers && { kind: 'header', label: 'Servers' },
    ...(showServers
      ? servers.map(
          (server): MenuNode => ({
            kind: 'item',
            id: `server:${server.id}`,
            label: `${server.id === currentServerId ? '● ' : '○ '}${server.label}`,
            data: { 'server-id': server.id },
            action: event({ type: 'CONNECT_SERVER', serverId: server.id }),
          }),
        )
      : []),
    // Reaching a new machine is the desktop app's: the backend retargets its
    // monitor at the new socket, which a web client — served by a server
    // pinned to one socket at launch — has no way to do.
    env.isTauri && !env.readOnly && separator,
    env.isTauri &&
      !env.readOnly && {
        kind: 'item',
        id: 'session-connect',
        label: 'Connect over SSH…',
        testId: 'session-menu-connect',
        action: event({ type: 'OPEN_CONNECT_FLOAT' }),
      },
  ]);
}
