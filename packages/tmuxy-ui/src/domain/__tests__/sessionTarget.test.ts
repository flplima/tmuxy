/**
 * Before the client knows a pane — on load, or while a split's pane is still a
 * placeholder — keys, text and pastes go to the session name, which a rename
 * can fill with spaces and `;`. Unquoted, the `;` ended the command and tmux
 * ran the rest as one of its own.
 */

import { describe, it, expect } from 'vitest';
import { TmuxOp, toTmuxCommand } from '../commands';

const session = 'my work; kill-server';

describe('a session name keys fall back to', () => {
  it.each([
    ['SendKeys', TmuxOp.SendKeys({ target: session, keys: 'Enter' })],
    ['SendText', TmuxOp.SendText({ target: session, text: 'a\nb' })],
    ['PasteText', TmuxOp.PasteText({ target: session, text: 'a' })],
  ])('is one quoted target in a %s', (_, op) => {
    for (const line of toTmuxCommand(op).split('\n')) {
      if (line.startsWith('set-buffer')) continue;
      expect(line).toContain("-t 'my work; kill-server'");
    }
  });
});
