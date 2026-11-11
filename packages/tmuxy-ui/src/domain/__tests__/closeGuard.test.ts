import { describe, it, expect } from 'vitest';
import { busyPanesClosedBy, stillPending } from '../closeGuard';
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
  focusPaneId: PaneId.make('%2'),
  activeWindowId: WindowId.make('@1'),
  typed: true,
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
    const idle = { ...model, focusPaneId: PaneId.make('%1') };
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

  const raw = (command: string) => busyPanesClosedBy(TmuxOp.RawCommand({ command }), model);
  const ids = (command: string) => raw(command)?.busy.map((p) => p.paneId) ?? null;

  it('a kill the parser leaves as a string is read as far as tmux syntax is', () => {
    // Every other pane of the focused pane's tab, and every other tab.
    const fromShell = { ...model, focusPaneId: PaneId.make('%1') };
    expect(
      busyPanesClosedBy(TmuxOp.RawCommand({ command: 'kill-pane -a' }), fromShell)?.busy,
    ).toEqual([{ paneId: '%2', command: 'claude', state: 'working' }]);
    expect(ids('kill-pane -a')).toBeNull();
    expect(ids('kill-window -a')).toEqual(['%3', '%4']);
    expect(ids('kill-window -a -t @2')).toEqual(['%2']);
    // A respawn ends the program only with -k.
    expect(ids('respawn-pane -k')).toEqual(['%2']);
    expect(ids('respawn-pane')).toBeNull();
    expect(ids('respawn-window -k -t @2')).toEqual(['%3', '%4']);
    // The session, and a target the client cannot resolve: any pane may go.
    expect(ids('kill-server')).toEqual(['%2', '%3', '%4']);
    const killSession = TmuxOp.KillSession({ name: null });
    expect(busyPanesClosedBy(killSession, model)?.busy).toHaveLength(3);
    // The menu's Kill Session has its own question.
    expect(busyPanesClosedBy(killSession, { ...model, typed: false })).toBeNull();
    expect(ids('kill-window -t :2')).toEqual(['%2', '%3', '%4']);
    expect(raw('kill-pane -t :.1')?.scope).toBe('several');
  });

  it('each command of a list is read, pinned or not', () => {
    expect(ids('kill-pane \\; select-layout tiled')).toEqual(['%2']);
    expect(ids('select-layout tiled ; kill-pane -t %4')).toEqual(['%4']);
    expect(ids('select-layout tiled ; display-message hi')).toBeNull();
  });
});

describe('stillPending', () => {
  const pending = {
    op: TmuxOp.KillWindow({ windowId: WindowId.make('@2') }),
    wire: undefined,
    scope: 'tab' as const,
    busy: [
      { paneId: PaneId.make('%3'), command: 'codex', state: 'needs-input' as const },
      { paneId: PaneId.make('%4'), command: 'make', state: 'working' as const },
    ],
  };

  it('keeps the question while what it names is busy', () => {
    expect(stillPending(pending, model.panes)).toBe(pending);
  });

  it('stops naming a pane that finished or exited, and goes once none is left', () => {
    const finished = model.panes.map((p) => (p.tmuxId === '%4' ? { ...p, paneState: null } : p));
    expect(stillPending(pending, finished)?.busy.map((p) => p.paneId)).toEqual(['%3']);
    expect(stillPending(pending, model.panes.slice(0, 2))).toBeNull();
    expect(stillPending(null, model.panes)).toBeNull();
  });
});
