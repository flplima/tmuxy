import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { placeholderPaneId, placeholderWindowId } from '../../../domain/ids';
import { spawnKeyboardActor as spawnWith } from './keyboardHarness';
import type { AppMachineContext } from '../../types/context';
import { toTmuxCommand, type TmuxOp } from '../../../domain/commands';

function spawnKeyboardActor(
  activePaneId = pid('%3'),
  copyModeStates: Record<string, unknown> = {},
) {
  return spawnWith(activePaneId, {
    copyModeStates: copyModeStates as AppMachineContext['copyModeStates'],
  });
}

function pressKey(init: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function wireCommand(event: { type: string; [k: string]: unknown }): string | undefined {
  if (event.type === 'SEND_TMUX_COMMAND') return event.command as string;
  if (event.type === 'DISPATCH_OP') return toTmuxCommand(event.op as TmuxOp);
  return undefined;
}

function sendCommands(events: Array<{ type: string; [k: string]: unknown }>): string[] {
  return events.map(wireCommand).filter((command): command is string => command !== undefined);
}

function lastSendCommand(
  events: Array<{ type: string; [k: string]: unknown }>,
): string | undefined {
  const commands = sendCommands(events);
  return commands[commands.length - 1];
}

describe('keyboardActor — Tab / Shift-Tab', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  beforeEach(() => {
    handle = spawnKeyboardActor(pid('%3'));
  });

  it('sends plain Tab as the tmux key "Tab"', () => {
    pressKey({ key: 'Tab' });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 Tab');
  });

  it('sends Shift+Tab as the tmux back-tab key "BTab" (not S-Tab)', () => {
    pressKey({ key: 'Tab', shiftKey: true });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 BTab');
  });

  describe('on a header button', () => {
    let button: HTMLButtonElement;
    beforeEach(() => {
      button = document.createElement('button');
      document.body.appendChild(button);
    });
    afterEach(() => button.remove());

    const pressTabOn = (target: HTMLElement) => {
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };

    it('moves the focus on when the keyboard put it there', () => {
      button.focus();
      const before = handle.events.length;
      const event = pressTabOn(button);
      expect(sendCommands(handle.events.slice(before))).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
    });

    it('is still the shell’s after a click left the focus there', () => {
      window.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
      button.focus();
      window.dispatchEvent(new MouseEvent('pointerup', { button: 0, bubbles: true }));
      pressTabOn(button);
      expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 Tab');
    });
  });
});

function spawnWithLiveContext(initial = pid('%1')) {
  return spawnWith(initial, {
    activeWindowId: wid('@0'),
    panes: [
      { tmuxId: pid('%1'), windowId: wid('@0'), active: true },
      { tmuxId: pid('%2'), windowId: wid('@0'), active: false },
      { tmuxId: pid('%3'), windowId: wid('@1'), active: true },
    ] as AppMachineContext['panes'],
  });
}

describe('keyboardActor — active-pane target uses the live snapshot', () => {
  it('targets the pane the machine has active at the keystroke', () => {
    const { events, set } = spawnWithLiveContext(pid('%1'));
    set({ activePaneId: pid('%2') });
    pressKey({ key: 'a' });
    expect(lastSendCommand(events)).toBe("send-keys -t %2 -l -- 'a'");
  });
});

describe('keyboardActor — bindings are pinned to the window the user sees', () => {
  it('prepends select-window and select-pane to prefix and root bindings', () => {
    const { events, set } = spawnWithLiveContext(pid('%1'));
    set({
      keybindings: {
        prefix_key: 'C-a',
        tables: {},
        prefix_bindings: [{ key: '%', command: 'split-window -h', repeat: false }],
        root_bindings: [{ key: 'C-n', command: 'next-window' }],
      },
    });
    set({ activePaneId: pid('%2') });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });
    expect(lastSendCommand(events)).toBe(
      'select-window -t @0 \\; select-pane -t %2 \\; split-window -h',
    );

    pressKey({ key: 'n', ctrlKey: true });
    expect(lastSendCommand(events)).toBe(
      'select-window -t @0 \\; select-pane -t %2 \\; next-window',
    );
  });

  it("never pins a pane outside the pinned window: the window's own active pane stands in", () => {
    const { events, set } = spawnWithLiveContext(pid('%1'));
    set({
      keybindings: {
        prefix_key: 'C-a',
        tables: {},
        prefix_bindings: [{ key: '%', command: 'split-window -h', repeat: false }],
        root_bindings: [],
      },
    });
    set({ activeWindowId: wid('@1') });
    set({ activePaneId: pid('%2') });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });
    expect(lastSendCommand(events)).toBe(
      'select-window -t @1 \\; select-pane -t %3 \\; split-window -h',
    );

    set({ activeWindowId: wid('@2') });
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });
    expect(lastSendCommand(events)).toBe('select-window -t @2 \\; split-window -h');
  });

  it('leaves a placeholder window and pane unpinned: tmux is already on the window they stand for', () => {
    const { events, set } = spawnWithLiveContext(pid('%1'));
    set({
      keybindings: {
        prefix_key: 'C-a',
        tables: {},
        prefix_bindings: [{ key: '%', command: 'split-window -h', repeat: false }],
        root_bindings: [],
      },
    });
    // Right after a predicted new tab: the client's active window and pane
    // are ids tmux has never heard of. A pin naming either is an error in
    // tmux, and tmux stops the list there — the binding never runs.
    set({ activeWindowId: placeholderWindowId('op1') });
    set({ activePaneId: placeholderPaneId('pane_op1') });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });

    expect(lastSendCommand(events)).toBe('split-window -h');
  });

  it('derives the window from the pinned pane when the machine has none yet', () => {
    const { events, set } = spawnWithLiveContext(pid('%1'));
    set({
      keybindings: {
        prefix_key: 'C-a',
        tables: {},
        prefix_bindings: [{ key: '%', command: 'split-window -h', repeat: false }],
        root_bindings: [],
      },
    });
    set({ activeWindowId: null });
    set({ activePaneId: pid('%3') });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });

    expect(lastSendCommand(events)).toBe(
      'select-window -t @1 \\; select-pane -t %3 \\; split-window -h',
    );
  });
});

