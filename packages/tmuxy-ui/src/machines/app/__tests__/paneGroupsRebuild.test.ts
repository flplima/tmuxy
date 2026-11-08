/**
 * A pane group follows its members: when one of them goes away in a model
 * update, the group is rebuilt from what is left — and a group of one is no
 * group. A member can vanish in two shapes: the pane count drops, or another
 * pane arrives in the same update. Either way the rebuild drops the group.
 */

import { describe, it, expect } from 'vitest';
import { gid, pid, wid } from '../../../test/wire';
import { modelPane, modelUpdate as update, modelWindow } from '../../../test/model';
import { startApp } from '../../../test/app';
import type { TmuxPane } from '../../../domain/client';
import type { GroupId, PaneId, WindowId } from '../../../domain/ids';

const TAB = wid('@0');
/** The stash session's window a parked member sits in: never in the tab list. */
const STASH = wid('@9');

const pane = (tmuxId: PaneId, windowId: WindowId, group?: { id: GroupId; pos: number }) =>
  modelPane(tmuxId, windowId, {
    height: 23,
    y: 1,
    active: tmuxId === pid('%0'),
    groupId: group?.id ?? null,
    groupPos: group?.pos ?? null,
  });

/** A model update carrying `panes` in the one tab. */
const modelUpdate = (panes: TmuxPane[]) =>
  update(panes, [modelWindow(TAB, 0, { name: 'main', active: true })], {
    paneId: pid('%0'),
    windowId: TAB,
  });

const g1 = gid('g1');
/** A tab with an ungrouped pane and a two-member group, one member parked. */
const grouped = [
  pane(pid('%0'), TAB),
  pane(pid('%1'), TAB, { id: g1, pos: 0 }),
  pane(pid('%2'), STASH, { id: g1, pos: 1 }),
];

/** A connected machine showing `grouped`. */
const connectedWith = (panes: TmuxPane[]) => {
  const actor = startApp();
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
