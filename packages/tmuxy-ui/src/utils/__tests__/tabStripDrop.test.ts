/**
 * Where a pane dragged onto the tab strip would land, and what tmux is asked
 * to do about it.
 */

import { describe, it, expect } from 'vitest';
import { tabStripDrop, tabDropCommand, type TabStripGeometry } from '../tabStripDrop';

const geometry: TabStripGeometry = {
  strip: { left: 0, top: 0, right: 800, bottom: 30 },
  tabs: [
    { windowId: '@0', rect: { left: 10, top: 4, right: 110, bottom: 26 } },
    { windowId: '@1', rect: { left: 120, top: 4, right: 220, bottom: 26 } },
  ],
};

describe('tabStripDrop', () => {
  it('names the tab the pointer is over', () => {
    expect(tabStripDrop(geometry, 60, 15)).toEqual({ kind: 'tab', windowId: '@0' });
    expect(tabStripDrop(geometry, 200, 15)).toEqual({ kind: 'tab', windowId: '@1' });
  });

  it('reads the empty space past the last tab as a new tab', () => {
    expect(tabStripDrop(geometry, 500, 15)).toEqual({ kind: 'new' });
  });

  it('reads a gap between two tabs as a new tab as well', () => {
    // The alternative is a target a few pixels wide that does nothing.
    expect(tabStripDrop(geometry, 115, 15)).toEqual({ kind: 'new' });
  });

  it('is nothing at all below or beside the strip', () => {
    expect(tabStripDrop(geometry, 400, 60)).toBeNull();
    expect(tabStripDrop(geometry, 900, 15)).toBeNull();
  });

  it('is nothing when no strip was measured', () => {
    expect(tabStripDrop(null, 60, 15)).toBeNull();
  });
});

describe('tabDropCommand', () => {
  it('joins the pane into the tab it was dropped on', () => {
    expect(tabDropCommand({ kind: 'tab', windowId: '@1' }, '%3', '@0', 2)).toBe(
      'join-pane -s %3 -t @1',
    );
  });

  it('does nothing when the pane is dropped back on its own tab', () => {
    expect(tabDropCommand({ kind: 'tab', windowId: '@0' }, '%3', '@0', 2)).toBeNull();
  });

  it('breaks the pane out into a tab of its own', () => {
    expect(tabDropCommand({ kind: 'new' }, '%3', '@0', 2)).toBe('break-pane -s %3');
  });

  it('leaves a lone pane where it is — tmux will not break out the last one', () => {
    expect(tabDropCommand({ kind: 'new' }, '%3', '@0', 1)).toBeNull();
  });
});
