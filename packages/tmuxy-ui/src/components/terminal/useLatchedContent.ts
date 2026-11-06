/**
 * useLatchedContent — hold a pane's last real grid across a transient empty one.
 *
 * A pane's content briefly becomes an EMPTY ARRAY — no rows at all — while a
 * capture refresh is in flight: a resize, a window move, and above all the
 * `swap-pane` a pane-group switch does. Rendering that frame draws an empty
 * terminal for a tick and the content then returns, which is the flicker
 * switching between members of a pane group produced.
 *
 * "Not captured yet" is `notCapturedYet` (domain/deltaProtocol.ts), the rule
 * the state merge and the widget classification apply too, so holding the
 * last grid until a real one arrives cannot hide a legitimate clear.
 */

import { useRef } from 'react';
import type { PaneContent } from '../../domain/wireCells';
import { notCapturedYet } from '../../domain/deltaProtocol';

const EMPTY: PaneContent = [];

export function useLatchedContent(content: PaneContent | undefined): PaneContent {
  const lastRef = useRef<PaneContent>(EMPTY);
  if (content && !notCapturedYet(content)) {
    lastRef.current = content;
  }
  return lastRef.current;
}
