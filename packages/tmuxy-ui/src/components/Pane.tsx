/**
 * Pane - Orchestrator that routes to WidgetPane or TerminalPane.
 *
 * Takes a paneId, fetches pane data, detects if it's a widget,
 * and delegates to the appropriate sub-component.
 */

import { memo } from 'react';
import { usePane } from '../machines/AppContext';
import { LogProfiler } from '../utils/renderLog';
import { detectWidget } from './widgets';
import { WidgetPane } from './WidgetPane';
import { TerminalPane } from './TerminalPane';

interface PaneProps {
  paneId: string;
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

  // Pane may not exist during transitions
  if (!pane) return null;

  const widgetInfo = detectWidget(pane.content);
  // The Profiler sits INSIDE the memo boundary so a memo bail-out records
  // zero commits — it measures real pane work, not parent churn.
  if (widgetInfo) {
    return (
      <LogProfiler id={`Pane:${paneId}`}>
        <WidgetPane paneId={paneId} widgetInfo={widgetInfo} />
      </LogProfiler>
    );
  }
  return (
    <LogProfiler id={`Pane:${paneId}`}>
      <TerminalPane paneId={paneId} />
    </LogProfiler>
  );
});
