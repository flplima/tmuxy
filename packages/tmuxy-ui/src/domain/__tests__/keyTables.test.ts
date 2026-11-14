import { describe, it, expect } from 'vitest';
import { clientKeyFor, splitTableSwitch } from '../keyTables';

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

describe('clientKeyFor', () => {
  it('answers the keys the client has always taken, bound in tmux or not', () => {
    expect(clientKeyFor('prefix', 's', true)).toBe('left-sidebar');
    expect(clientKeyFor('prefix', 'w', false)).toBe('tab-overview');
    expect(clientKeyFor('tab', 'o', true)).toBe('tab-overview');
  });

  it('answers the palette keys only while nothing is bound on them', () => {
    expect(clientKeyFor('prefix', 'P', false)).toBe('command-palette');
    expect(clientKeyFor('prefix', 'g', false)).toBe('go-to');
    expect(clientKeyFor('prefix', 'P', true)).toBeUndefined();
    expect(clientKeyFor('prefix', 'g', true)).toBeUndefined();
  });

  it('has nothing for a key or a table the client does not answer', () => {
    expect(clientKeyFor('prefix', 'x', false)).toBeUndefined();
    expect(clientKeyFor('pane', 'P', false)).toBeUndefined();
  });
});
