/**
 * useLatchedContent — hold a pane's last real grid across a transient empty one.
 *
 * A pane's content briefly becomes an EMPTY ARRAY — no rows at all — while a
 * capture refresh is in flight: a resize, a window move, and above all the
 * `swap-pane` a pane-group switch does. Rendering that frame draws an empty
 * terminal for a tick and the content then returns, which is the flicker
 * switching between members of a pane group produced.
 *
 * Zero rows is never a real screen: a screen that has been cleared still has
 * its rows, full of spaces. So "no rows" can only mean "not captured yet", and
 * holding the last grid until a real one arrives cannot hide a legitimate
 * clear. This is the same rule `usePaneWidgetInfo` already applies to the
 * widget-or-terminal classification, for the same reason and the same gap.
 */

import { useRef } from 'react';
import type { PaneContent } from '../tmux/types';

const EMPTY: PaneContent = [];

export function useLatchedContent(content: PaneContent | undefined): PaneContent {
  const lastRef = useRef<PaneContent>(EMPTY);
  if (content && content.length > 0) {
    lastRef.current = content;
  }
  return lastRef.current;
}
