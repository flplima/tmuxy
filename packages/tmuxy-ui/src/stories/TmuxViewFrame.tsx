/**
 * The frame the "tmux view" decorator (tmuxView.tsx) wraps a story in: the
 * story, and the guest's VGA console (vgaMirror.ts) beside it or over it.
 */

import type { CSSProperties, ReactNode } from 'react';
import { VgaMirror } from './vgaMirror';
import type { TmuxViewMode } from './tmuxView';
import { useGridBox } from './gridBox';
import './tmuxView.css';

/** The tmux window side mode shows, small enough for the 80x25 VGA console beside it. */
const SIDE_COLS = 64;
const SIDE_ROWS = 20;

function VgaPanel({ mode }: { mode: Exclude<TmuxViewMode, 'off'> }) {
  const ref = (el: HTMLDivElement | null) => {
    if (!el) return;
    const mirror = new VgaMirror();
    mirror.mount(el, mode === 'overlay' ? { alignTo: el.parentElement ?? undefined } : {});
    return () => mirror.unmount();
  };
  return (
    <div ref={ref} className="tmux-view-panel" data-mode={mode}>
      <div className="tmux-view-label">tmux · VGA console (read-only client)</div>
    </div>
  );
}

export function TmuxViewFrame({ mode, children }: { mode: TmuxViewMode; children: ReactNode }) {
  const box = useGridBox(SIDE_COLS, SIDE_ROWS);
  if (mode === 'off') return <>{children}</>;
  const style = {
    '--tmux-view-cols': SIDE_COLS,
    '--tmux-view-rows': SIDE_ROWS,
    ...(box && {
      '--tmux-view-story-width': `${box.width}px`,
      '--tmux-view-story-height': `${box.height}px`,
    }),
  } as CSSProperties;
  return (
    <div className="tmux-view" data-mode={mode} style={style}>
      <div className="tmux-view-story">{children}</div>
      <VgaPanel mode={mode} />
    </div>
  );
}
