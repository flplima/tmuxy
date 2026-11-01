import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pid } from '../../../test/wire';
import { pasteBufferInto } from '../../../domain/commandHelpers';
import { pasteText, sendCommands, spawnKeyboardActor } from './keyboardHarness';

describe('keyboardActor — paste', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  beforeEach(() => {
    handle = spawnKeyboardActor(pid('%3'));
    handle.events.length = 0;
  });
  afterEach(() => handle.actor.stop());

  it('sends nothing for a clipboard of nothing but controls', () => {
    pasteText('\x1b\x00\x07\x7f\u009b');
    expect(sendCommands(handle.events)).toEqual([]);
  });

  it('pastes the text a clipboard keeps once its controls are gone', () => {
    pasteText('\x1bok');
    expect(sendCommands(handle.events)).toEqual([
      `set-buffer -b tmuxy-paste "ok"\n${pasteBufferInto('%3')}`,
    ]);
  });
});
