/**
 * The live screen (TerminalLine) and the scroll view (renderLineToDOM) paint
 * a row the same way: both take its runs from `cellPaint`. The scroll view
 * used to keep its own copy, which had drifted — no block glyphs, and a
 * selected link lost its link class.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalLine } from '../TerminalLine';
import { renderLineToDOM } from '../terminalRendering';
import type { CellLine } from '../../../domain/wireCells';

const URL = 'https://example.com/osc';
const line = [
  ...[...'LINK'].map((c) => ({ c, s: { url: URL } })),
  { c: ' ' },
  ...[...'▀▀'].map((c) => ({ c, s: { fg: 1 } })),
] satisfies CellLine;
const selection = { startCol: 0, endCol: 1 };

function live(): HTMLElement {
  return render(<TerminalLine line={line} selectionRange={selection} />).container;
}

function scrollView(): HTMLElement {
  const row = document.createElement('div');
  renderLineToDOM(row, line, selection);
  return row;
}

/** What a row's painted runs are: tag, classes, text and the inline styles that tell them apart. */
function runs(root: HTMLElement) {
  const row = root.querySelector('.terminal-line') ?? root;
  return [...row.children].map((el) => {
    const node = el as HTMLElement;
    return {
      tag: node.tagName,
      className: node.className,
      text: node.textContent,
      href: node.getAttribute('href'),
      width: node.style.width,
      color: node.style.color,
      backgroundImage: node.style.backgroundImage !== '',
    };
  });
}

describe('one painter for both renderers', () => {
  it('paints links, a selected link, and block glyphs the same way', () => {
    const painted = runs(live());
    expect(runs(scrollView())).toEqual(painted);
    expect(painted[0]).toMatchObject({
      tag: 'A',
      className: 'terminal-hyperlink terminal-selected',
      text: 'LI',
      href: URL,
    });
    expect(painted[1]).toMatchObject({ tag: 'A', className: 'terminal-hyperlink', text: 'NK' });
    expect(painted[painted.length - 1]).toMatchObject({
      backgroundImage: true,
      color: 'transparent',
    });

    // Both the live screen and the scrollback DOM renderer open links through
    // openLinkFrom (window.open on web) rather than native anchor navigation.
    const opened: string[] = [];
    const origOpen = window.open;
    window.open = ((url: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
    try {
      const liveAnchor = live().querySelector('a.terminal-hyperlink') as HTMLAnchorElement;
      const scrollAnchor = scrollView().querySelector('a.terminal-hyperlink') as HTMLAnchorElement;
      expect(liveAnchor.tabIndex).toBe(-1);
      expect(scrollAnchor.tabIndex).toBe(-1);
      liveAnchor.click();
      scrollAnchor.click();
      expect(opened).toEqual([URL, URL]);
    } finally {
      window.open = origOpen;
    }
  });
});

describe('a run of glyphs that tile', () => {
  it('shares one fitted box, so a braille graph is not a span per cell', async () => {
    vi.resetModules();
    vi.doMock('../glyphFit', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../glyphFit')>()),
      glyphFit: (s: string) => (s === '⎿' || /[\u2800-\u28ff]/.test(s) ? 0.9 : null),
    }));
    const { cellRuns, rowUrlIndex } = await import('../cellPaint');
    const row = [...'⣿⣀⣿⣀⣿⣀', '⎿', '⎿'].map((c) => ({ c })) satisfies CellLine;
    const runs = cellRuns(row, null, rowUrlIndex(row, []));
    // One run for the six braille cells; each fat symbol keeps a box of its own.
    expect(runs.map((r) => [r.text, r.cells])).toEqual([
      ['⣿⣀⣿⣀⣿⣀', 6],
      ['⎿', 1],
      ['⎿', 1],
    ]);
    vi.doUnmock('../glyphFit');
  });
});
