/**
 * Pane - Orchestrator that routes to WidgetPane or TerminalPane.
 *
 * Takes a paneId, fetches pane data, detects if it's a widget,
 * and delegates to the appropriate sub-component.
 */

import { usePane } from '../machines/AppContext';
import { detectWidget } from './widgets';
import { WidgetPane } from './WidgetPane';
import { TerminalPane } from './TerminalPane';

interface PaneProps {
  paneId: string;
}

export function Pane({ paneId }: PaneProps) {
  const pane = usePane(paneId);

  // Pane may not exist during transitions
  if (!pane) return null;

  const widgetInfo = detectWidget(pane.content);
  if (widgetInfo) {
    return <WidgetPane paneId={paneId} widgetInfo={widgetInfo} />;
  }
  return <TerminalPane paneId={paneId} />;
}
