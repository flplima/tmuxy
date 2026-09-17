/**
 * Classify what a pane is showing — a widget, or a terminal — and hold that
 * classification steady across transient empty content.
 *
 * Shared by every surface that renders a pane body: the tiled `Pane` and the
 * floats. It exists as one hook rather than a `detectWidget` call per caller
 * because of the latch: a pane's content briefly clears while a capture
 * refresh is in flight (resize, window move), and flipping the classification
 * on that gap switches the rendered component TYPE — React unmounts the whole
 * subtree and remounts the other one, a full-pane blink twice over when the
 * content returns. Keys cannot prevent a type switch, so the last definitive
 * classification is held until non-empty content says otherwise.
 *
 * Duplicating that rule per call site is how the surfaces would drift, which
 * is exactly what happened before floats could show widgets at all.
 */

import { useRef } from 'react';
import type { PaneContent } from '../../tmux/types';
import { detectWidget } from './index';

export type PaneWidgetInfo = ReturnType<typeof detectWidget>;

export function usePaneWidgetInfo(content: PaneContent | undefined): PaneWidgetInfo {
  const lastRef = useRef<PaneWidgetInfo>(null);
  if (!content) return lastRef.current;

  if (content.length === 0) return lastRef.current;
  const info = detectWidget(content);
  lastRef.current = info;
  return info;
}
