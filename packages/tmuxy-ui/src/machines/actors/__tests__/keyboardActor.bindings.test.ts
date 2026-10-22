import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { placeholderPaneId, placeholderWindowId } from '../../../domain/ids';
import { createActor, createMachine, assign, type AnyActorRef } from 'xstate';
import { createKeyboardActor } from '../keyboardActor';
import { toTmuxCommand, type TmuxOp } from '../../../domain/commands';

function spawnKeyboardActor(activePaneId = pid('%3')) {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const keyboardActor = createKeyboardActor();
  const parent = createMachine({
    types: {} as {
      context: { activePaneId: string; copyModeStates: Record<string, unknown> };
      events: { type: string; [k: string]: unknown };
    },
    context: { activePaneId, copyModeStates: {} },
    invoke: {
      id: 'keyboard',
      src: 'keyboardActor',
      input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
    },
    on: {
      '*': {
        actions: ({ event }) => {
          events.push(event as { type: string; [k: string]: unknown });
        },
      },
    },
  }).provide({ actors: { keyboardActor }, actions: {} } as never);

  const actor = createActor(parent);
  actor.start();
  const child = actor.getSnapshot().children.keyboard as AnyActorRef;
  child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: activePaneId });
  return { actor, child, events };
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
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const keyboardActor = createKeyboardActor();
  const parent = createMachine({
    types: {} as {
      context: {
        activePaneId: string;
        activeWindowId: string;
        copyModeStates: Record<string, unknown>;
        panes: Array<{ tmuxId: string; windowId: string; active: boolean }>;
      };
      events: { type: string; paneId?: string; windowId?: string; [k: string]: unknown };
    },
    context: {
      activePaneId: initial,
      activeWindowId: wid('@0'),
      copyModeStates: {},
      panes: [
        { tmuxId: pid('%1'), windowId: wid('@0'), active: true },
        { tmuxId: pid('%2'), windowId: wid('@0'), active: false },
        { tmuxId: pid('%3'), windowId: wid('@1'), active: true },
      ],
    },
    invoke: {
      id: 'keyboard',
      src: 'keyboardActor',
      input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
    },
    on: {
      SET_PARENT_ACTIVE: {
        actions: assign({ activePaneId: ({ event }) => event.paneId as string }),
      },
      SET_PARENT_WINDOW: {
        actions: assign({ activeWindowId: ({ event }) => event.windowId as string }),
      },
      '*': {
        actions: ({ event }) => {
          events.push(event as { type: string; [k: string]: unknown });
        },
      },
    },
  }).provide({ actors: { keyboardActor }, actions: {} } as never);

  const actor = createActor(parent);
  actor.start();
  const child = actor.getSnapshot().children.keyboard as AnyActorRef;
  child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: initial });
  return { actor, child, events };
}

describe('keyboardActor — active-pane target uses the live snapshot', () => {
  it('targets the newly-active pane even before UPDATE_ACTIVE_PANE arrives', () => {
    const { actor, events } = spawnWithLiveContext(pid('%1'));
    actor.send({ type: 'SET_PARENT_ACTIVE', paneId: pid('%2') });
    pressKey({ key: 'a' });
    expect(lastSendCommand(events)).toBe("send-keys -t %2 -l -- 'a'");
  });

  it('falls back to the cached pane when the snapshot has no activePaneId', () => {
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const keyboardActor = createKeyboardActor();
    const parent = createMachine({
      types: {} as {
        context: Record<string, never>;
        events: { type: string; [k: string]: unknown };
      },
      context: {},
      invoke: {
        id: 'keyboard',
        src: 'keyboardActor',
        input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
      },
      on: {
        '*': { actions: ({ event }) => events.push(event as { type: string }) },
      },
    }).provide({ actors: { keyboardActor }, actions: {} } as never);
    const actor = createActor(parent);
    actor.start();
    const child = actor.getSnapshot().children.keyboard as AnyActorRef;
    child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: pid('%7') });

    pressKey({ key: 'b' });
    expect(lastSendCommand(events)).toBe("send-keys -t %7 -l -- 'b'");
  });
});

