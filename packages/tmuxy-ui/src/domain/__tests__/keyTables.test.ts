import { describe, it, expect } from 'vitest';
import { splitTableSwitch } from '../keyTables';

describe('splitTableSwitch', () => {
  it('reads a binding that only enters a table as nothing to send', () => {
    expect(splitTableSwitch('switch-client -T pane')).toEqual({ command: '', table: 'pane' });
    expect(splitTableSwitch('switchc -T tab')).toEqual({ command: '', table: 'tab' });
  });

  it('keeps the rest of a sticky binding and the table it re-enters', () => {
    expect(splitTableSwitch('kill-pane \\; switch-client -T pane')).toEqual({
      command: 'kill-pane',
      table: 'pane',
    });
    expect(
      splitTableSwitch('split-window -v -c "#{pane_current_path}" \\; switch-client -T pane'),
    ).toEqual({ command: 'split-window -v -c "#{pane_current_path}"', table: 'pane' });
  });

  it('reads root as leaving every table, and no switch as naming none', () => {
    expect(splitTableSwitch('next-window \\; switch-client -T root')).toEqual({
      command: 'next-window',
      table: null,
    });
    expect(splitTableSwitch('resize-pane -Z')).toEqual({
      command: 'resize-pane -Z',
      table: undefined,
    });
  });
});
