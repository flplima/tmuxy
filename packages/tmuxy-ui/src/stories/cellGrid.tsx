/**
 * For component stories without the app (TerminalLine, Cursor): there is no
 * size actor to publish `--cell-w` / `--cell-gap`, so this decorator runs the
 * app's own measurement (infra/dom/cellMetrics.ts) on its element.
 */

import { useCallback, type CSSProperties, type ReactNode } from 'react';
import { measureCellMetrics } from '../infra/dom/cellMetrics';

function publish(el: HTMLElement): void {
  const m = measureCellMetrics(el);
  el.style.setProperty('--cell-w', `${m.cellWidth}px`);
  el.style.setProperty('--cell-gap', `${m.cellGap}px`);
}

export function CellGridDecorator({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  // A ref callback runs at commit, before paint — the variables exist for the
  // first frame. The webfont may still be loading then (font-display: swap),
  // so measure again once it has, exactly like the app's size actor does.
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    publish(el);
    document.fonts.ready.then(() => {
      if (el.isConnected) publish(el);
    });
  }, []);
  return (
    <div
      ref={ref}
      className="terminal-container"
      style={{
        background: '#0f0f12',
        color: '#e5e5e5',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
