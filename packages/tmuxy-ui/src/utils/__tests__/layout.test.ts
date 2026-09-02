import { describe, expect, it } from 'vitest';
import { findZoomedPane } from '../layout';

// Geometry straight from tmux (`list-panes`) on a 139×30 window with a 2×2
// grid and the TOP-LEFT pane zoomed: the zoomed pane spans the grid, the other
// three keep their pre-zoom boxes.
const zoomedTopLeft = [
  { tmuxId: '%15', x: 0, y: 1, width: 69, height: 14 },
  { tmuxId: '%30', x: 0, y: 1, width: 139, height: 29 },
  { tmuxId: '%29', x: 70, y: 16, width: 69, height: 14 },
  { tmuxId: '%28', x: 70, y: 1, width: 69, height: 14 },
];

describe('findZoomedPane', () => {
  it('picks the pane that spans the grid, not the bottom-right one', () => {
    // The regression: the bottom-right pane (%29) also reaches the grid's far
    // corner, and a far-corner check listed it first — so the UI hid the
    // zoomed pane and showed %29 in its quarter slot.
    expect(findZoomedPane(zoomedTopLeft)?.tmuxId).toBe('%30');
  });

  it('is independent of pane order', () => {
    const reversed = [...zoomedTopLeft].reverse();
    expect(findZoomedPane(reversed)?.tmuxId).toBe('%30');
  });

  it('resolves a zoomed pane in a vertical stack', () => {
    // Two full-width panes stacked; the bottom one zoomed. Both share the
    // grid's width, only the zoomed one reaches the top.
    const panes = [
      { tmuxId: '%1', x: 0, y: 1, width: 139, height: 14 },
      { tmuxId: '%2', x: 0, y: 1, width: 139, height: 29 },
    ];
    expect(findZoomedPane(panes)?.tmuxId).toBe('%2');
  });

  it('returns the only pane of a single-pane window', () => {
    expect(findZoomedPane([{ tmuxId: '%9', x: 0, y: 1, width: 139, height: 29 }])?.tmuxId).toBe(
      '%9',
    );
  });

  it('returns null for an empty grid and for an un-zoomed layout', () => {
    expect(findZoomedPane([])).toBeNull();
    const grid = [
      { tmuxId: '%1', x: 0, y: 1, width: 69, height: 14 },
      { tmuxId: '%2', x: 70, y: 1, width: 69, height: 14 },
      { tmuxId: '%3', x: 0, y: 16, width: 69, height: 14 },
      { tmuxId: '%4', x: 70, y: 16, width: 69, height: 14 },
    ];
    expect(findZoomedPane(grid)).toBeNull();
  });
});
