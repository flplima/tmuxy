import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor, type AnyActorRef } from 'xstate';
import { createServersActor, nextPollDelay, parseSessions } from '../serversActor';
import { fakeTransport } from '../../../test/transport';
import { createInitialContext } from '../../app/context';
import { selectTreeVisible } from '../../selectors/panesAndSidebars';
import type { AppMachineContext } from '../../types/context';

// Rows are tab-joined, matching the `-F` format the actor sends.
const row = (...fields: string[]) => fields.join('\t');

describe('parseSessions', () => {
  it('groups windows and panes under their sessions, index-ordered', () => {
    const windows = [
      row('work', '@1', '1', 'editor', 'tab'),
      row('work', '@0', '0', 'shell', 'tab'),
      row('logs', '@5', '0', 'tail', 'tab'),
    ].join('\n');
    const panes = [
      row('work', '@0', '%0', 'bash', '1'),
      row('work', '@1', '%1', 'nvim', '1'),
      row('logs', '@5', '%9', 'less', '0'),
    ].join('\n');

    const sessions = parseSessions(windows, panes);
    // Sessions are name-sorted: logs, work.
    expect(sessions.map((s) => s.sessionName)).toEqual(['logs', 'work']);
    const work = sessions.find((s) => s.sessionName === 'work');
    expect(work?.windows.map((w) => w.index)).toEqual([0, 1]); // index-ordered
    expect(work?.panes.map((p) => p.id)).toEqual(['%0', '%1']);
    expect(work?.panes.find((p) => p.id === '%1')?.command).toBe('nvim');
  });

  it('keeps foreign (untagged) windows, drops internal windows and the stash session', () => {
    const windows = [
      row('main', '@0', '0', 'work', ''), // vanilla tmux window — no type
      row('main', '@1', '1', 'float', 'float'),
      row('main', '@4', '4', 'tree', 'sidebar-left'),
      row('main', '@5', '5', 'terminal', 'sidebar-right'),
      row('__tmuxy_stash', '@9', '0', 'grp', ''), // hidden group member's window
    ].join('\n');
    const panes = [
      row('main', '@0', '%0', 'zsh', '1'),
      row('main', '@1', '%1', 'fzf', '1'), // pane in a hidden window → dropped
      row('__tmuxy_stash', '@9', '%9', 'vim', '1'), // stash pane → dropped
    ].join('\n');

    const sessions = parseSessions(windows, panes);
    // The stash session never surfaces as a session at all.
    expect(sessions.map((s) => s.sessionName)).toEqual(['main']);
    const [session] = sessions;
    expect(session.windows.map((w) => w.id)).toEqual(['@0']);
    expect(session.panes.map((p) => p.id)).toEqual(['%0']);
  });

  it('lists a parked group member with the tab its group is shown in, cwd and all', () => {
    const windows = [
      row('main', '@0', '0', 'work', ''),
      row('__tmuxy_stash', '@9', '0', 'grp', ''),
    ].join('\n');
    const panes = [
      row('main', '@0', '%0', 'zsh', '1', '', '/src/app', 'g2'),
      row('__tmuxy_stash', '@9', '%9', 'vim', '1', '', '/src/lib', 'g2'),
      // A parked pane whose group is shown nowhere has no tab to join.
      row('__tmuxy_stash', '@9', '%8', 'top', '0', '', '/tmp', 'g7'),
    ].join('\n');

    const [session] = parseSessions(windows, panes);
    expect(session.panes.map((p) => [p.id, p.windowId, p.cwd, p.active])).toEqual([
      ['%0', '@0', '/src/app', true],
      ['%9', '@0', '/src/lib', false],
    ]);
  });

  it('carries each pane cwd, empty when tmux reports none', () => {
    const [session] = parseSessions(
      row('s', '@0', '0', 'w', 'tab'),
      [
        row('s', '@0', '%0', 'bash', '1', '', '/code/app'),
        row('s', '@0', '%1', 'top', '0', 'a title'),
      ].join('\n'),
    );
    expect(session.panes.find((p) => p.id === '%0')?.cwd).toBe('/code/app');
    expect(session.panes.find((p) => p.id === '%1')?.cwd).toBe('');
  });

  it('is resilient to empty output', () => {
    expect(parseSessions('', '')).toEqual([]);
  });

  it('marks the active pane', () => {
    const [session] = parseSessions(
      row('s', '@0', '0', 'w', 'tab'),
      [row('s', '@0', '%0', 'bash', '0'), row('s', '@0', '%1', 'top', '1')].join('\n'),
    );
    expect(session.panes.find((p) => p.id === '%1')?.active).toBe(true);
    expect(session.panes.find((p) => p.id === '%0')?.active).toBe(false);
  });
});

describe('the poll’s gate and cadence', () => {
  it('reads tmux only with a tree on screen: the column, a peek of it, or the phone’s tree in front', () => {
    const base = createInitialContext();
    const visible = (patch: Partial<AppMachineContext>) => selectTreeVisible({ ...base, ...patch });
    const left = (open: boolean) => ({ ...base.sidebars, left: { ...base.sidebars.left, open } });
    expect(visible({ sidebars: left(true) })).toBe(true);
    expect(visible({ sidebars: left(false) })).toBe(false);
    expect(visible({ sidebars: left(false), sidebarPeek: 'left' })).toBe(true);
    expect(visible({ phoneLayout: true, phoneBottomView: 'tree' })).toBe(true);
    expect(visible({ phoneLayout: true, phoneBottomView: 'dock' })).toBe(false);
    expect(visible({ phoneLayout: true, phoneBottomView: 'menu' })).toBe(false);
    // Held sideways the tree is the left column, unless the menu has its place.
    const sideways = { phoneLayout: true, phoneLandscape: true };
    expect(visible({ ...sideways, phoneBottomView: 'dock' })).toBe(true);
    expect(visible({ ...sideways, phoneBottomView: 'menu' })).toBe(false);
    expect(visible({ phoneLayout: false, phoneBottomView: 'tree', sidebars: left(false) })).toBe(
      false,
    );
  });

  it('looks again soon until a listing comes back, then at the steady cadence', () => {
    expect(nextPollDelay(false)).toBeLessThan(nextPollDelay(true));
    expect(nextPollDelay(false)).toBeLessThanOrEqual(250);
  });
});

describe('the poll', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('asks nothing from a hidden tab, and asks again once the tab is looked at', async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const transport = fakeTransport({ enumeratesSessions: true, answersQueries: true });
    transport.setNextResult({ kind: 'ok', value: '' });
    const parent = { send: () => {} } as unknown as AnyActorRef;
    const treeVisible = { get: () => true, subscribe: () => () => {} };
    const actor = createActor(createServersActor(transport.runtime), {
      input: { parent, treeVisible },
    }).start();

    // A minute in the background, the tree open the whole time.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.invocations).toEqual([]);

    hidden.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(nextPollDelay(false));
    expect(transport.invocations.map((call) => call.cmd)).toContain('query_tmux');
    actor.stop();
  });
});
