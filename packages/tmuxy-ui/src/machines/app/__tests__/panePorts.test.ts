/**
 * The ports the poll reports: taken as the machine's, and the same answer
 * again leaves the list as it was, so the tree is not drawn again every few
 * seconds for nothing.
 */

import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { appMachine } from '../appMachine';

describe('the panes’ listening ports', () => {
  it('are kept, and an unchanged answer keeps the same list', () => {
    const actor = createActor(appMachine).start();
    expect(actor.getSnapshot().context.panePorts).toEqual([]);

    actor.send({
      type: 'PANE_PORTS_UPDATED',
      panePorts: [{ paneId: '%1', ports: [5173, 8123] }],
    });
    const first = actor.getSnapshot().context.panePorts;
    expect(first).toEqual([{ paneId: '%1', ports: [5173, 8123] }]);

    actor.send({
      type: 'PANE_PORTS_UPDATED',
      panePorts: [{ paneId: '%1', ports: [5173, 8123] }],
    });
    expect(actor.getSnapshot().context.panePorts).toBe(first);

    for (const changed of [
      [{ paneId: '%1', ports: [5173] }],
      [{ paneId: '%2', ports: [5173] }],
      [],
    ]) {
      actor.send({ type: 'PANE_PORTS_UPDATED', panePorts: changed });
      expect(actor.getSnapshot().context.panePorts).toEqual(changed);
    }
  });
});
