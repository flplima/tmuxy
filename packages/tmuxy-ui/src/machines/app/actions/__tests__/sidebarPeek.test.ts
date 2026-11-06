/**
 * A closed sidebar peeks: shown over the panes while the mouse rests on its
 * toggle, then gone. The peek is this client's alone. It never unhides the
 * column's window (another client would see it open), never re-tiles the
 * grid, and never docks the column, even when a click inside it takes the
 * keyboard. Only the toggle's click docks it.
 */
import { describe, it, expect } from 'vitest';
import { createActor, fromCallback } from 'xstate';
import { appMachine } from '../../appMachine';
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

const window = (
  id: WindowId,
  windowType: 'tab' | 'sidebar-left',
  sidebarHidden = false,
): TmuxWindow => ({
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
  sidebarHidden,
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
/** The tree's window as tmux makes it: not hidden yet. */
const freshTree = modelUpdate(
  [pane(pid('%0'), TAB), pane(pid('%1'), TREE)],
  [window(TAB, 'tab'), window(TREE, 'sidebar-left')],
);
/** The tree's window once closed: kept, hidden. */
const hiddenTree = modelUpdate(
  [pane(pid('%0'), TAB), pane(pid('%1'), TREE)],
  [window(TAB, 'tab'), window(TREE, 'sidebar-left', true)],
);

const hiddenTag = (op: TmuxOp) =>
  op._tag === 'SetWindowTag' && op.tag === 'sidebar-hidden' ? op.value : undefined;

/** The app machine over a tmux actor that records the ops it is sent. */
function connected(first: ReturnType<typeof modelUpdate>) {
  const sent: TmuxOp[] = [];
  const tmuxActor = fromCallback(({ receive }) => {
    receive((event) => {
      const e = event as unknown as { type: string; op?: TmuxOp };
      if (e.type === 'SEND_OP' && e.op) sent.push(e.op);
    });
  });
  const actor = createActor(appMachine.provide({ actors: { tmuxActor } } as never)).start();
  actor.send({ type: 'TMUX_CONNECTED' });
  actor.send(first);
  sent.length = 0;
  return { actor, sent, ctx: () => actor.getSnapshot().context };
}

describe('a sidebar peek', () => {
  it('shows a hidden column without unhiding it, takes the keyboard without docking, and gives it back', () => {
    const { actor, sent, ctx } = connected(hiddenTree);
    expect(ctx().leftSidebarOpen).toBe(false);

    actor.send({ type: 'PEEK_SIDEBAR', side: 'left' });
    expect(ctx().sidebarPeek).toBe('left');
    expect(ctx().leftSidebarOpen).toBe(false);
    expect(sent).toEqual([]);

    // A click in the column: the keyboard goes to the tree, the column stays a peek.
    actor.send({ type: 'FOCUS_LEFT_SIDEBAR' });
    expect(ctx().leftSidebarFocused).toBe(true);
    expect(ctx().leftSidebarOpen).toBe(false);

    actor.send({ type: 'END_SIDEBAR_PEEK' });
    expect(ctx().sidebarPeek).toBeNull();
    expect(ctx().leftSidebarFocused).toBe(false);
    expect(ctx().leftSidebarOpen).toBe(false);
    expect(sent.map(hiddenTag).filter((v) => v !== undefined)).toEqual([]);
  });

  it('starts a column that was never made, and the window it gets arrives hidden', () => {
    const { actor, sent, ctx } = connected(noTree);

    actor.send({ type: 'PEEK_SIDEBAR', side: 'left' });
    expect(sent.filter((op) => op._tag === 'OpenSidebar')).toHaveLength(1);
    expect(ctx().leftSidebarStarting).toBe(true);

    actor.send(freshTree);
    expect(ctx().leftSidebarOpen).toBe(false);
    expect(ctx().sidebarPeek).toBe('left');
    expect(sent.map(hiddenTag)).toContain('1');

    // A second peek of it starts nothing more.
    actor.send({ type: 'END_SIDEBAR_PEEK' });
    actor.send(hiddenTree);
    actor.send({ type: 'PEEK_SIDEBAR', side: 'left' });
    expect(sent.filter((op) => op._tag === 'OpenSidebar')).toHaveLength(1);
  });

  it('is docked by the toggle: the column opens, unhidden, and the peek is over', () => {
    const { actor, sent, ctx } = connected(hiddenTree);
    actor.send({ type: 'PEEK_SIDEBAR', side: 'left' });

    actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    expect(ctx().leftSidebarOpen).toBe(true);
    expect(ctx().sidebarPeek).toBeNull();
    expect(sent.map(hiddenTag)).toContain(null);

    // The pointer leaving the toggle afterwards closes nothing.
    actor.send({ type: 'END_SIDEBAR_PEEK' });
    expect(ctx().leftSidebarOpen).toBe(true);
  });

  it('is not for a column already docked', () => {
    const { actor, ctx } = connected(hiddenTree);
    actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    actor.send({ type: 'PEEK_SIDEBAR', side: 'left' });
    expect(ctx().sidebarPeek).toBeNull();
  });
});
