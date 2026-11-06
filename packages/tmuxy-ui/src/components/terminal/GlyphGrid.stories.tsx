import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { TerminalLine } from './TerminalLine';
import type { CellLine } from '../../domain/wireCells';
import { CellGridDecorator } from '../../stories/cellGrid';
import { cellGridReady, cellWidthOf } from '../../stories/cellGridHelpers';

/**
 * One row, every kind of glyph that does not fit its cell: the ASCII text
 * after them all has to start on the cell tmux counted.
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
 * Measured with ranges over the row's characters, not spans, so it holds
 * however the renderer groups runs. A range measures ADVANCE; the ink case is
 * `TerminalLine`'s `FatInkIcon` story. The fonts are the bundled webfont
 * (src/fonts), so every probe machine measures the same.
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

/** As the backend sends it: one entry per tmux cell, a wide glyph plus its blank continuation. */
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

/** `[from, to)` in code points, which is one per cell here. */
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

/** glyphFit's own threshold: a one-column glyph fatter than this was not corrected. */
const FAT_THRESHOLD = 1.15;

export const EveryOversizedGlyphOnOneRow: Story = {
  args: { line: ROW.line },
  play: async ({ canvasElement }) => {
    await cellGridReady();
    const grid = canvasElement.querySelector('.terminal-container') as HTMLElement;
    const cellW = cellWidthOf(grid);
    const line = canvasElement.querySelector('.terminal-line') as HTMLElement;

    // A canvas never fetches a face itself: load the faces these glyphs need,
    // so the component and this play function measure the same typeface.
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

        expect({ glyph: glyph.name, onItsCell: Math.abs(start - cell) < TOLERANCE }).toEqual({
          glyph: glyph.name,
          onItsCell: true,
        });

        if (glyph.cols === 1) {
          expect({ glyph: glyph.name, fitsItsCell: advance <= FAT_THRESHOLD }).toEqual({
            glyph: glyph.name,
            fitsItsCell: true,
          });
        } else {
          // Drawn at full size into its continuation cell, not squeezed into one.
          expect({ glyph: glyph.name, wide: advance > 1.2 && advance < 3 }).toEqual({
            glyph: glyph.name,
            wide: true,
          });
        }
      }

      const marker = rectForCells(line, ROW.markerAt, ROW.markerAt + MARKER.length);
      expect(Math.abs((marker.left - left) / cellW - ROW.markerAt)).toBeLessThan(TOLERANCE);
      expect(Math.abs(marker.width / cellW - MARKER.length)).toBeLessThan(TOLERANCE);
    });

    const fitted = [...canvasElement.querySelectorAll<HTMLElement>('.terminal-fit-glyph')];
    for (const el of fitted) {
      const scale = Number(getComputedStyle(el).getPropertyValue('--glyph-fit'));
      expect(scale).toBeGreaterThan(0);
      expect(scale).toBeLessThan(1);
    }
  },
};
