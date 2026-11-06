/**
 * A sidebar's start timeout belongs to the open that raised it. An open whose
 * pane landed and then died (the widget crashed) followed by a quick reopen
 * used to leave the first open's timer running: it fired into the second
 * open, cleared `Starting` early, and a further toggle asked tmux for one
 * more hidden window that lived on for good.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor, fromCallback } from 'xstate';
import { appMachine } from '../../appMachine';
import { SIDEBAR_START_TIMEOUT_MS } from '../sidebars';
import { pid, wid } from '../../../../test/wire';
import type { TmuxOp } from '../../../../domain/commands';
import type { TmuxPane, TmuxWindow } from '../../../../domain/client';
import type { TmuxClientModel, TmuxSnapshot } from '../../../../domain/store/types';
import type { PaneId, WindowId } from '../../../../domain/ids';

const TAB = wid('@0');
const TREE = wid('@1');

const pane = (tmuxId: PaneId, windowId: WindowId): TmuxPane => ({
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
  inMode: false,
  copyCursorX: 0,
  copyCursorY: 0,
  alternateOn: false,
  mouseAnyFlag: false,
  historySize: 0,
  selectionPresent: false,
  selectionStartX: 0,
  selectionStartY: 0,
  cursorShape: 0,
  cursorHidden: false,
});

const window = (id: WindowId, windowType: 'tab' | 'sidebar-left'): TmuxWindow => ({
  id,
  index: Number(id.slice(1)),
  name: windowType,
  active: id === TAB,
  windowType,
  floatParent: null,
  floatWidth: null,
  floatHeight: null,
  floatDrawer: null,
  floatBg: null,
  floatNoheader: false,
});

const modelUpdate = (panes: TmuxPane[], windows: TmuxWindow[]) => {
  const snapshot: TmuxSnapshot = {
    panes,
    windows,
    activePaneId: pid('%0'),
    activeWindowId: TAB,
    totalWidth: 80,
    totalHeight: 24,
    sessionName: 'main',
    focusRequest: '',
    pluginsRev: '',
    themeRev: '',
  };
  const model: TmuxClientModel = {
    committed: snapshot,
    ops: [],
    derived: snapshot,
    paneKeyOverrides: {},
  };
  return { type: 'TMUX_MODEL_UPDATE' as const, model };
};

const noTree = modelUpdate([pane(pid('%0'), TAB)], [window(TAB, 'tab')]);
const withTree = modelUpdate(
  [pane(pid('%0'), TAB), pane(pid('%1'), TREE)],
  [window(TAB, 'tab'), window(TREE, 'sidebar-left')],
);

/** The app machine over a tmux actor that records the ops it is sent. */
function connected() {
  const sent: TmuxOp[] = [];
  const tmuxActor = fromCallback(({ receive }) => {
    receive((event) => {
      const e = event as unknown as { type: string; op?: TmuxOp };
      if (e.type === 'SEND_OP' && e.op) sent.push(e.op);
    });
  });
  const actor = createActor(appMachine.provide({ actors: { tmuxActor } } as never)).start();
  actor.send({ type: 'TMUX_CONNECTED' });
  actor.send(noTree);
  return { actor, sent, opens: () => sent.filter((op) => op._tag === 'OpenSidebar').length };
}

describe('the sidebar start timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the latest open’s: an earlier open’s timer never judges a later one', () => {
    vi.useFakeTimers();
    const { actor, opens } = connected();
    const ctx = () => actor.getSnapshot().context;

    actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    expect(opens()).toBe(1);
    expect(ctx().leftSidebarStarting).toBe(true);

    // The pane lands, then its widget dies.
    vi.advanceTimersByTime(500);
    actor.send(withTree);
    expect(ctx().leftSidebarStarting).toBe(false);
    expect(ctx().leftSidebarOpen).toBe(true);
    vi.advanceTimersByTime(100);
    actor.send(noTree);
    expect(ctx().leftSidebarOpen).toBe(false);

    // A reopen shortly before the first open's timer would have fired.
    vi.advanceTimersByTime(SIDEBAR_START_TIMEOUT_MS - 1000);
    actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    expect(opens()).toBe(2);
    expect(ctx().leftSidebarStarting).toBe(true);

    // Past the first open's deadline, well before the second's.
    vi.advanceTimersByTime(1500);
    expect(ctx().leftSidebarStarting).toBe(true);
    expect(ctx().leftSidebarStartFailed).toBe(false);

    // With `Starting` intact a close and reopen ride the pending request.
    actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    expect(opens()).toBe(2);

    // The second open's own deadline still judges it.
    vi.advanceTimersByTime(SIDEBAR_START_TIMEOUT_MS);
    expect(ctx().leftSidebarStarting).toBe(false);
    expect(ctx().leftSidebarStartFailed).toBe(true);
  });

  it('is cancelled when the pane lands, so it cannot mark a landed start failed', () => {
    vi.useFakeTimers();
    const { actor } = connected();
    actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    actor.send(withTree);
    actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    actor.send(noTree);
    // Closed by the user (not a failed start), then the column vanished.
    vi.advanceTimersByTime(SIDEBAR_START_TIMEOUT_MS + 1);
    expect(actor.getSnapshot().context.leftSidebarStartFailed).toBe(false);
  });
});
