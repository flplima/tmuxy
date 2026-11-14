/**
 * The command palette's keys: its chord from anywhere, `prefix P` and
 * `prefix g` unless the user bound those keys, and nothing typed into a pane
 * while it is open.
 */

import { describe, expect, it } from 'vitest';
import { pid } from '../../../test/wire';
import { pressKey, sendCommands, spawnKeyboardActor } from './keyboardHarness';

const BINDINGS = {
  prefix_key: 'C-a',
  tables: {},
  prefix_bindings: [{ key: 'c', command: 'new-window', repeat: false }],
  root_bindings: [],
};

const toggles = (events: Array<{ type: string; [k: string]: unknown }>) =>
  events.filter((e) => e.type === 'TOGGLE_PALETTE').map((e) => e.mode);

describe('keyboardActor — the command palette', () => {
  it('opens on Ctrl+Shift+P and on Cmd+Shift+P, and sends the pane nothing', () => {
    const { events, set } = spawnKeyboardActor(pid('%1'));
    set({ keybindings: BINDINGS });

    pressKey({ key: 'P', ctrlKey: true, shiftKey: true });
    pressKey({ key: 'P', metaKey: true, shiftKey: true });
    // A browser that reports the unshifted letter with Shift held.
    pressKey({ key: 'p', ctrlKey: true, shiftKey: true });

    expect(toggles(events)).toEqual(['all', 'all', 'all']);
    expect(sendCommands(events)).toEqual([]);
  });

  it('leaves Ctrl+P and Shift+P to the pane', () => {
    const { events, set } = spawnKeyboardActor(pid('%1'));
    set({ keybindings: BINDINGS });

    pressKey({ key: 'p', ctrlKey: true });
    pressKey({ key: 'P', shiftKey: true });

    expect(toggles(events)).toEqual([]);
    expect(sendCommands(events)).toHaveLength(2);
  });

  it('opens everything on prefix P and the places on prefix g', () => {
    const { events, set } = spawnKeyboardActor(pid('%1'));
    set({ keybindings: BINDINGS });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'P', shiftKey: true });
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'g' });

    expect(toggles(events)).toEqual(['all', 'go']);
    expect(sendCommands(events)).toEqual([]);
  });

  it("runs the user's own binding on P or g instead of opening the palette", () => {
    const { events, set } = spawnKeyboardActor(pid('%1'));
    set({
      keybindings: {
        ...BINDINGS,
        prefix_bindings: [
          { key: 'P', command: 'display-message mine', repeat: false },
          { key: 'g', command: 'display-message also-mine', repeat: false },
        ],
      },
    });
    // The binding runs pinned to the pane in front; what follows the pin is the binding's own.
    const ran = () => sendCommands(events).map((c) => c.slice(c.lastIndexOf('; ') + 2));

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'P', shiftKey: true });
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'g' });

    expect(toggles(events)).toEqual([]);
    expect(ran()).toEqual(['display-message mine', 'display-message also-mine']);
  });

  it('while it is open, a key that misses its field closes on Escape and types nothing', () => {
    const { events, set } = spawnKeyboardActor(pid('%1'));
    set({ keybindings: BINDINGS, palette: 'all' });

    pressKey({ key: 'l' });
    pressKey({ key: 'Enter' });
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'c' });
    expect(events.map((e) => e.type)).toEqual([]);

    pressKey({ key: 'Escape' });
    expect(events.map((e) => e.type)).toEqual(['CLOSE_PALETTE']);

    // The chord still toggles it.
    pressKey({ key: 'P', ctrlKey: true, shiftKey: true });
    expect(toggles(events)).toEqual(['all']);
  });
});