describe('keyboardActor — ctrl+digit is the tab strip, not a tmux binding', () => {
  it('sends the strip position for ctrl+1–9 and toggles the overview on ctrl+0', () => {
    const { events, set } = spawnWithLiveContext(pid('%1'));
    set({
      keybindings: {
        prefix_key: 'C-a',
        tables: {},
        prefix_bindings: [],
        root_bindings: [{ key: 'C-2', command: 'select-window -t 2' }],
      },
    });

    const ofType = (type: string) => events.filter((e) => e.type === type);

    pressKey({ key: '2', ctrlKey: true });
    expect(ofType('SELECT_TAB_BY_POSITION')).toEqual([
      { type: 'SELECT_TAB_BY_POSITION', position: 2 },
    ]);
    expect(ofType('SEND_TMUX_COMMAND')).toEqual([]);
    expect(ofType('DISPATCH_OP')).toEqual([]);

    pressKey({ key: '0', ctrlKey: true });
    expect(ofType('TOGGLE_TAB_OVERVIEW')).toHaveLength(1);

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'w' });
    expect(ofType('TOGGLE_TAB_OVERVIEW')).toHaveLength(2);
  });
});

describe('keyboardActor — prefix mode', () => {
  afterEach(() => vi.useRealTimers());

  const lastPrefixActive = (
    events: Array<{ type: string; [k: string]: unknown }>,
  ): boolean | undefined => {
    const actives = events
      .filter((e) => e.type === 'PREFIX_MODE_CHANGE')
      .map((e) => e.active as boolean);
    return actives[actives.length - 1];
  };

  it('auto-exits prefix mode after the timeout', () => {
    vi.useFakeTimers();
    const { events } = spawnKeyboardActor(pid('%3'));
    pressKey({ key: 'a', ctrlKey: true });
    expect(lastPrefixActive(events)).toBe(true);
    vi.advanceTimersByTime(8000);
    expect(lastPrefixActive(events)).toBe(false);
  });

  it('a repeatable binding re-arms only its repeat keys, for repeat-time, and a non-repeat key is typed', () => {
    vi.useFakeTimers();
    const { events, set } = spawnKeyboardActor(pid('%3'));
    set({
      keybindings: {
        prefix_key: 'C-a',
        tables: {},
        prefix_bindings: [
          { key: 'L', command: 'resize-pane -R 5', repeat: true },
          { key: 'c', command: 'new-window', repeat: false },
        ],
        root_bindings: [],
      },
    });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'L', shiftKey: true });
    const resize = 'select-pane -t %3 \\; resize-pane -R 5';
    expect(lastSendCommand(events)).toBe(resize);
    const prefixChanges = events.filter((e) => e.type === 'PREFIX_MODE_CHANGE');
    expect(prefixChanges[prefixChanges.length - 1]).toEqual({
      type: 'PREFIX_MODE_CHANGE',
      active: true,
      repeatOnly: ['L'],
    });

    // Still inside repeat-time: the repeat key runs the binding again...
    vi.advanceTimersByTime(100);
    pressKey({ key: 'L', shiftKey: true });
    expect(sendCommands(events).filter((c) => c === resize)).toHaveLength(2);

    // ...and a non-repeat key falls through to the pane, as tmux types it,
    // instead of running its prefix binding.
    pressKey({ key: 'c' });
    expect(lastSendCommand(events)).toBe("send-keys -t %3 -l -- 'c'");
    expect(sendCommands(events)).not.toContain('new-window');
    expect(lastPrefixActive(events)).toBe(false);

    // Past repeat-time the repeat key itself is typed.
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'L', shiftKey: true });
    vi.advanceTimersByTime(300);
    expect(lastPrefixActive(events)).toBe(false);
    pressKey({ key: 'L', shiftKey: true });
    expect(lastSendCommand(events)).toBe("send-keys -t %3 -l -- 'L'");
  });

  it('double prefix exits prefix mode and sends the literal prefix key', () => {
    const { events } = spawnKeyboardActor(pid('%3'));
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'a', ctrlKey: true });
    expect(lastPrefixActive(events)).toBe(false);
    expect(lastSendCommand(events)).toBe('send-keys -t %3 C-a');
  });
});

