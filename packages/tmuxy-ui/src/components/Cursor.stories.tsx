import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { Cursor } from './Cursor';

const meta: Meta<typeof Cursor> = {
  title: 'Components/Cursor',
  component: Cursor,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div
        style={{
          background: '#0f0f12',
          color: '#e5e5e5',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 16,
          padding: 24,
          position: 'relative',
          width: 320,
          height: 80,
        }}
      >
        <Story />
      </div>
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

export const Block: Story = {
  args: { x: 0, y: 0, mode: 'block', char: 'M', charWidth: 10, charHeight: 20, active: true },
  play: async ({ canvasElement }) => {
    const cursor = getCursor(canvasElement);
    expect(cursor).toHaveClass('terminal-cursor-block');
    expect(cursor).toHaveClass('terminal-cursor-overlay');
    expect(cursor).not.toHaveClass('terminal-cursor-inactive');
    expect(cursor).toHaveAttribute('data-cursor-x', '0');
  },
};

export const Underline: Story = {
  args: { x: 0, y: 0, mode: 'underline', char: 'M', charWidth: 10, charHeight: 20, active: true },
  play: async ({ canvasElement }) => {
    expect(getCursor(canvasElement)).toHaveClass('terminal-cursor-underline');
  },
};

export const Bar: Story = {
  args: { x: 0, y: 0, mode: 'bar', char: 'M', charWidth: 10, charHeight: 20, active: true },
  play: async ({ canvasElement }) => {
    expect(getCursor(canvasElement)).toHaveClass('terminal-cursor-bar');
  },
};

export const Inactive: Story = {
  args: { x: 0, y: 0, mode: 'block', char: 'M', charWidth: 10, charHeight: 20, active: false },
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
  args: {
    x: 0,
    y: 0,
    mode: 'block',
    char: 'M',
    charWidth: 10,
    charHeight: 20,
    active: true,
    copyMode: true,
  },
  play: async ({ canvasElement }) => {
    expect(getCursor(canvasElement)).toHaveClass('terminal-cursor-copy');
  },
};
