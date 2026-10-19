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
 * unchanged. The frame itself is TmuxViewFrame.tsx.
 */

import type { Decorator } from '@storybook/react-vite';
import { TmuxViewFrame } from './TmuxViewFrame';

export type TmuxViewMode = 'off' | 'side' | 'overlay';

export const withTmuxView: Decorator = (Story, context) => {
  const mode = (context.globals.tmuxView as TmuxViewMode | undefined) ?? 'off';
  return (
    <TmuxViewFrame mode={mode}>
      <Story />
    </TmuxViewFrame>
  );
};
