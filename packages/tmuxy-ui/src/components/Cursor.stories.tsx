import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { Cursor } from './Cursor';
import { CellGridDecorator } from '../stories/cellGrid';

const meta: Meta<typeof Cursor> = {
  title: 'Components/Cursor',
  component: Cursor,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <CellGridDecorator style={{ width: 320, height: 80, padding: 24 }}>
        <Story />
      </CellGridDecorator>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Cursor>;

function getCursor(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector('.terminal-cursor') as HTMLElement | null;
  if (!el) throw new Error('cursor element not found');
  return el;
}

/** The cursor's box relative to the grid origin, in cells. */
function cursorCellRect(canvasElement: HTMLElement) {
  const grid = canvasElement.querySelector('.terminal-container') as HTMLElement;
  const cellW = parseFloat(getComputedStyle(grid).getPropertyValue('--cell-w'));
  const g = grid.getBoundingClientRect();
  const r = getCursor(canvasElement).getBoundingClientRect();
  return { col: (r.left - g.left) / cellW, cols: r.width / cellW, cellW };
}

export const Block: Story = {
  args: { x: 0, y: 0, mode: 'block', char: 'M', active: true },
  play: async ({ canvasElement }) => {
    const cursor = getCursor(canvasElement);
    expect(cursor).toHaveClass('terminal-cursor-block');
    expect(cursor).not.toHaveClass('terminal-cursor-inactive');
    expect(cursor).toHaveAttribute('data-cursor-x', '0');
    const { col, cols } = cursorCellRect(canvasElement);
    expect(col).toBeCloseTo(0, 1);
    expect(cols).toBeCloseTo(1, 1);
  },
};

export const AtColumn: Story = {
  args: { x: 7, y: 1, mode: 'block', char: 'M', active: true },
  parameters: {
    docs: {
      description: {
        story:
          'The cursor is addressed in cells: column 7 lands exactly 7 snapped cell widths from the grid origin.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const { col, cols, cellW } = cursorCellRect(canvasElement);
    expect(cellW).toBeGreaterThan(0);
    expect(col).toBeCloseTo(7, 1);
    expect(cols).toBeCloseTo(1, 1);
  },
};

export const Underline: Story = {
  args: { x: 0, y: 0, mode: 'underline', char: 'M', active: true },
  play: async ({ canvasElement }) => {
    expect(getCursor(canvasElement)).toHaveClass('terminal-cursor-underline');
  },
};

export const Bar: Story = {
  args: { x: 0, y: 0, mode: 'bar', char: 'M', active: true },
  play: async ({ canvasElement }) => {
    expect(getCursor(canvasElement)).toHaveClass('terminal-cursor-bar');
  },
};

export const Inactive: Story = {
  args: { x: 0, y: 0, mode: 'block', char: 'M', active: false },
  parameters: {
    docs: {
      description: { story: 'When the pane is unfocused, the cursor becomes hollow.' },
    },
  },
  play: async ({ canvasElement }) => {
    expect(getCursor(canvasElement)).toHaveClass('terminal-cursor-inactive');
  },
};

export const CopyMode: Story = {
  args: { x: 0, y: 0, mode: 'block', char: 'M', active: true, copyMode: true },
  play: async ({ canvasElement }) => {
    expect(getCursor(canvasElement)).toHaveClass('terminal-cursor-copy');
  },
};
