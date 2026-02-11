import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Terminal } from '../components/Terminal';
import type { PaneContent, CellLine, TerminalCell } from '../tmux/types';

// Helper to create a simple cell line from a string
function createLine(text: string): CellLine {
  return text.split('').map((c): TerminalCell => ({ c }));
}

// Helper to create content from string array
function createContent(lines: string[]): PaneContent {
  return lines.map(createLine);
}

describe('Terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders terminal container', () => {
    const content = createContent(['line 1', 'line 2', 'line 3']);
    render(<Terminal content={content} />);

    const terminal = screen.getByTestId('terminal');
    expect(terminal).toBeInTheDocument();
    expect(terminal).toHaveClass('terminal-container');
  });

  it('renders terminal lines', () => {
    const content = createContent(['hello', 'world']);
    render(<Terminal content={content} />);

    const terminal = screen.getByTestId('terminal');
    expect(terminal).toBeInTheDocument();

    // Check that content is rendered
    const pre = terminal.querySelector('.terminal-content');
    expect(pre).toBeInTheDocument();
    expect(pre?.textContent).toContain('hello');
    expect(pre?.textContent).toContain('world');
  });

  it('handles empty content', () => {
    render(<Terminal content={[]} />);

    const terminal = screen.getByTestId('terminal');
    expect(terminal).toBeInTheDocument();
  });

  it('pads content to match height', () => {
    const content = createContent(['line 1']);
    render(<Terminal content={content} height={5} />);

    const terminal = screen.getByTestId('terminal');
    const pre = terminal.querySelector('.terminal-content');
    const lines = pre?.querySelectorAll('.terminal-line');

    // Should have 5 lines (1 content + 4 padding)
    expect(lines?.length).toBe(5);
  });

  it('sets cursor data attributes', () => {
    const content = createContent(['test']);
    render(<Terminal content={content} cursorX={5} cursorY={3} />);

    const terminal = screen.getByTestId('terminal');
    expect(terminal).toHaveAttribute('data-cursor-x', '5');
    expect(terminal).toHaveAttribute('data-cursor-y', '3');
  });

  it('uses copy mode cursor position when in copy mode', () => {
    const content = createContent(['test']);
    render(
      <Terminal
        content={content}
        cursorX={1}
        cursorY={2}
        inMode={true}
        copyCursorX={10}
        copyCursorY={5}
      />
    );

    const terminal = screen.getByTestId('terminal');
    expect(terminal).toHaveAttribute('data-cursor-x', '10');
    expect(terminal).toHaveAttribute('data-cursor-y', '5');
  });

  it('sets aria-label from first line content', () => {
    const content = createContent(['Hello World', 'Line 2']);
    render(<Terminal content={content} />);

    const terminal = screen.getByTestId('terminal');
    expect(terminal).toHaveAttribute('aria-label', expect.stringContaining('Hello World'));
  });
});
