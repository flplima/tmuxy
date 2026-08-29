/**
 * "tmux view" toolbar decorator for v86 stories: shows the raw tmux TUI (the
 * guest's VGA console, see vgaMirror.ts) next to — or over — the tmuxy
 * rendering. Driven by the `tmuxView` global (.storybook/preview.ts):
 *
 *   off      story only
 *   side     story on the left, tmux's own rendering on the right
 *   overlay  tmux's rendering translucently on top of the story, cell-aligned,
 *            so any drift between the two grids shows as a doubled glyph
 *
 * Only meaningful for stories on the shared v86 engine (Scenarios/Application);
 * elsewhere there is no guest to look at and the decorator renders the story
 * unchanged.
 */

import type { Decorator } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { VgaMirror } from './vgaMirror';
import './tmuxView.css';

export type TmuxViewMode = 'off' | 'side' | 'overlay';

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

function TmuxViewFrame({ mode, children }: { mode: TmuxViewMode; children: ReactNode }) {
  if (mode === 'off') return <>{children}</>;
  return (
    <div className="tmux-view" data-mode={mode}>
      <div className="tmux-view-story">{children}</div>
      <VgaPanel mode={mode} />
    </div>
  );
}

export const withTmuxView: Decorator = (Story, context) => {
  const mode = (context.globals.tmuxView as TmuxViewMode | undefined) ?? 'off';
  return (
    <TmuxViewFrame mode={mode}>
      <Story />
    </TmuxViewFrame>
  );
};