describe('keyboardActor — bindings are pinned to the window the user sees', () => {
  it('prepends select-window and select-pane to prefix and root bindings', () => {
    const { actor, child, events } = spawnWithLiveContext(pid('%1'));
    child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        tables: {},
        prefix_bindings: [{ key: '%', command: 'split-window -h', repeat: false }],
        root_bindings: [{ key: 'C-n', command: 'next-window' }],
      },
    });
    actor.send({ type: 'SET_PARENT_ACTIVE', paneId: pid('%2') });

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
    const { actor, child, events } = spawnWithLiveContext(pid('%1'));
    child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        tables: {},
        prefix_bindings: [{ key: '%', command: 'split-window -h', repeat: false }],
        root_bindings: [],
      },
    });
    actor.send({ type: 'SET_PARENT_WINDOW', windowId: wid('@1') });
    actor.send({ type: 'SET_PARENT_ACTIVE', paneId: pid('%2') });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });
    expect(lastSendCommand(events)).toBe(
      'select-window -t @1 \\; select-pane -t %3 \\; split-window -h',
    );

    actor.send({ type: 'SET_PARENT_WINDOW', windowId: wid('@2') });
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });
    expect(lastSendCommand(events)).toBe('select-window -t @2 \\; split-window -h');
  });

  it('leaves a placeholder window and pane unpinned: tmux is already on the window they stand for', () => {
    const { actor, child, events } = spawnWithLiveContext(pid('%1'));
    child.send({
      type: 'UPDATE_KEYBINDINGS',
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
    actor.send({ type: 'SET_PARENT_WINDOW', windowId: placeholderWindowId('op1') });
    actor.send({ type: 'SET_PARENT_ACTIVE', paneId: placeholderPaneId('pane_op1') });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });

    expect(lastSendCommand(events)).toBe('split-window -h');
    actor.stop();
  });

  it('derives the window from the pinned pane when the machine has none yet', () => {
    const { actor, events, child } = spawnWithLiveContext(pid('%1'));
    child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        tables: {},
        prefix_bindings: [{ key: '%', command: 'split-window -h', repeat: false }],
        root_bindings: [],
      },
    });
    actor.send({ type: 'SET_PARENT_WINDOW', windowId: '' });
    actor.send({ type: 'SET_PARENT_ACTIVE', paneId: pid('%3') });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });

    expect(lastSendCommand(events)).toBe(
      'select-window -t @1 \\; select-pane -t %3 \\; split-window -h',
    );
    actor.stop();
  });
});

describe('keyboardActor — ctrl+digit is the tab strip, not a tmux binding', () => {
  it('sends the strip position for ctrl+1–9 and toggles the overview on ctrl+0', () => {
    const { child, events } = spawnWithLiveContext(pid('%1'));
    child.send({
      type: 'UPDATE_KEYBINDINGS',
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
    const { actor, child, events } = spawnWithLiveContext(pid('%1'));
    child.send({ type: 'UPDATE_KEYBINDINGS', keybindings });
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
    actor.stop();
  });

  it('a binding that names no table, or a key the table does not bind, leaves it', () => {
    const { actor, child, events } = spawnWithLiveContext(pid('%1'));
    child.send({ type: 'UPDATE_KEYBINDINGS', keybindings });
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
    actor.stop();
  });

  it('prefix s toggles the left column once, and the next s is typed like any key', () => {
    const { actor, child, events } = spawnWithLiveContext(pid('%1'));
    child.send({ type: 'UPDATE_KEYBINDINGS', keybindings });
    const toggles = () => events.filter((e) => e.type === 'TOGGLE_LEFT_SIDEBAR');

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 's' });
    expect(toggles()).toEqual([{ type: 'TOGGLE_LEFT_SIDEBAR' }]);

    pressKey({ key: 's' });
    expect(lastSendCommand(events)).toBe("send-keys -t %1 -l -- 's'");
    expect(toggles()).toHaveLength(1);

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 's' });
    expect(toggles()).toHaveLength(2);
    expect(sendCommands(events)).not.toContain('send-keys -t %1 C-a');
    actor.stop();
  });
});
