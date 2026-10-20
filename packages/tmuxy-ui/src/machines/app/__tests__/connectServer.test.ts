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
});
