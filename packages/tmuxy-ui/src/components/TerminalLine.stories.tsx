import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { TerminalLine } from './TerminalLine';
import type { CellLine } from '../tmux/types';
import { CellGridDecorator, cellGridReady, cellWidthOf, runCells } from '../stories/cellGrid';

const meta: Meta<typeof TerminalLine> = {
  title: 'Components/TerminalLine',
  component: TerminalLine,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <CellGridDecorator style={{ width: 600, padding: 12 }}>
        <pre className="terminal-content">
          <Story />
        </pre>
      </CellGridDecorator>
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

/**
 * A wide character as the backend emits it: the character in one cell plus a
 * blank continuation cell, so the line's cell count already covers both
 * columns. `c` may be several code units (emoji + VS16, ZWJ sequences).
 */
function wide(c: string): CellLine {
  return [{ c }, { c: ' ' }];
}

/** Boxes are pinned to whole cells; allow a quarter-pixel of rounding. */
const CELL_TOLERANCE = 0.05;

function spanWithText(canvasElement: HTMLElement, needle: string): HTMLElement {
  const spans = Array.from(canvasElement.querySelectorAll<HTMLElement>('.terminal-line > span'));
  const el = spans.find((s) => s.textContent === needle);
  if (!el) throw new Error(`no span with text ${JSON.stringify(needle)}`);
  return el;
}

function grid(canvasElement: HTMLElement): HTMLElement {
  return canvasElement.querySelector('.terminal-container') as HTMLElement;
}

export const Plain: Story = {
  args: {
    line: text('$ ls -la /home/user'),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/ls -la \/home\/user/)).toBeInTheDocument();
    // The cursor is a Terminal-level overlay — a line never renders one.
    expect(canvasElement.querySelector('.terminal-cursor')).toBeNull();
  },
};

export const Styled: Story = {
  args: {
    line: [
      ...styled('error: ', { fg: 1, bold: true }),
      ...text('something went wrong on '),
      ...styled('main.rs:42', { underline: true, fg: 4 }),
    ],
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
    selectionRange: { startCol: 4, endCol: 14 },
  },
  play: async ({ canvasElement }) => {
    // At least one span should carry the selection highlight class.
    const selected = canvasElement.querySelectorAll('.terminal-selected');
    expect(selected.length).toBeGreaterThan(0);
  },
};

// ---------------------------------------------------------------------------
// Cell grid: text advance is snapped to --cell-w
// ---------------------------------------------------------------------------

export const SnappedAdvance: Story = {
  args: {
    line: [...text('abcdefghij'), ...styled('KLMNOPQRST', { bold: true }), ...text('0123456789')],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Every run advances by exactly the snapped cell width: the glyph ink of a 10-character run is 10 cells wide (letter-spacing pads the natural advance up to --cell-w), so a run starting at cell 20 starts exactly 20 cell widths in — even for bold, whose glyphs advance differently in many fonts.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await cellGridReady();
    const cellW = cellWidthOf(grid(canvasElement));
    expect(cellW).toBeGreaterThan(0);
    // The snapped width is a whole number of device pixels.
    expect(Math.round(cellW * devicePixelRatio)).toBeCloseTo(cellW * devicePixelRatio, 3);

    const first = runCells(spanWithText(canvasElement, 'abcdefghij'), cellW);
    const bold = runCells(spanWithText(canvasElement, 'KLMNOPQRST'), cellW);
    const last = runCells(spanWithText(canvasElement, '0123456789'), cellW);

    expect(first.start).toBeCloseTo(0, 1);
    expect(first.box).toBeCloseTo(10, 1);
    // Glyph advance == box: the text really does advance one cell per char.
    expect(Math.abs(first.ink - 10)).toBeLessThan(CELL_TOLERANCE);
    expect(bold.start).toBeCloseTo(10, 1);
    expect(last.start).toBeCloseTo(20, 1);
    expect(Math.abs(last.ink - 10)).toBeLessThan(CELL_TOLERANCE);
  },
};

// ---------------------------------------------------------------------------
// Wide characters: one glyph, two columns
// ---------------------------------------------------------------------------

