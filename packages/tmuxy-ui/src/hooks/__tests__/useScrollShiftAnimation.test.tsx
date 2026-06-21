import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { useScrollShiftAnimation } from '../useScrollShiftAnimation';
import type { CellLine, PaneContent } from '../../tmux/types';

function line(text: string): CellLine {
  return [...text].map((c) => ({ c }));
}
function grid(...rows: string[]): PaneContent {
  return rows.map(line);
}

const LINE_HEIGHT = 20;

function Harness({ content, enabled }: { content: PaneContent; enabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollShiftAnimation({ content, enabled, lineHeight: LINE_HEIGHT, targetRef: ref });
  return <div data-testid="host" ref={ref} />;
}

const FRAME_A = grid('row0', 'row1', 'row2', 'row3', 'row4', 'row5');

describe('useScrollShiftAnimation', () => {
  it('offsets content to its old position when a scroll shift is detected', () => {
    const { getByTestId, rerender } = render(<Harness content={FRAME_A} enabled />);
    const host = getByTestId('host');
    expect(host.style.transform).toBe('');

    // Log-tail: content moved up by one row (k = -1). The hook starts the new
    // content one row lower (translateY = -k * lineHeight = +20px) so it appears
    // where it came from, then transitions to 0 on the next frame.
    rerender(<Harness content={grid('row1', 'row2', 'row3', 'row4', 'row5', 'row6')} enabled />);
    expect(host.style.transform).toBe('translateY(20px)');
  });

  it('offsets in the opposite direction for scroll-up into history (k = +1)', () => {
    const { getByTestId, rerender } = render(<Harness content={FRAME_A} enabled />);
    const host = getByTestId('host');
    rerender(<Harness content={grid('rowZ', 'row0', 'row1', 'row2', 'row3', 'row4')} enabled />);
    expect(host.style.transform).toBe('translateY(-20px)');
  });

  it('does not animate when the flag is disabled', () => {
    const { getByTestId, rerender } = render(<Harness content={FRAME_A} enabled={false} />);
    const host = getByTestId('host');
    rerender(
      <Harness content={grid('row1', 'row2', 'row3', 'row4', 'row5', 'row6')} enabled={false} />,
    );
    expect(host.style.transform).toBe('');
  });

  it('does not animate a full redraw / big jump', () => {
    const { getByTestId, rerender } = render(<Harness content={FRAME_A} enabled />);
    const host = getByTestId('host');
    rerender(<Harness content={grid('qqqq', 'rrrr', 'ssss', 'tttt', 'uuuu', 'vvvv')} enabled />);
    expect(host.style.transform).toBe('');
  });
});
