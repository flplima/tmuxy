/**
 * What this client tells the backend its size is, and how often: over a slow
 * link every report is a round trip, and tmux resizes for each one it takes.
 */
import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../test/model';
import { recorder, startApp } from '../../../test/app';

const PANE = pid('%0');
const TAB = wid('@0');

/** The session as tmux has it: one pane, 80x24, the size a smaller client holds it at. */
const heldAt80x24 = (cursorX: number) =>
  modelUpdate(
    [modelPane(PANE, TAB, { active: true, cursorX })],
    [modelWindow(TAB, 0, { active: true })],
    { paneId: PANE, windowId: TAB },
  );

/** A client that measured 120x30, attached to a session drawn at 80x24. */
function largerClient() {
  const tmux = recorder();
  const actor = startApp({
    context: {
      panes: [modelPane(PANE, TAB, { active: true })],
      windows: [modelWindow(TAB, 0, { active: true })],
      activeWindowId: TAB,
      activePaneId: PANE,
      totalWidth: 80,
      totalHeight: 24,
      targetCols: 120,
      targetRows: 30,
      viewportMeasured: true,
    },
    actors: { tmuxActor: tmux.logic },
  });
  const reports = () =>
    tmux.received
      .filter((event) => event.type === 'SET_CLIENT_SIZE')
      .map((event) => [event.cols, event.rows]);
  return { actor, reports };
}

describe('the size a client reports', () => {
  it('is reported once while another client holds the session smaller, whatever is typed', () => {
    const { actor, reports } = largerClient();
    // Five keystrokes' worth of updates: the grid stays 80x24 throughout.
    for (let key = 1; key <= 5; key++) actor.send(heldAt80x24(key));
    expect(reports()).toEqual([[120, 30]]);
  });

  it('is reported again when the client measures another size', () => {
    const { actor, reports } = largerClient();
    actor.send(heldAt80x24(1));
    actor.send({ type: 'SET_TARGET_SIZE', cols: 100, rows: 30 });
    actor.send(heldAt80x24(2));
    expect(reports()).toEqual([
      [120, 30],
      [100, 30],
    ]);
  });

  it('is reported again on a new connection, which has never heard it', () => {
    const { actor, reports } = largerClient();
    actor.send(heldAt80x24(1));
    actor.send({ type: 'SET_TARGET_SIZE', cols: 120, rows: 30, resend: true });
    actor.send(heldAt80x24(2));
    expect(reports()).toEqual([
      [120, 30],
      [120, 30],
    ]);
  });
  // On a lossy link the one report can be the request that is lost. The
  // session then stayed at the other size, letterboxed, until the window was
  // resized or the stream reconnected.
  it('is reported again after a report that never reached the backend', () => {
    const { actor, reports } = largerClient();
    actor.send(heldAt80x24(1));
    actor.send({ type: 'CLIENT_SIZE_UNREPORTED', cols: 120, rows: 30 });
    actor.send(heldAt80x24(2));
    actor.send(heldAt80x24(3));
    expect(reports()).toEqual([
      [120, 30],
      [120, 30],
    ]);
  });

  it('a failed report of an older size does not undo a newer one', () => {
    const { actor, reports } = largerClient();
    actor.send(heldAt80x24(1));
    actor.send({ type: 'SET_TARGET_SIZE', cols: 100, rows: 30 });
    actor.send({ type: 'CLIENT_SIZE_UNREPORTED', cols: 120, rows: 30 });
    actor.send(heldAt80x24(2));
    expect(reports()).toEqual([
      [120, 30],
      [100, 30],
    ]);
  });
});
