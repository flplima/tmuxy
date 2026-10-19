/**
 * WidgetPane - Renders a pane that displays a custom widget component.
 *
 * Owns the pane chrome and Ctrl+C (which ends the widget's process) and
 * delegates rendering to the registered widget component.
 */

import { useRef, useEffect } from 'react';
import { PaneHeader } from './PaneHeader';
import { getWidget } from './widgets/registry';
import {
  useAppSelector,
  useAppSend,
  usePane,
  useIsPaneInActiveWindow,
  useIsSinglePane,
} from '../machines/appHooks';
import type { PaneId } from '../domain/ids';

interface WidgetPaneProps {
  paneId: PaneId;
  widgetInfo: { widgetName: string; contentLines: string[] };
}

export function WidgetPane({ paneId, widgetInfo }: WidgetPaneProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const definition = getWidget(widgetInfo.widgetName)!;
  const isInActiveWindow = useIsPaneInActiveWindow(paneId);
  const isSinglePane = useIsSinglePane();

  // The widget's own title when it declares one; without one the header
  // shows the pane's.
  const widgetTitle = useAppSelector((context) =>
    definition.selectTitle?.(context, paneId, widgetInfo.contentLines),
  );

  // Capture-phase window listener that fires BEFORE the keyboard actor's
  // bubble-phase window listener.
  const isActiveWidget = !!pane?.active && isInActiveWindow;
  const widgetKeyRef = useRef({ send, paneId, isActiveWidget });
  widgetKeyRef.current = { send, paneId, isActiveWidget };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!widgetKeyRef.current.isActiveWidget) return;

      // Ctrl+C: send SIGINT to tmux pane (kills widget, restores shell)
      if (e.ctrlKey && e.key === 'c') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const { send: s, paneId: pid } = widgetKeyRef.current;
        s({ type: 'SEND_KEYS', paneId: pid, keys: 'C-c' });
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  if (!pane) return null;

  const WidgetComponent = definition.component;

  return (
    <div
      className={`pane-wrapper ${isSinglePane ? 'pane-single' : ''}`}
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      role="group"
      aria-label={`Widget pane ${pane.tmuxId}`}
      data-pane-id={pane.tmuxId}
      tabIndex={-1}
      onMouseDown={() => {
        send({ type: 'FOCUS_PANE', paneId });
      }}
    >
      <PaneHeader paneId={paneId} titleOverride={widgetTitle} widgetName={widgetInfo.widgetName} />
      <div className="pane-content pane-content-widget" style={{ flex: 1, overflow: 'hidden' }}>
        <WidgetComponent paneId={paneId} lines={widgetInfo.contentLines} />
      </div>
    </div>
  );
}
