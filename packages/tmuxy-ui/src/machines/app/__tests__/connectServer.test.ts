/**
 * The host label after switching servers.
 *
 * The bug this pins: choosing another server in the session menu connected to
 * it, but the status line kept naming the old one. The saved-server list, and
 * with it `currentServerId`, is only re-read while the sidebar or the session
 * menu is open, so nothing updated the label once the menu had closed.
 */

import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { appMachine } from '../appMachine';
import type { TmuxServer } from '../../types/domain';
import { serverHostLabel } from '../../../components/paneTabDisplay';

const servers: TmuxServer[] = [
  { id: 'localhost', label: 'localhost', kind: 'local', socket: 'tmuxy' },
  {
    id: 'ssh-workstation-tmuxy',
    label: 'workstation',
    kind: 'ssh',
    ssh: { host: 'gaphs04' },
    socket: 'tmuxy',
  },
];

describe('connecting to a server', () => {
  it('names the chosen server in the host label straight away', () => {
    const actor = createActor(appMachine).start();
    actor.send({ type: 'SERVERS_UPDATED', servers, currentServerId: 'localhost' });
    expect(serverHostLabel(servers, actor.getSnapshot().context.currentServerId)).toBe('localhost');

    actor.send({ type: 'CONNECT_SERVER', serverId: 'ssh-workstation-tmuxy' });

    const { currentServerId } = actor.getSnapshot().context;
    expect(currentServerId).toBe('ssh-workstation-tmuxy');
    expect(serverHostLabel(servers, currentServerId)).toBe('gaphs04');
  });

  // The web client cannot read the machine's name itself: `location.hostname`
  // is the address it was opened at (`localhost`, an IP). The server says it
  // in its greeting, and the label uses it for a local server.
  it('names the machine the server greeted from, not localhost', () => {
    const actor = createActor(appMachine).start();
    actor.send({ type: 'CONNECTION_INFO', defaultShell: 'zsh', hostname: 'ab350m' });
    const { serverHostname, currentServerId } = actor.getSnapshot().context;
    expect(serverHostname).toBe('ab350m');
    expect(serverHostLabel([], currentServerId, false, serverHostname)).toBe('ab350m');
    // An SSH server's host wins over the local machine's name.
    expect(serverHostLabel(servers, 'ssh-workstation-tmuxy', false, serverHostname)).toBe(
      'gaphs04',
    );
    // Until the greeting arrives, the stand-in.
    expect(serverHostLabel([], null, false, null)).toBe('localhost');
  });
});
