/**
 * A pane group follows its members: when one of them goes away in a model
 * update, the group is rebuilt from what is left — and a group of one is no
 * group. The two shapes a member can vanish in are both structural changes
 * (`structurallyChanged` in the TMUX_MODEL_UPDATE handler): the pane count
 * drops, or another pane arrives in the same update and the newcomer has no
 * previous self to compare with. Either way `buildGroupsFromPanes` runs again.
 *
 * `appMachine` is exported with stub actors, so it starts standalone — no
 * adapter, no tmux.
 */

import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { appMachine } from '../appMachine';
import { gid, pid, wid } from '../../../test/wire';
import type { TmuxPane, TmuxWindow } from '../../../domain/client';
import type { TmuxClientModel, TmuxSnapshot } from '../../../domain/store/types';
import type { GroupId, PaneId, WindowId } from '../../../domain/ids';

const TAB = wid('@0');
/** The stash session's window a parked member sits in: never in the tab list. */
const STASH = wid('@9');

const pane = (
  tmuxId: PaneId,
  windowId: WindowId,
  group?: { id: GroupId; pos: number },
): TmuxPane => ({
  id: Number(tmuxId.slice(1)),
  tmuxId,
  windowId,
  content: [],
  cursorX: 0,
  cursorY: 0,
  width: 80,
  height: 23,
  x: 0,
  y: 1,
  active: tmuxId === pid('%0'),
  command: 'bash',
  title: '',
  borderTitle: '',
  groupId: group?.id ?? null,
  groupPos: group?.pos ?? null,
  inMode: false,
  copyCursorX: 0,
  copyCursorY: 0,
  alternateOn: false,
  mouseAnyFlag: false,
  paused: false,
  historySize: 0,
  selectionPresent: false,
  selectionStartX: 0,
  selectionStartY: 0,
  cursorShape: 0,
  cursorHidden: false,
});

const WINDOWS: TmuxWindow[] = [
  {
    id: TAB,
    index: 0,
    name: 'main',
    active: true,
    windowType: 'tab',
    floatParent: null,
    floatWidth: null,
    floatHeight: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
  },
];

/** A model update carrying `panes`, with nothing optimistic in flight. */
const modelUpdate = (panes: TmuxPane[]) => {
  const snapshot: TmuxSnapshot = {
    panes,
    windows: WINDOWS,
    activePaneId: pid('%0'),
    activeWindowId: TAB,
    totalWidth: 80,
    totalHeight: 24,
    sessionName: 'main',
    focusRequest: '',
  };
  const model: TmuxClientModel = {
    committed: snapshot,
    ops: [],
    derived: snapshot,
    paneKeyOverrides: {},
    viewFocus: null,
  };
  return { type: 'TMUX_MODEL_UPDATE' as const, model };
};

const g1 = gid('g1');
/** A tab with an ungrouped pane and a two-member group, one member parked. */
const grouped = [
  pane(pid('%0'), TAB),
  pane(pid('%1'), TAB, { id: g1, pos: 0 }),
  pane(pid('%2'), STASH, { id: g1, pos: 1 }),
];

/** A connected machine showing `grouped`. */
const connectedWith = (panes: TmuxPane[]) => {
  const actor = createActor(appMachine).start();
  actor.send({ type: 'TMUX_CONNECTED' });
  actor.send(modelUpdate(panes));
  return actor;
};

describe('pane groups follow the model update', () => {
  it('builds the group from the members the update carries', () => {
    const actor = connectedWith(grouped);
    expect(actor.getSnapshot().context.paneGroups[g1]?.paneIds).toEqual([pid('%1'), pid('%2')]);
  });

  it('drops a group whose parked member was killed', () => {
    const actor = connectedWith(grouped);
    actor.send(modelUpdate(grouped.filter((p) => p.tmuxId !== pid('%2'))));
    expect(actor.getSnapshot().context.paneGroups).toEqual({});
  });

  it('drops it even when another pane arrives in the same update', () => {
    // The pane count is unchanged, so only the newcomer (which has no previous
    // self) marks the update as structural — and that is enough.
    const actor = connectedWith(grouped);
    actor.send(
      modelUpdate([...grouped.filter((p) => p.tmuxId !== pid('%2')), pane(pid('%3'), TAB)]),
    );
    expect(actor.getSnapshot().context.paneGroups).toEqual({});
  });
});
