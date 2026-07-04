import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { TerminalLine } from './TerminalLine';
import type { CellLine } from '../tmux/types';

const meta: Meta<typeof TerminalLine> = {
  title: 'Components/TerminalLine',
  component: TerminalLine,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <pre
        className="terminal-content"
        style={{
          margin: 0,
          padding: 12,
          background: '#0f0f12',
          color: '#e5e5e5',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 14,
          lineHeight: '20px',
          width: 600,
          position: 'relative',
        }}
      >
        <Story />
      </pre>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof TerminalLine>;

function text(str: string): CellLine {
  return str.split('').map((c) => ({ c }));
}

function styled(str: string, style: Record<string, unknown>): CellLine {
  return str.split('').map((c) => ({ c, s: style }));
}

export const Plain: Story = {
  args: {
    line: text('$ ls -la /home/user'),
    lineIndex: 0,
    cursorX: 0,
    cursorY: 99,
    showCursor: false,
    inMode: false,
    isActive: true,
    width: 80,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/ls -la \/home\/user/)).toBeInTheDocument();
    expect(canvasElement.querySelector('.terminal-cursor')).toBeNull();
  },
};

export const WithCursor: Story = {
  args: {
    line: text('$ vim notes.md'),
    lineIndex: 0,
    cursorX: 14,
    cursorY: 0,
    showCursor: true,
    inMode: false,
    isActive: true,
    width: 80,
  },
  play: async ({ canvasElement }) => {
    const cursor = canvasElement.querySelector('.terminal-cursor');
    expect(cursor).not.toBeNull();
    expect(cursor).not.toHaveClass('terminal-cursor-inactive');
  },
};

export const Styled: Story = {
  args: {
    line: [
      ...styled('error: ', { fg: 1, bold: true }),
      ...text('something went wrong on '),
      ...styled('main.rs:42', { underline: true, fg: 4 }),
    ],
    lineIndex: 0,
    cursorX: 0,
    cursorY: 99,
    showCursor: false,
    inMode: false,
    isActive: true,
    width: 80,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/error:/)).toBeInTheDocument();
    expect(canvas.getByText(/main\.rs:42/)).toBeInTheDocument();
  },
};

export const Selection: Story = {
  args: {
    line: text('the quick brown fox jumps over the lazy dog'),
    lineIndex: 0,
    cursorX: 0,
    cursorY: 99,
    showCursor: false,
    inMode: false,
    isActive: true,
    selectionRange: { startCol: 4, endCol: 14 },
    width: 80,
  },
  play: async ({ canvasElement }) => {
    // At least one span should carry the selection highlight class.
    const selected = canvasElement.querySelectorAll('.terminal-selected');
    expect(selected.length).toBeGreaterThan(0);
  },
};
