/**
 * A closed sidebar peeks: shown over the panes while the mouse rests on its
 * toggle, then gone. The peek is this client's alone. It never unhides the
 * column's window (another client would see it open), never re-tiles the
 * grid, and never docks the column, even when a click inside it takes the
 * keyboard. Only the toggle's click docks it.
 */
import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../../test/wire';
import { modelPane, modelUpdate as update, modelWindow } from '../../../../test/model';
import { recorder, startApp } from '../../../../test/app';
import type { TmuxOp } from '../../../../domain/commands';
import type { TmuxPane, TmuxWindow } from '../../../../domain/client';
import type { PaneId, WindowId } from '../../../../domain/ids';

const TAB = wid('@0');
const TREE = wid('@1');

const pane = (tmuxId: PaneId, windowId: WindowId): TmuxPane =>
  modelPane(tmuxId, windowId, { height: 23, y: 1, active: tmuxId === pid('%0') });

const window = (
  id: WindowId,
  windowType: 'tab' | 'sidebar-left',
  sidebarHidden = false,
): TmuxWindow =>
  modelWindow(id, Number(id.slice(1)), {
    name: windowType,
    active: id === TAB,
    windowType,
    sidebarHidden,
  });

const modelUpdate = (panes: TmuxPane[], windows: TmuxWindow[]) =>
  update(panes, windows, { paneId: pid('%0'), windowId: TAB });

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

/** The app machine over a tmux actor that records the ops it is sent from `first` on. */
function connected(first: ReturnType<typeof modelUpdate>) {
  const tmux = recorder();
  const actor = startApp({ actors: { tmuxActor: tmux.logic } });
  actor.send(first);
  tmux.received.length = 0;
  return { actor, sent: tmux.ops, ctx: () => actor.getSnapshot().context };
}

describe('a sidebar peek', () => {
  it('shows a hidden column without unhiding it, takes the keyboard without docking, and gives it back', () => {
    const { actor, sent, ctx } = connected(hiddenTree);
    expect(ctx().sidebars.left.open).toBe(false);

    actor.send({ type: 'PEEK_SIDEBAR', side: 'left' });
    expect(ctx().sidebarPeek).toBe('left');
    expect(ctx().sidebars.left.open).toBe(false);
    expect(sent()).toEqual([]);

    // A click in the column: the keyboard goes to the tree, the column stays a peek.
    actor.send({ type: 'FOCUS_SIDEBAR', side: 'left' });
    expect(ctx().keyboardOwner.kind === 'left').toBe(true);
    expect(ctx().sidebars.left.open).toBe(false);

    actor.send({ type: 'END_SIDEBAR_PEEK' });
    expect(ctx().sidebarPeek).toBeNull();
    expect(ctx().keyboardOwner.kind === 'left').toBe(false);
    expect(ctx().sidebars.left.open).toBe(false);
    expect(
      sent()
        .map(hiddenTag)
        .filter((v) => v !== undefined),
    ).toEqual([]);
  });

  it('starts a column that was never made, and the window it gets arrives hidden', () => {
    const { actor, sent, ctx } = connected(noTree);

    actor.send({ type: 'PEEK_SIDEBAR', side: 'left' });
    expect(sent().filter((op) => op._tag === 'OpenSidebar')).toHaveLength(1);
    expect(ctx().sidebars.left.starting).toBe(true);

    actor.send(freshTree);
    expect(ctx().sidebars.left.open).toBe(false);
    expect(ctx().sidebarPeek).toBe('left');
    expect(sent().map(hiddenTag)).toContain('1');

    // A second peek of it starts nothing more.
    actor.send({ type: 'END_SIDEBAR_PEEK' });
    actor.send(hiddenTree);
    actor.send({ type: 'PEEK_SIDEBAR', side: 'left' });
    expect(sent().filter((op) => op._tag === 'OpenSidebar')).toHaveLength(1);
  });

  it('is docked by the toggle: the column opens, unhidden, and the peek is over', () => {
    const { actor, sent, ctx } = connected(hiddenTree);
    actor.send({ type: 'PEEK_SIDEBAR', side: 'left' });

    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    expect(ctx().sidebars.left.open).toBe(true);
    expect(ctx().sidebarPeek).toBeNull();
    expect(sent().map(hiddenTag)).toContain(null);

    // The pointer leaving the toggle afterwards closes nothing.
    actor.send({ type: 'END_SIDEBAR_PEEK' });
    expect(ctx().sidebars.left.open).toBe(true);
  });

  it('is not for a column already docked', () => {
    const { actor, ctx } = connected(hiddenTree);
    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    actor.send({ type: 'PEEK_SIDEBAR', side: 'left' });
    expect(ctx().sidebarPeek).toBeNull();
  });
});
