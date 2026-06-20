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

  it('renders cursor at correct position', () => {
    const content = createContent(['test line here']);
    render(<Terminal content={content} cursorX={5} cursorY={0} isActive={true} />);

    const cursor = document.querySelector('.terminal-cursor');
    expect(cursor).toBeInTheDocument();
    expect(cursor).toHaveAttribute('data-cursor-x', '5');
    expect(cursor).toHaveAttribute('data-cursor-y', '0');
  });

  it('uses copy mode cursor position when in copy mode', () => {
    const content = createContent(['test line here that is long enough']);
    render(
      <Terminal
        content={content}
        cursorX={1}
        cursorY={0}
        inMode={true}
        copyCursorX={10}
        copyCursorY={0}
        isActive={true}
      />,
    );

    const cursor = document.querySelector('.terminal-cursor');
    expect(cursor).toBeInTheDocument();
    expect(cursor).toHaveAttribute('data-cursor-x', '10');
    expect(cursor).toHaveAttribute('data-cursor-y', '0');
  });

  it('sizes each span to an exact cell count so glyph width never shifts the line', () => {
    // Anti-jitter: spans are pinned to `${n}ch` (the monospace cell advance) so
    // a symbol whose glyph is wider/narrower than a cell can't push the rest of
    // the line when it changes (e.g. a spinner animation).
    const content = createContent(['hello world']);
    render(<Terminal content={content} />);

    const spans = screen.getByTestId('terminal').querySelectorAll('.terminal-line > span');
    const widthSpan = Array.from(spans).find((s) => s.textContent === 'hello world');
    expect(widthSpan).toBeDefined();
    // 'hello world' is 11 characters → width: 11ch.
    expect((widthSpan as HTMLElement).style.width).toBe('11ch');
  });

  it('isolates a wide (CJK) character into its own cell-width span so it stays on the grid', () => {
    // Data model: a wide char occupies two columns — the character plus a
    // continuation cell (a space). 'a中 b' → cells [a, 中, <space>, b]. The 中
    // must be its own 1-cell span so its 2-column glyph overflows into the blank
    // continuation cell instead of pushing 'b' off the column grid.
    const content = createContent(['a中 b']);
    render(<Terminal content={content} />);

    const spans = Array.from(
      screen.getByTestId('terminal').querySelectorAll('.terminal-line > span'),
    ) as HTMLElement[];

    const wideSpan = spans.find((s) => s.textContent === '中');
    expect(wideSpan).toBeDefined();
    // Own 1-cell box; the glyph (≈2 cells) overflows into the next, blank cell.
    expect(wideSpan!.style.width).toBe('1ch');
    // It must not have been merged with the neighbouring 'a' or trailing text.
    expect(spans.some((s) => s.textContent === 'a中')).toBe(false);
    expect(spans.some((s) => s.textContent?.includes('中 '))).toBe(false);
  });

  it('sets aria-live to off to avoid flooding screen readers', () => {
    const content = createContent(['Hello World', 'Line 2']);
    render(<Terminal content={content} />);

    const terminal = screen.getByTestId('terminal');
    expect(terminal).toHaveAttribute('aria-live', 'off');
  });
});