export const WideCJK: Story = {
  args: {
    line: [...text('a'), ...wide('中'), ...wide('文'), ...text('b END')],
  },
  parameters: {
    docs: {
      description: {
        story:
          '"a中文b END" — each CJK ideograph owns a 1-cell box but its glyph advances ~2 cells, spilling into the blank continuation cell the backend emits. The ASCII after it must sit on the exact cells the backend says: "b" is cell 5.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await cellGridReady();
    const cellW = cellWidthOf(grid(canvasElement));

    const zhong = runCells(spanWithText(canvasElement, '中'), cellW);
    const wen = runCells(spanWithText(canvasElement, '文'), cellW);
    // The continuation cell of 文 (cell 4) groups with the ASCII that follows.
    const tail = runCells(spanWithText(canvasElement, ' b END'), cellW);

    // Own 1-cell box at its own column…
    expect(zhong.start).toBeCloseTo(1, 1);
    expect(zhong.box).toBeCloseTo(1, 1);
    // …painted as a double-width glyph (ink spills into the continuation cell).
    expect(zhong.ink).toBeGreaterThan(1.5);
    expect(zhong.ink).toBeLessThan(2.5);
    expect(wen.start).toBeCloseTo(3, 1);
    // The text after the wide run is back on the grid, not pushed by the glyphs.
    expect(tail.start).toBeCloseTo(4, 1);
    expect(tail.box).toBeCloseTo(6, 1);
  },
};

export const WideEmoji: Story = {
  args: {
    line: [...text('ok '), ...wide('😀'), ...wide('🟥'), ...text(' done')],
  },
  parameters: {
    docs: {
      description: {
        story:
          '"ok 😀🟥 done" — emoji come from a colour fallback font whose advance is unrelated to the monospace cell. Each is isolated in a 1-cell box so its oversize glyph overflows into the continuation cell and "done" still starts at cell 7.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await cellGridReady();
    const cellW = cellWidthOf(grid(canvasElement));

    const grin = runCells(spanWithText(canvasElement, '😀'), cellW);
    const square = runCells(spanWithText(canvasElement, '🟥'), cellW);
    const tail = runCells(spanWithText(canvasElement, '  done'), cellW);

    expect(grin.start).toBeCloseTo(3, 1);
    expect(grin.box).toBeCloseTo(1, 1);
    expect(grin.ink).toBeGreaterThan(1.2);
    expect(square.start).toBeCloseTo(5, 1);
    // 🟥's continuation cell (6) + " done": the run sits at cell 6, 6 cells wide.
    expect(tail.start).toBeCloseTo(6, 1);
    expect(tail.box).toBeCloseTo(6, 1);
  },
};

export const EmojiSequences: Story = {
  args: {
    // ❤️ = U+2764 U+FE0F (text symbol forced to emoji presentation),
    // 👩‍💻 = woman + ZWJ + laptop, 👍🏽 = thumbs up + skin-tone modifier,
    // 🇺🇸 = two regional indicators (one flag).
    line: [...text('x'), ...wide('❤️'), ...wide('👩‍💻'), ...wide('👍🏽'), ...wide('🇺🇸'), ...text('y')],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Multi-code-unit cells: a variation selector, a ZWJ sequence, a skin-tone modifier and a regional-indicator flag each stay ONE cell in the data model (plus continuation) and one box on screen, so "y" lands on cell 9 regardless of how many code units precede it.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await cellGridReady();
    const cellW = cellWidthOf(grid(canvasElement));

    const heart = runCells(spanWithText(canvasElement, '❤️'), cellW);
    const coder = runCells(spanWithText(canvasElement, '👩‍💻'), cellW);
    const thumbs = runCells(spanWithText(canvasElement, '👍🏽'), cellW);
    const flag = runCells(spanWithText(canvasElement, '🇺🇸'), cellW);
    const y = runCells(spanWithText(canvasElement, ' y'), cellW);

    expect(heart.start).toBeCloseTo(1, 1);
    expect(heart.box).toBeCloseTo(1, 1);
    expect(coder.start).toBeCloseTo(3, 1);
    expect(coder.box).toBeCloseTo(1, 1);
    // A ZWJ sequence must render as ONE glyph, not woman + laptop side by side
    // (which would be ~4 cells of ink).
    expect(coder.ink).toBeLessThan(3);
    expect(thumbs.start).toBeCloseTo(5, 1);
    // A flag is two regional indicators in ONE cell; it must not be split
    // across two 1-cell boxes (which would draw two letters, not a flag).
    expect(flag.start).toBeCloseTo(7, 1);
    expect(flag.box).toBeCloseTo(1, 1);
    expect(flag.ink).toBeGreaterThan(1.2);
    expect(flag.ink).toBeLessThan(3);
    expect(y.start).toBeCloseTo(8, 1);
    expect(y.box).toBeCloseTo(2, 1);
  },
};

export const FullwidthAndCombining: Story = {
  args: {
    // Ｆｕｌｌ = fullwidth Latin (2 cells each); é = e + U+0301 (1 cell, 2 units).
    line: [
      ...wide('Ｆ'),
      ...wide('ｕ'),
      ...text('|'),
      { c: 'e\u0301', s: { bold: true } },
      ...text('|end'),
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Fullwidth forms are wide (2 cells); a combining mark is narrow (1 cell) even though the cell holds two code units. "|end" starts at cell 6.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await cellGridReady();
    const cellW = cellWidthOf(grid(canvasElement));

    const f = runCells(spanWithText(canvasElement, 'Ｆ'), cellW);
    const acute = runCells(spanWithText(canvasElement, 'é'), cellW);
    const end = runCells(spanWithText(canvasElement, '|end'), cellW);

    expect(f.box).toBeCloseTo(1, 1);
    expect(f.ink).toBeGreaterThan(1.5);
    // Narrow: one cell of box AND of ink, the accent stacks on the base.
    expect(acute.start).toBeCloseTo(5, 1);
    expect(acute.box).toBeCloseTo(1, 1);
    expect(acute.ink).toBeLessThan(1.5);
    expect(end.start).toBeCloseTo(6, 1);
  },
};
