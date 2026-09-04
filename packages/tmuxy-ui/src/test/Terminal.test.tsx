import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Terminal } from '../components/Terminal';
import { cellsToCss } from '../components/terminalShared';
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

  it('keeps the BOTTOM rows when stale content is taller than the pane', () => {
    // An optimistic shrink (split/kill/resize) reduces `height` before the
    // re-captured viewport arrives — the pane briefly renders old content that
    // is taller than it. tmux keeps the prompt/cursor (the tail) visible when
    // a pane shrinks, so the clip must drop the TOP rows, not the bottom.
    const content = createContent(['old 0', 'old 1', 'old 2', 'prompt $']);
    render(<Terminal content={content} height={2} cursorY={3} cursorX={0} isActive />);

    const pre = screen.getByTestId('terminal').querySelector('.terminal-content');
    const lines = [...(pre?.querySelectorAll('.terminal-line') ?? [])].map(
      (l) => l.textContent ?? '',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('old 2');
    expect(lines[1]).toContain('prompt $');
    expect(pre?.textContent).not.toContain('old 0');
    // The cursor followed its content line through the clip: content row 3 is
    // rendered row 1 after a 2-row clip, and the overlay is placed there.
    const cursor = screen.getByTestId('terminal').querySelector('.terminal-cursor');
    expect(cursor).toHaveAttribute('data-cursor-y', '1');
  });

  it('never blanks the pane when the stale buffer is taller but mostly empty', () => {
    // The realistic shape right after a split: the pane shrank from 8 rows to 3,
    // and the shell had only a few lines of output, so the stale buffer's tail
    // is blank. Clipping to the literal bottom rows rendered an entirely empty
    // pane until the re-capture landed — tmux still had the text the whole time.
    const content: PaneContent = [
      ...createContent(['$ echo hi', 'hi', '$']),
      ...Array.from({ length: 5 }, () => [] as CellLine),
    ];
    render(<Terminal content={content} height={3} cursorY={2} cursorX={2} isActive />);

    const pre = screen.getByTestId('terminal').querySelector('.terminal-content');
    expect(pre?.textContent).toContain('echo hi');
    expect(pre?.textContent).toContain('hi');
  });

  it('renders cursor at correct position', () => {
    const content = createContent(['test line here']);
    render(<Terminal content={content} cursorX={5} cursorY={0} isActive={true} />);

    const cursor = document.querySelector('.terminal-cursor');
    expect(cursor).toBeInTheDocument();
    expect(cursor).toHaveAttribute('data-cursor-x', '5');
    expect(cursor).toHaveAttribute('data-cursor-y', '0');
  });

  it('draws no cursor for a pane without the keyboard, even when tmux reports a mode on it', () => {
    // The dock lives in another window and can carry a stale or out-of-band
    // mode flag; drawing its copy cursor (resting at 0,0) showed a ghost box
    // in its first row.
    const content = createContent(['hello world']);
    render(<Terminal content={content} cursorX={3} cursorY={0} isActive={false} inMode={true} />);
    expect(document.querySelector('.terminal-cursor')).toBeNull();
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

  it('places the cursor on the cell grid, not inside the line text', () => {
    // The cursor used to be spliced into a style group's text, so its position
    // came from the natural advance of the preceding glyphs. It must instead be
    // an overlay addressed in cell units.
    const content = createContent(['hello world']);
    render(<Terminal content={content} cursorX={6} cursorY={0} isActive />);

    const terminal = screen.getByTestId('terminal');
    const cursor = terminal.querySelector('.terminal-cursor') as HTMLElement;
    expect(cursor).toBeInTheDocument();
    // Never a descendant of a rendered line.
    expect(cursor.closest('.terminal-line')).toBeNull();
    // Positioned in grid units (--cell-w), so glyph advance can't shift it.
    expect(cursor.style.left).toBe(cellsToCss(6));
    expect(cursor.style.width).toBe(cellsToCss(1));
    expect(cursor.textContent).toBe('w');
  });

  it('indexes the cursor character by CELL, not by UTF-16 offset', () => {
    // A cell can hold more than one code unit — here U+2764 U+FE0F ("❤️") is a
    // single column but two UTF-16 units. Slicing the line's joined text by
    // cursorX put the cursor a cell to the left for the rest of the line, and
    // at column 1 it landed on the invisible variation selector, making the
    // cursor disappear.
    const content: PaneContent = [[{ c: '❤️' }, { c: 'B' }, { c: 'C' }, { c: 'D' }, { c: 'E' }]];
    render(<Terminal content={content} cursorX={1} cursorY={0} isActive />);

    const cursor = screen.getByTestId('terminal').querySelector('.terminal-cursor') as HTMLElement;
    // Cell 1 is 'B' — not U+FE0F, and not 'C'.
    expect(cursor.textContent).toBe('B');
    expect(cursor.style.left).toBe(cellsToCss(1));
  });

  it('keeps the cursor on the grid past a multi-code-unit cell', () => {
    // 'é' as e + U+0301 is one column but two code units. Every column after it
    // used to be off by one.
    const content: PaneContent = [
      [{ c: 'é' }, { c: 'B' }, { c: 'C' }, { c: 'D' }, { c: 'E' }, { c: 'F' }],
    ];
    render(<Terminal content={content} cursorX={5} cursorY={0} isActive />);

    const cursor = screen.getByTestId('terminal').querySelector('.terminal-cursor') as HTMLElement;
    expect(cursor.textContent).toBe('F');
    expect(cursor.style.left).toBe(cellsToCss(5));
  });

  it('renders a cursor past the end of the line without padding spans', () => {
    // End-of-line cursor (the common case at a shell prompt): the overlay is
    // placed by column, so no run of padding spaces is needed to push it there.
    const content = createContent(['ab']);
    render(<Terminal content={content} cursorX={5} cursorY={0} isActive />);

    const terminal = screen.getByTestId('terminal');
    const cursor = terminal.querySelector('.terminal-cursor') as HTMLElement;
    expect(cursor.style.left).toBe(cellsToCss(5));
    expect(cursor.textContent).toBe(' ');
    expect(terminal.querySelector('.terminal-line')?.textContent).toBe('ab');
  });

  it('anchors auto-detected URLs by cell, not by UTF-16 offset', () => {
    // detectUrls reports offsets into the line's joined text. A leading cell
    // holding two code units shifted every later cell's offset by one, so the
    // link span started and ended a cell early.
    const url = 'https://example.com';
    const content: PaneContent = [[{ c: '❤️' }, { c: ' ' }, ...url.split('').map((c) => ({ c }))]];
    render(<Terminal content={content} />);

    const link = screen.getByTestId('terminal').querySelector('a.terminal-autolink');
    expect(link).toBeInTheDocument();
    expect(link?.textContent).toBe(url);
    expect(link).toHaveAttribute('href', url);
  });

  it('sizes each span to an exact cell count so glyph width never shifts the line', () => {
    // Anti-jitter: spans are pinned to `n * --cell-w` (the snapped cell width) so
    // a symbol whose glyph is wider/narrower than a cell can't push the rest of
    // the line when it changes (e.g. a spinner animation).
    const content = createContent(['hello world']);
    render(<Terminal content={content} />);

    const spans = screen.getByTestId('terminal').querySelectorAll('.terminal-line > span');
    const widthSpan = Array.from(spans).find((s) => s.textContent === 'hello world');
    expect(widthSpan).toBeDefined();
    // 'hello world' is 11 characters → 11 cells wide.
    expect((widthSpan as HTMLElement).style.width).toBe(cellsToCss(11));
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
    expect(wideSpan!.style.width).toBe(cellsToCss(1));
    // It must not have been merged with the neighbouring 'a' or trailing text.
    expect(spans.some((s) => s.textContent === 'a中')).toBe(false);
    expect(spans.some((s) => s.textContent?.includes('中 '))).toBe(false);
  });

  it('positions image placements in real cell units', () => {
    // These used to reference --cell-width / --cell-height, which are defined
    // nowhere, so every calc() resolved to 0 and images rendered 0x0 pinned to
    // the pane's top-left corner. Assert on units that actually exist.
    const content = createContent(['x']);
    render(
      <Terminal
        content={content}
        paneId="%0"
        images={[{ id: 1, row: 3, col: 5, widthCells: 10, heightCells: 4, protocol: 'iterm2' }]}
      />,
    );

    const img = screen.getByTestId('terminal').querySelector('img.terminal-image') as HTMLElement;
    expect(img).toBeInTheDocument();
    expect(img.style.left).toBe(cellsToCss(5));
    expect(img.style.width).toBe(cellsToCss(10));
    expect(img.style.top).toBe('calc(3 * var(--line-height-terminal))');
    expect(img.style.height).toBe('calc(4 * var(--line-height-terminal))');
  });

  it('sets aria-live to off to avoid flooding screen readers', () => {
    const content = createContent(['Hello World', 'Line 2']);
    render(<Terminal content={content} />);

    const terminal = screen.getByTestId('terminal');
    expect(terminal).toHaveAttribute('aria-live', 'off');
  });
});
