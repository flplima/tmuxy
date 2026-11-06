/**
 * Holds a pane's last real grid while a capture refresh is in flight (a
 * resize, a window move, the `swap-pane` of a pane-group switch), when its
 * content is briefly empty and drawing it flickers. `notCapturedYet` is the
 * rule the state merge uses too, so a legitimate clear is never hidden.
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
