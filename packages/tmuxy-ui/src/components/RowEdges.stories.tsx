/**
 * RowEdges stories — the pane's padding columns painted per row.
 */

import type { CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { RowEdges } from './RowEdges';
import type { CellLine } from '../tmux/types';

function styled(str: string, style: Record<string, unknown>): CellLine {
  return str.split('').map((c) => ({ c, s: style }));
}

const meta: Meta<typeof RowEdges> = {
  title: 'Components/RowEdges',
  component: RowEdges,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div
        className="pane-content"
        data-testid="pane-box"
        style={
          {
            '--pane-h-padding-left': '9px',
            '--pane-h-padding-right': '9px',
            '--line-height-terminal': '24px',
            position: 'relative',
            width: 300,
            height: 72,
            background: '#282828',
          } as CSSProperties
        }
      >
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof RowEdges>;

export const ThreeRows: Story = {
  args: {
    // The status row fills the grid (11 columns); the inverse row stops short
    // of it, the way a coloured prompt or a line of block art does.
    cols: 11,
    lines: [
      styled('plain', {}),
      [
        ...styled(' NORMAL ', { bg: { r: 168, g: 153, b: 132 } }),
        ...styled(' x ', { bg: { r: 60, g: 56, b: 54 } }),
      ],
      styled('inverse', { fg: { r: 1, g: 2, b: 3 }, inverse: true }),
    ],
  },
  play: async ({ canvasElement }) => {
    const box = canvasElement.querySelector('[data-testid="pane-box"]')!.getBoundingClientRect();
    const strips = [...canvasElement.querySelectorAll<HTMLElement>('.terminal-edge')];
    const lefts = strips.filter((s) => s.classList.contains('terminal-edge-left'));
    const rights = strips.filter((s) => s.classList.contains('terminal-edge-right'));
    // Row 0 has no colours: nothing painted for it. Both coloured rows touch
    // the left edge — column 0 is against the padding whatever the row holds —
    // but only the full-width one reaches the right.
    expect(lefts).toHaveLength(2);
    expect(rights).toHaveLength(1);
    for (const s of lefts) {
      const r = s.getBoundingClientRect();
      expect(r.left).toBeCloseTo(box.left, 0);
      expect(r.width).toBeCloseTo(9, 0);
      expect(r.height).toBeCloseTo(24, 0);
    }
    const right = rights[0].getBoundingClientRect();
    expect(right.right).toBeCloseTo(box.right, 0);
    expect(right.width).toBeCloseTo(9, 0);
    // The right strip belongs to the status row, not to the short one below it.
    expect(right.bottom).toBeCloseTo(box.bottom - 24, 0);
    // Rows are bottom-anchored: the last row's strips sit at the bottom.
    const [row1Left, row2Left] = lefts;
    expect(row2Left.getBoundingClientRect().bottom).toBeCloseTo(box.bottom, 0);
    expect(row1Left.getBoundingClientRect().bottom).toBeCloseTo(box.bottom - 24, 0);
    expect(getComputedStyle(row1Left).backgroundColor).toBe('rgb(168, 153, 132)');
    // Inverse video paints the foreground.
    expect(getComputedStyle(row2Left).backgroundColor).toBe('rgb(1, 2, 3)');
  },
};

/**
 * The bug this rule exists to prevent: a row of block art ends in a coloured
 * cell, and that colour used to run from there to the pane's border — the
 * "stretched last character" an ASCII-art logo showed in tmuxy and in no other
 * terminal.
 */
export const ArtDoesNotBleedToTheBorder: Story = {
  args: {
    cols: 40,
    lines: [
      styled('\u2580\u2580\u2580\u2580', {
        fg: { r: 255, g: 0, b: 0 },
        bg: { r: 0, g: 0, b: 255 },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    const rights = canvasElement.querySelectorAll('.terminal-edge-right');
    expect(rights).toHaveLength(0);
    // The left edge is still painted: column 0 is against the padding.
    const lefts = canvasElement.querySelectorAll<HTMLElement>('.terminal-edge-left');
    expect(lefts).toHaveLength(1);
    expect(getComputedStyle(lefts[0]).backgroundColor).toBe('rgb(0, 0, 255)');
  },
};
