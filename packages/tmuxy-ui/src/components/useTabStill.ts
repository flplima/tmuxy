/**
 * A still of every pane, re-taken once a second: followed live, a tab that
 * keeps printing churns its picture on every frame; frozen on open, the
 * picture goes stale while you look. Null while not sampling, the caller's cue
 * to draw the live panes.
 */

import { useEffect, useRef, useState } from 'react';
import type { TmuxPane } from '../domain/client';

const TAB_STILL_REFRESH_MS = 1000;

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
