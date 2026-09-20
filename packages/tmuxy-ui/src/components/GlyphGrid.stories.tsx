import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { TerminalLine } from './TerminalLine';
import type { CellLine } from '../tmux/types';
import { CellGridDecorator, cellGridReady, cellWidthOf } from '../stories/cellGrid';

/**
 * One row, every kind of glyph that does not fit its cell.
 *
 * `TerminalLine.stories` asserts the two shrink-to-fit cases one at a time.
 * This is the other half of the contract, and the half a user would notice
 * first: with all of them on ONE row, the ASCII text after them has to start
 * on the cell tmux counted — because the failure of any of them is the same
 * failure, a line that quietly runs long and no longer lines up with anything.
 *
 * The cases, and why each is here:
 *
 * | Glyph | Columns | How it breaks a row                                   |
 * | ----- | ------- | ----------------------------------------------------- |
 * | ơ ș   | 1       | A monospace font is monospace only for the glyphs it   |
 * |       |         | HAS. Latin Extended is usually a fallback face at its  |
 * |       |         | own advance, so a Vietnamese or Romanian line runs     |
 * |       |         | long — and the letters look ordinary, so nobody looks  |
 * |       |         | at them.                                               |
 * | ⎿     | 1       | Fat by ADVANCE (~1.6 cells in FiraCode Nerd Font):     |
 * |       |         | pushes everything after it along.                      |
 * | icon  | 1       | Fat by INK: advances exactly one cell, then paints a   |
 * |       |         | third of a cell past it, over its neighbour.           |
 * | 你    | 2       | Wide: one cell of box, two cells of glyph, and the     |
 * | 😀    | 2       | blank continuation cell tmux sends beside it.          |
 *
 * Measured with ranges over the row's own characters rather than over spans,
 * because grouping is an implementation detail: the renderer breaks a run
 * wherever a glyph needs its own box, and this has to hold whatever it
 * decides. A range measures ADVANCE — the ink case is asserted by
 * `TerminalLine`'s `FatInkIcon` story, with a canvas.
 *
 * The fonts are the bundled webfont (src/fonts), so this runs the same way on
 * every machine the deterministic probe runs on.
 */
const meta: Meta<typeof TerminalLine> = {
  title: 'Components/GlyphGrid',
  component: TerminalLine,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <CellGridDecorator style={{ width: 640, padding: 12 }}>
        <pre className="terminal-content">
          <Story />
        </pre>
      </CellGridDecorator>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof TerminalLine>;

/** A Nerd Font branch icon — private-use area, so no fallback font has it. */
const ICON = '';

const GLYPHS: Array<{ c: string; cols: 1 | 2; name: string }> = [
  { c: 'ơ', cols: 1, name: 'ơ (Vietnamese)' },
  { c: 'ș', cols: 1, name: 'ș (Romanian)' },
  { c: '⎿', cols: 1, name: '⎿ (fat advance)' },
  { c: ICON, cols: 1, name: 'Nerd Font icon' },
  { c: '你', cols: 2, name: '你 (CJK)' },
  { c: '\u{1f600}', cols: 2, name: '😀 (emoji)' },
];

const MARKER = 'END_OF_ROW';

/**
 * The row as the backend sends it: one entry per tmux CELL, so a wide glyph is
 * its character plus the blank continuation cell beside it, and an entry's
 * index in this array IS its column.
 */
function buildRow(): { line: CellLine; at: Map<string, number>; markerAt: number } {
  const line: CellLine = [];
  const at = new Map<string, number>();
  for (const glyph of GLYPHS) {
    at.set(glyph.c, line.length);
    line.push({ c: glyph.c });
    if (glyph.cols === 2) line.push({ c: ' ' });
    line.push({ c: ' ' });
  }
  const markerAt = line.length;
  for (const ch of MARKER) line.push({ c: ch });
  return { line, at, markerAt };
}

const ROW = buildRow();

/**
 * The rectangle the row's own characters `[from, to)` are laid out in, counted
 * in code points — which is one per cell, wide glyphs included.
 */
function rectForCells(line: HTMLElement, from: number, to: number): DOMRect {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  let placedStart = false;
  let placedEnd = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    let offset = 0;
    for (const ch of text) {
      if (seen === from) {
        range.setStart(node, offset);
        placedStart = true;
      }
      if (seen === to) {
        range.setEnd(node, offset);
        placedEnd = true;
      }
      seen += 1;
      offset += ch.length;
    }
    if (!placedEnd && seen === to) {
      range.setEnd(node, offset);
      placedEnd = true;
    }
  }
  if (!placedStart || !placedEnd) {
    throw new Error(`the row has no cells ${from}..${to} (it has ${seen})`);
  }
  return range.getBoundingClientRect();
}