describe('keyboardActor — sticky key tables and the sidebar keys', () => {
  const PIN = 'select-window -t @0 \\; select-pane -t %1 \\; ';
  const keybindings = {
    prefix_key: 'C-a',
    prefix_bindings: [{ key: 'p', command: 'switch-client -T pane', description: '' }],
    root_bindings: [],
    tables: {
      pane: [
        { key: 'x', command: 'kill-pane \\; switch-client -T pane', description: '' },
        { key: 'z', command: 'resize-pane -Z', description: '' },
      ],
    },
  };
  const tableChanges = (events: Array<{ type: string; [k: string]: unknown }>) =>
    events.filter((e) => e.type === 'KEY_TABLE_CHANGE').map((e) => e.table);

  it('prefix p enters PANE; a key that re-enters it repeats, and the switch never reaches tmux', () => {
    const { events, set } = spawnWithLiveContext(pid('%1'));
    set({ keybindings });
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'p' });
    expect(tableChanges(events)).toEqual(['pane']);
    expect(sendCommands(events)).toEqual([]);

    pressKey({ key: 'x' });
    pressKey({ key: 'x' });
    expect(sendCommands(events)).toEqual([`${PIN}kill-pane`, `${PIN}kill-pane`]);
    expect(tableChanges(events)).toEqual(['pane']);

    pressKey({ key: 'Escape' });
    expect(tableChanges(events)).toEqual(['pane', null]);
    pressKey({ key: 'x' });
    expect(lastSendCommand(events)).toBe("send-keys -t %1 -l -- 'x'");
  });

  it('a binding that names no table, or a key the table does not bind, leaves it', () => {
    const { events, set } = spawnWithLiveContext(pid('%1'));
    set({ keybindings });
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'p' });
    pressKey({ key: 'z' });
    expect(lastSendCommand(events)).toBe(`${PIN}resize-pane -Z`);
    expect(tableChanges(events)).toEqual(['pane', null]);

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'p' });
    const sent = sendCommands(events).length;
    pressKey({ key: 'q' });
    expect(sendCommands(events)).toHaveLength(sent);
    expect(tableChanges(events)).toEqual(['pane', null, 'pane', null]);
  });

  it('prefix s toggles the left column once, and the next s is typed like any key', () => {
    const { events, set } = spawnWithLiveContext(pid('%1'));
    set({ keybindings });
    const toggles = () => events.filter((e) => e.type === 'TOGGLE_SIDEBAR');

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 's' });
    expect(toggles()).toEqual([{ type: 'TOGGLE_SIDEBAR', side: 'left' }]);

    pressKey({ key: 's' });
    expect(lastSendCommand(events)).toBe("send-keys -t %1 -l -- 's'");
    expect(toggles()).toHaveLength(1);

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 's' });
    expect(toggles()).toHaveLength(2);
    expect(sendCommands(events)).not.toContain('send-keys -t %1 C-a');
  });
});

describe('keyboardActor — copy and paste on ctrl+shift, as in a terminal emulator', () => {
  const execCommand = document.execCommand;
  let copy = vi.fn<typeof document.execCommand>();
  beforeEach(() => {
    copy = vi.fn<typeof document.execCommand>(() => true);
    document.execCommand = copy;
  });
  afterEach(() => {
    document.execCommand = execCommand;
  });

  const ctrlShift = (key: string) => ({
    key,
    code: `Key${key}`,
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });

  it('ctrl+shift+c copies the selection and never reaches the pane as ctrl+c', () => {
    const { events } = spawnKeyboardActor(pid('%3'));

    pressKey(ctrlShift('C'));

    expect(copy).toHaveBeenCalledWith('copy');
    expect(sendCommands(events)).toEqual([]);
  });

  it('ctrl+shift+c copies a select-all in the scroll view and closes it, as cmd+c does', () => {
    const { events } = spawnKeyboardActor(pid('%3'), {
      [pid('%3')]: {
        mode: 'scroll',
        lines: new Map([[0, [{ c: '1' }]]]),
        width: 80,
        cursorRow: 0,
        cursorCol: 0,
        selectionMode: 'line',
        selectionAnchor: { row: 0, col: 0 },
      },
    });

    pressKey(ctrlShift('C'));

    expect(copy).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'COPY_SELECTION')).toHaveLength(1);
    expect(sendCommands(events)).toEqual([]);
  });

  it('ctrl+shift+v is left to the browser, whose paste event types the clipboard', () => {
    const { events } = spawnKeyboardActor(pid('%3'));
    const down = new KeyboardEvent('keydown', ctrlShift('V'));

    window.dispatchEvent(down);

    expect(down.defaultPrevented).toBe(false);
    expect(sendCommands(events)).toEqual([]);
  });
});
