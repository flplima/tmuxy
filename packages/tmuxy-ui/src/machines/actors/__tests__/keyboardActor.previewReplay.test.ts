import { afterEach, describe, expect, it } from 'vitest';
import type { AnyActorRef } from 'xstate';
import { markReplayedPreviewKey } from '../../../components/widgets/preview/previewBridge';
import { pid } from '../../../test/wire';
import { lastSendCommand, sendCommands, spawnKeyboardActor } from './keyboardHarness';

const running: AnyActorRef[] = [];
afterEach(() => {
  running.splice(0).forEach((actor) => actor.stop());
});

function dispatchReplayed(init: KeyboardEventInit) {
  window.dispatchEvent(
    markReplayedPreviewKey(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    ),
  );
}

describe('keyboardActor — preview-replayed keys', () => {
  it('allows Ctrl+C, prefix activation, and navigation root bindings while blocking chained prefix chords, zoom, tab jumps, and arbitrary root commands', () => {
    const { actor, child, events } = spawnKeyboardActor(pid('%3'));
    running.push(actor);
    child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        prefix_bindings: [{ key: 'x', command: 'kill-pane', repeat: false }],
        root_bindings: [
          { key: 'C-h', command: 'tmuxy-nav-left', repeat: false },
          { key: 'C-e', command: "run-shell 'touch /tmp/pwn'", repeat: false },
        ],
        tables: {},
      },
    });

    dispatchReplayed({ key: '=', code: 'Equal', ctrlKey: true });
    dispatchReplayed({ key: '2', code: 'Digit2', ctrlKey: true });
    dispatchReplayed({ key: 'e', code: 'KeyE', ctrlKey: true });
    expect(events.some((e) => e.type === 'INCREASE_FONT_SIZE')).toBe(false);
    expect(events.some((e) => e.type === 'SELECT_TAB_BY_POSITION')).toBe(false);
    expect(sendCommands(events)).toEqual([]);

    dispatchReplayed({ key: 'h', code: 'KeyH', ctrlKey: true });
    expect(lastSendCommand(events)).toContain('tmuxy-nav-left');

    const beforeChain = sendCommands(events).length;
    dispatchReplayed({ key: 'a', code: 'KeyA', ctrlKey: true });
    expect(events.filter((e) => e.type === 'PREFIX_MODE_CHANGE').pop()).toMatchObject({
      active: true,
    });
    dispatchReplayed({ key: 'x', code: 'KeyX', ctrlKey: true });
    expect(events.filter((e) => e.type === 'PREFIX_MODE_CHANGE').pop()).toMatchObject({
      active: false,
    });
    expect(sendCommands(events).slice(beforeChain)).toEqual([]);

    dispatchReplayed({ key: 'c', code: 'KeyC', ctrlKey: true });
    expect(events.some((e) => e.type === 'COPY_SELECTION')).toBe(true);
  });
});
