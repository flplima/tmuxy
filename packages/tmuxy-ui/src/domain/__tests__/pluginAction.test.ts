/**
 * `TmuxOp.PluginAction`: the one command a plugin menu item sends. Its line
 * is a shell's, so only names and a token from fixed alphabets reach it.
 */

import { describe, it, expect } from 'vitest';
import { TmuxOp, toTmuxCommand } from '../commands';
import { pid } from '../../test/wire';

describe('PluginAction', () => {
  const CLI = '$TMUXY_DATA_DIR/bin/tmuxy-cli';

  it('runs `tmuxy plugin action` in the background, its output dropped', () => {
    expect(
      toTmuxCommand(
        TmuxOp.PluginAction({ plugin: 'devtools', action: 'open', paneId: pid('%4'), token: null }),
      ),
    ).toBe(
      `run-shell -b "\\"${CLI}\\" plugin action devtools:open --pane %4 --trigger menu >/dev/null 2>&1"`,
    );
  });

  it('names a prepared token, which carries the selection instead of the line', () => {
    const token = '0123456789abcdef0123456789abcdef';
    expect(
      toTmuxCommand(TmuxOp.PluginAction({ plugin: 'p', action: 'a', paneId: pid('%1'), token })),
    ).toContain(`--trigger menu --token ${token} >`);
  });

  /** The line is a shell's: a name outside the server's alphabet is never sent. */
  it.each([
    { plugin: 'p"; touch /tmp/x; "', action: 'a', paneId: '%1', token: null },
    { plugin: 'p', action: 'a b', paneId: '%1', token: null },
    { plugin: 'p', action: 'a', paneId: '%1; kill-server', token: null },
    { plugin: 'p', action: 'a', paneId: '%1', token: '$(id)' },
  ])('refuses %o', (fields) => {
    // Cast, not `pid`: the op's own check is what is under test.
    const command = toTmuxCommand(TmuxOp.PluginAction(fields as never));
    expect(command).toBe("display-message 'tmuxy: not a plugin action'");
  });
});
