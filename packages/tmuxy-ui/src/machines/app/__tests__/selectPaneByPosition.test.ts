/**
 * ctrl+alt+N selects the Nth pane of the tab in front, numbered in reading
 * order as the hints show them (`domain/jumpHints.ts`).
 */

import { describe, it, expect } from 'vitest';
import { PaneId, WindowId } from '../../../domain/ids';
import { modelPane, modelWindow } from '../../../test/model';
import { recorder, startApp } from '../../../test/app';

const W1 = WindowId.make('@1');
const W2 = WindowId.make('@2');

function app() {
  const store = recorder();
  const actor = startApp({
    actors: { tmuxStoreActor: store.logic },
    context: {
      // %3 is top-left, %1 top-right, %2 bottom; %9 is in another tab.
      panes: [
        modelPane(PaneId.make('%1'), W1, { x: 41, y: 0, width: 40, height: 12, active: true }),
        modelPane(PaneId.make('%2'), W1, { x: 0, y: 13, width: 81, height: 11 }),
        modelPane(PaneId.make('%3'), W1, { x: 0, y: 0, width: 40, height: 12 }),
        modelPane(PaneId.make('%9'), W2),
      ],
      windows: [modelWindow(W1, 1, { active: true }), modelWindow(W2, 2)],
      activePaneId: PaneId.make('%1'),
      activeWindowId: W1,
    },
  });
  const selected = () =>
    store
      .ops()
      .filter((op) => op._tag === 'SelectPane')
      .map((op) => (op as { paneId: string }).paneId);
  return { actor, selected };
}

describe('SELECT_PANE_BY_POSITION', () => {
  it('selects the Nth pane of the tab in front in reading order', () => {
    const { actor, selected } = app();
    actor.send({ type: 'SELECT_PANE_BY_POSITION', position: 1 });
    actor.send({ type: 'SELECT_PANE_BY_POSITION', position: 3 });
    expect(selected()).toEqual(['%3', '%2']);
  });

  it('a number past the panes there are does nothing', () => {
    const { actor, selected } = app();
    actor.send({ type: 'SELECT_PANE_BY_POSITION', position: 4 });
    expect(selected()).toEqual([]);
  });
});
