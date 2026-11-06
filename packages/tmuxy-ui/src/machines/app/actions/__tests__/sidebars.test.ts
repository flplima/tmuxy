/**
 * A sidebar's start timeout belongs to the open that raised it. An open whose
 * pane landed and then died (the widget crashed) followed by a quick reopen
 * used to leave the first open's timer running: it fired into the second
 * open, cleared `Starting` early, and a further toggle asked tmux for one
 * more hidden window that lived on for good.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SIDEBAR_START_TIMEOUT_MS } from '../sidebars';
import { pid, wid } from '../../../../test/wire';
import { modelPane, modelUpdate as update, modelWindow } from '../../../../test/model';
import { recorder, startApp } from '../../../../test/app';
import type { TmuxPane, TmuxWindow } from '../../../../domain/client';
import type { PaneId, WindowId } from '../../../../domain/ids';

const TAB = wid('@0');
const TREE = wid('@1');

const pane = (tmuxId: PaneId, windowId: WindowId): TmuxPane =>
  modelPane(tmuxId, windowId, { height: 23, y: 1, active: tmuxId === pid('%0') });

const window = (id: WindowId, windowType: 'tab' | 'sidebar-left'): TmuxWindow =>
  modelWindow(id, Number(id.slice(1)), { name: windowType, active: id === TAB, windowType });

const modelUpdate = (panes: TmuxPane[], windows: TmuxWindow[]) =>
  update(panes, windows, { paneId: pid('%0'), windowId: TAB });

const noTree = modelUpdate([pane(pid('%0'), TAB)], [window(TAB, 'tab')]);
const withTree = modelUpdate(
  [pane(pid('%0'), TAB), pane(pid('%1'), TREE)],
  [window(TAB, 'tab'), window(TREE, 'sidebar-left')],
);

/** The app machine over a tmux actor that records the ops it is sent. */
function connected() {
  const tmux = recorder();
  const actor = startApp({ actors: { tmuxActor: tmux.logic } });
  actor.send(noTree);
  return {
    actor,
    opens: () => tmux.ops().filter((op) => op._tag === 'OpenSidebar').length,
  };
}

describe('the sidebar start timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the latest open’s: an earlier open’s timer never judges a later one', () => {
    vi.useFakeTimers();
    const { actor, opens } = connected();
    const ctx = () => actor.getSnapshot().context;

    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    expect(opens()).toBe(1);
    expect(ctx().sidebars.left.starting).toBe(true);

    // The pane lands, then its widget dies.
    vi.advanceTimersByTime(500);
    actor.send(withTree);
    expect(ctx().sidebars.left.starting).toBe(false);
    expect(ctx().sidebars.left.open).toBe(true);
    vi.advanceTimersByTime(100);
    actor.send(noTree);
    expect(ctx().sidebars.left.open).toBe(false);

    // A reopen shortly before the first open's timer would have fired.
    vi.advanceTimersByTime(SIDEBAR_START_TIMEOUT_MS - 1000);
    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    expect(opens()).toBe(2);
    expect(ctx().sidebars.left.starting).toBe(true);

    // Past the first open's deadline, well before the second's.
    vi.advanceTimersByTime(1500);
    expect(ctx().sidebars.left.starting).toBe(true);
    expect(ctx().sidebars.left.startFailed).toBe(false);

    // With `Starting` intact a close and reopen ride the pending request.
    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    expect(opens()).toBe(2);

    // The second open's own deadline still judges it.
    vi.advanceTimersByTime(SIDEBAR_START_TIMEOUT_MS);
    expect(ctx().sidebars.left.starting).toBe(false);
    expect(ctx().sidebars.left.startFailed).toBe(true);
  });

  it('is cancelled when the pane lands, so it cannot mark a landed start failed', () => {
    vi.useFakeTimers();
    const { actor } = connected();
    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    actor.send(withTree);
    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    actor.send(noTree);
    // Closed by the user (not a failed start), then the column vanished.
    vi.advanceTimersByTime(SIDEBAR_START_TIMEOUT_MS + 1);
    expect(actor.getSnapshot().context.sidebars.left.startFailed).toBe(false);
  });
});
