/**
 * A still of every pane, re-taken once a second.
 *
 * Both places that draw a picture of a tab — the Tab Overview's cards and the
 * hover preview — want the same compromise. Following the live panes makes a
 * tab that keeps printing churn its thumbnail on every frame of output, which
 * is unreadable and expensive; freezing them the moment the picture opens
 * makes it go stale while you are looking at it. Once a second is slow enough
 * to read and fast enough to be true.
 *
 * Returns null while it is not sampling, which is the caller's cue to draw
 * the live panes (nothing is being watched, so nothing can churn).
 */

import { useEffect, useRef, useState } from 'react';
import type { TmuxPane } from '../machines/types';

/** How often a tab picture re-reads the panes behind it. */
export const TAB_STILL_REFRESH_MS = 1000;

export function useTabStill(
  panes: readonly TmuxPane[],
  live: boolean,
): Record<string, TmuxPane> | null {
  // The interval must read the CURRENT panes without re-arming on every
  // model update, which would reset the clock and never let it fire.
  const latest = useRef(panes);
  latest.current = panes;
  const [still, setStill] = useState<Record<string, TmuxPane> | null>(null);

  useEffect(() => {
    if (!live) {
      setStill(null);
      return;
    }
    const take = () =>
      setStill(Object.fromEntries(latest.current.map((p) => [p.tmuxId, p] as const)));
    take();
    const timer = setInterval(take, TAB_STILL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live]);

  return still;
}
