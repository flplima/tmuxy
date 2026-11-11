import { describe, it, expect } from 'vitest';
import { busyPanesClosedBy } from '../closeGuard';
import { TmuxOp } from '../commands';
import { PaneId, WindowId } from '../ids';

const pane = (id: string, window: string, paneState: string | null, command = 'zsh') => ({
  tmuxId: PaneId.make(id),
  windowId: WindowId.make(window),
  command,
  paneState,
  paneAsk: null,
});

const model = {
  panes: [
    pane('%1', '@1', null),
    pane('%2', '@1', 'working', 'claude'),
    pane('%3', '@2', 'needs-input', 'codex'),
    pane('%4', '@2', 'working', 'make'),
    pane('%5', '@3', 'error', 'make'),
    pane('%6', '@3', 'unread'),
  ],
  activePaneId: PaneId.make('%2'),
  activeWindowId: WindowId.make('@1'),
};

describe('busyPanesClosedBy', () => {
  it('holds the close of a pane that is working or waiting for the user', () => {
    expect(busyPanesClosedBy(TmuxOp.KillPane({ paneId: PaneId.make('%2') }), model)).toEqual({
      scope: 'pane',
      busy: [{ paneId: '%2', command: 'claude', state: 'working' }],
    });
    expect(busyPanesClosedBy(TmuxOp.GroupClose({ paneId: PaneId.make('%3') }), model)).toEqual({
      scope: 'pane',
      busy: [{ paneId: '%3', command: 'codex', state: 'needs-input' }],
    });
  });

  it('lets an idle pane close at once, and one that only failed or has unread output', () => {
    for (const id of ['%1', '%5', '%6']) {
      expect(busyPanesClosedBy(TmuxOp.KillPane({ paneId: PaneId.make(id) }), model)).toBeNull();
    }
  });

  it('a close with no target is the active pane or tab', () => {
    expect(busyPanesClosedBy(TmuxOp.KillPane({ paneId: null }), model)?.busy).toEqual([
      { paneId: '%2', command: 'claude', state: 'working' },
    ]);
    expect(busyPanesClosedBy(TmuxOp.KillWindow({ windowId: null }), model)?.scope).toBe('tab');
    const idle = { ...model, activePaneId: PaneId.make('%1') };
    expect(busyPanesClosedBy(TmuxOp.KillPane({ paneId: null }), idle)).toBeNull();
  });

  it('closing a tab names every busy pane in it, and only those', () => {
    expect(busyPanesClosedBy(TmuxOp.KillWindow({ windowId: WindowId.make('@2') }), model)).toEqual({
      scope: 'tab',
      busy: [
        { paneId: '%3', command: 'codex', state: 'needs-input' },
        { paneId: '%4', command: 'make', state: 'working' },
      ],
    });
    expect(
      busyPanesClosedBy(TmuxOp.KillWindow({ windowId: WindowId.make('@3') }), model),
    ).toBeNull();
  });

  it('an op that closes nothing is never held', () => {
    expect(busyPanesClosedBy(TmuxOp.ZoomToggle({ paneId: PaneId.make('%2') }), model)).toBeNull();
  });
});
