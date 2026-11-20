/**
 * Ctrl+C at an empty shell prompt ends the shell (`domain/emptyPrompt.ts`):
 * the machine marks the prompt from the frames, follows what is typed from
 * the ops that go out, and sends the guarded op only where the line looks
 * empty. Anywhere else, and for Cmd+C, Ctrl+C stays the interrupt.
 */

import { describe, it, expect } from 'vitest';
import { TmuxOp } from '../../../domain/commands';
import { PaneId, WindowId } from '../../../domain/ids';
import { cellLine, modelPane, modelUpdate, modelWindow } from '../../../test/model';
import { recorder, startApp } from '../../../test/app';

const W1 = WindowId.make('@1');
const SHELL = PaneId.make('%1');

function app() {
  const store = recorder();
  const actor = startApp({ actors: { tmuxStoreActor: store.logic } });
  /** A frame of %1 showing `rows`, the cursor at the end of the last. */
  const frame = (...rows: string[]) =>
    actor.send(
      modelUpdate(
        [
          modelPane(SHELL, W1, {
            active: true,
            command: 'zsh',
            content: rows.map(cellLine),
            cursorY: rows.length - 1,
            cursorX: rows[rows.length - 1].length,
          }),
        ],
        [modelWindow(W1, 1, { active: true })],
        { paneId: SHELL, windowId: W1 },
      ),
    );
  const ctrlC = (ctrlKey = true) => {
    const before = store.ops().length;
    actor.send({ type: 'COPY_SELECTION', ctrlKey });
    return store.ops().slice(before);
  };
  const type = (op: TmuxOp) => actor.send({ type: 'DISPATCH_OP', op });
  return { frame, ctrlC, type };
}

const interrupt = TmuxOp.SendKeys({ target: SHELL, keys: 'C-c' });
const eof = TmuxOp.InterruptOrEof({ paneId: SHELL });

describe('Ctrl+C at a shell prompt', () => {
  it('ends the shell at an empty prompt, and interrupts once something was typed', () => {
    const { frame, ctrlC, type } = app();
    frame('% ');
    expect(ctrlC()).toEqual([eof]);

    // No prompt drawn since that Ctrl+C: nothing says the line is empty.
    expect(ctrlC()).toEqual([interrupt]);

    frame('% ', '% ');
    type(TmuxOp.SendText({ target: SHELL, text: 'ls' }));
    frame('% ', '% ls');
    expect(ctrlC()).toEqual([interrupt]);

    // Cmd+C with nothing selected is never the EOF.
    frame('% ', '% ls', '% ');
    expect(ctrlC(false)).toEqual([interrupt]);

    // A line recalled and deleted again is empty again.
    frame('% ', '% ls', '% ', '% ');
    type(TmuxOp.SendKeys({ target: SHELL, keys: 'Up' }));
    frame('% ', '% ls', '% ', '% ls');
    expect(ctrlC()).toEqual([interrupt]);
    frame('% ', '% ls', '% ', '% ', '% ');
    type(TmuxOp.SendKeys({ target: SHELL, keys: 'Up' }));
    type(TmuxOp.SendKeys({ target: SHELL, keys: 'BSpace' }));
    type(TmuxOp.SendKeys({ target: SHELL, keys: 'BSpace' }));
    frame('% ', '% ls', '% ', '% ', '% ');
    expect(ctrlC()).toEqual([eof]);
  });
});
