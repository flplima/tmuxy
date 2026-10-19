/**
 * The frame the "tmux view" decorator (tmuxView.tsx) wraps a story in: the
 * story, and the guest's VGA console (vgaMirror.ts) beside it or over it.
 */

import type { ReactNode } from 'react';
import { VgaMirror } from './vgaMirror';
import type { TmuxViewMode } from './tmuxView';
import './tmuxView.css';

function VgaPanel({ mode }: { mode: Exclude<TmuxViewMode, 'off'> }) {
  // Ref callback with cleanup: mounts the mirror when the panel enters the DOM
  // and tears it down (detaches the VGA client, stops painting) when it leaves.
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
  if (mode === 'off') return <>{children}</>;
  return (
    <div className="tmux-view" data-mode={mode}>
      <div className="tmux-view-story">{children}</div>
      <VgaPanel mode={mode} />
    </div>
  );
}
