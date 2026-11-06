/**
 * A selected cell is the selection's colour pair, whatever it was drawn in:
 * neither renderer leaves a cell's own foreground, background, reverse video
 * or dim on it once it is selected, so `.terminal-selected` (the theme's
 * foreground on the selection wash, styles/terminal.css) is what shows. Its
 * weight, slant and link stay. The live screen renders through TerminalLine,
 * copy mode's rows through renderLineToDOM; both are held to the same rule.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalLine } from '../TerminalLine';
import { renderLineToDOM } from '../terminalRendering';
import type { CellLine } from '../../../domain/wireCells';

const RED = 1;
const GREEN = 2;

/** Red on green, bold, reverse video and dim, then one plain cell. */
const line = [
  ...[...'HOT'].map((c) => ({
    c,
    s: { fg: RED, bg: GREEN, bold: true, inverse: true, dim: true },
  })),
  { c: 'x' },
] satisfies CellLine;

function selectedSpans(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.terminal-selected')];
}

function expectSelectionColours(root: HTMLElement) {
  const hot = selectedSpans(root).find((el) => el.textContent === 'HOT');
  expect(hot).toBeDefined();
  expect(hot!.style.color).toBe('');
  expect(hot!.style.backgroundColor).toBe('');
  expect(hot!.style.opacity).toBe('');
  expect(hot!.style.fontWeight).toBe('bold');
}

function expectOwnColours(root: HTMLElement) {
  expect(selectedSpans(root)).toHaveLength(0);
  const hot = [...root.querySelectorAll<HTMLElement>('span')].find(
    (el) => el.textContent === 'HOT',
  );
  expect(hot!.style.color).not.toBe('');
  expect(hot!.style.backgroundColor).not.toBe('');
}

describe('a selected cell wears the selection’s colours, not its own', () => {
  it('on the live screen (TerminalLine)', () => {
    const { container, rerender } = render(<TerminalLine line={line} selectionRange={null} />);
    expectOwnColours(container);
    rerender(<TerminalLine line={line} selectionRange={{ startCol: 0, endCol: 2 }} />);
    expectSelectionColours(container);
  });

  it('in copy mode (renderLineToDOM)', () => {
    const row = document.createElement('div');
    renderLineToDOM(row, line, null);
    expectOwnColours(row);
    renderLineToDOM(row, line, { startCol: 0, endCol: 2 });
    expectSelectionColours(row);
  });
});
