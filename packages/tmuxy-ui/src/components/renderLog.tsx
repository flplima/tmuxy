/**
 * `LogProfiler` sits in the JSX of the component it measures, so its body
 * re-runs exactly when the host component's body ran; the log exists only
 * after `enableRenderLog()` was called before the app mounted.
 *
 * React's own <Profiler onRender> over-reports in this tree: it fires for
 * profilers whose whole subtree bailed out (a memo'd pane with zero body runs
 * still produced onRender commits), which would make every budget meaningless.
 */

import type { ReactNode } from 'react';
import { getLog } from './renderLogStore';

const MAX_ENTRIES = 50000;

export function LogProfiler({ id, children }: { id: string; children?: ReactNode }): ReactNode {
  const log = getLog();
  if (log && log.entries.length < MAX_ENTRIES) {
    log.entries.push({ id, ts: performance.now() });
  }
  return children ?? null;
}