/** Cell boxes are pinned to whole cells; allow a sixth of a cell of rounding. */
const TOLERANCE = 0.15;

/**
 * Above this ratio `glyphFit` shrinks a one-column glyph into its cell, so a
 * one-column glyph measuring fatter than this was NOT corrected.
 */
const FAT_THRESHOLD = 1.15;

export const EveryOversizedGlyphOnOneRow: Story = {
  args: { line: ROW.line },
  play: async ({ canvasElement }) => {
    await cellGridReady();
    const grid = canvasElement.querySelector('.terminal-container') as HTMLElement;
    const cellW = cellWidthOf(grid);
    const line = canvasElement.querySelector('.terminal-line') as HTMLElement;

    // The component and this play function have to be looking at the same
    // typeface. A canvas never fetches a face itself, so ask the document for
    // the ones these glyphs need and let the fit cache invalidate before
    // measuring anything.
    const style = getComputedStyle(grid.querySelector('.terminal-content')!);
    const font =
      style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    await Promise.all(GLYPHS.map((g) => document.fonts.load(font, g.c).catch(() => [])));
    await document.fonts.ready;

    // A face landing clears the fit cache and re-renders the row, so the
    // corrected layout may still be a render away.
    await waitFor(() => {
      const left = line.getBoundingClientRect().left;

      for (const glyph of GLYPHS) {
        const cell = ROW.at.get(glyph.c)!;
        const r = rectForCells(line, cell, cell + 1);
        const start = (r.left - left) / cellW;
        const advance = r.width / cellW;

        // It starts on its own column: nothing before it moved the row.
        expect({ glyph: glyph.name, onItsCell: Math.abs(start - cell) < TOLERANCE }).toEqual({
          glyph: glyph.name,
          onItsCell: true,
        });

        if (glyph.cols === 1) {
          // One column means one cell of room. A glyph too fat for it is
          // shrunk (utils/glyphFit); one that was not shrunk is drawn over
          // the run beside it and pushes the rest of the row along.
          expect({ glyph: glyph.name, fitsItsCell: advance <= FAT_THRESHOLD }).toEqual({
            glyph: glyph.name,
            fitsItsCell: true,
          });
        } else {
          // Two columns: the glyph is drawn at full size, spilling into the
          // continuation cell tmux sent beside it — not squeezed into one.
          expect({ glyph: glyph.name, wide: advance > 1.2 && advance < 3 }).toEqual({
            glyph: glyph.name,
            wide: true,
          });
        }
      }

      // The row's own verdict: the ASCII after all of that starts on the cell
      // tmux counted, and takes exactly one cell per character.
      const marker = rectForCells(line, ROW.markerAt, ROW.markerAt + MARKER.length);
      expect(Math.abs((marker.left - left) / cellW - ROW.markerAt)).toBeLessThan(TOLERANCE);
      expect(Math.abs(marker.width / cellW - MARKER.length)).toBeLessThan(TOLERANCE);
    });

    // Whatever the renderer decided to shrink, it shrank by a real amount:
    // a `.terminal-fit` box with a scale of 1 corrects nothing.
    const fitted = [...canvasElement.querySelectorAll<HTMLElement>('.terminal-fit-glyph')];
    for (const el of fitted) {
      const scale = Number(getComputedStyle(el).getPropertyValue('--glyph-fit'));
      expect(scale).toBeGreaterThan(0);
      expect(scale).toBeLessThan(1);
    }
  },
};
