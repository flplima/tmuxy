/**
 * Pane - Orchestrator that routes to WidgetPane or TerminalPane.
 *
 * Takes a paneId, fetches pane data, detects if it's a widget,
 * and delegates to the appropriate sub-component.
 */

import { memo } from 'react';
import { usePane } from '../machines/appHooks';
import { LogProfiler } from './renderLog';
import { paneWidgetOf } from './widgets/registry';
import { WidgetPane } from './WidgetPane';
import { TerminalPane } from './terminal/TerminalPane';
import type { PaneId } from '../domain/ids';

interface PaneProps {
  paneId: PaneId;
}

/**
 * Memoized on paneId: the parent PaneLayout re-renders on every model tick
 * (pane arrays change identity whenever ANY pane changes), and without this
 * boundary every pane's whole subtree re-rendered on every keystroke. The
 * component subscribes to its own pane via usePane, so it still updates the
 * moment ITS data changes.
 */
export const Pane = memo(function Pane({ paneId }: PaneProps) {
  const pane = usePane(paneId);
  const widget = paneWidgetOf(pane);

  // Pane may not exist during transitions
  if (!pane) return null;
  // The Profiler sits INSIDE the memo boundary so a memo bail-out records
  // zero commits — it measures real pane work, not parent churn.
  if (widget) {
    return (
      <LogProfiler id={`Pane:${paneId}`}>
        <WidgetPane paneId={paneId} widget={widget} />
      </LogProfiler>
    );
  }
  return (
    <LogProfiler id={`Pane:${paneId}`}>
      <TerminalPane paneId={paneId} />
    </LogProfiler>
  );
});
