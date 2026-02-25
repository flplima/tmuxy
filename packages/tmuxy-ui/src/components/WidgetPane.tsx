/**
 * WidgetPane - Renders a pane that displays a custom widget component.
 *
 * Handles vi-key navigation for scrolling widget content and delegates
 * rendering to the registered widget component.
 */

import { useRef, useEffect } from 'react';
import { PaneHeader } from './PaneHeader';
import { getWidget } from './widgets';
import { getWidgetTitle } from './widgets/getWidgetTitle';
import {
  useAppSend,
  usePane,
  useIsPaneInActiveWindow,
  useIsSinglePane,
} from '../machines/AppContext';

interface WidgetPaneProps {
  paneId: string;
  widgetInfo: { widgetName: string; contentLines: string[] };
}

export function WidgetPane({ paneId, widgetInfo }: WidgetPaneProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const isInActiveWindow = useIsPaneInActiveWindow(paneId);
  const isSinglePane = useIsSinglePane();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Vi-key navigation: capture-phase window listener that fires BEFORE
  // the keyboard actor's bubble-phase window listener.
  const isActiveWidget = !!pane?.active && isInActiveWindow;
  const widgetKeyRef = useRef({ send, paneId, isActiveWidget });
  widgetKeyRef.current = { send, paneId, isActiveWidget };

  useEffect(() => {
    const LINE_HEIGHT = 24;

    const handler = (e: KeyboardEvent) => {
      if (!widgetKeyRef.current.isActiveWidget) return;

      const { send: s, paneId: pid } = widgetKeyRef.current;

      // Ctrl+C: send SIGINT to tmux pane (kills widget, restores shell)
      if (e.ctrlKey && e.key === 'c') {
        e.preventDefault();
        e.stopImmediatePropagation();
        s({ type: 'SEND_KEYS', paneId: pid, keys: 'C-c' });
        return;
      }

      const el = wrapperRef.current;
      if (!el) return;
      const scrollEl = el.querySelector(
        '.widget-markdown, .widget-scrollable',
      ) as HTMLElement | null;
      if (!scrollEl) return;

      const pageSize = scrollEl.clientHeight;
      let handled = true;

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          scrollEl.scrollTop += LINE_HEIGHT;
          break;
        case 'k':
        case 'ArrowUp':
          scrollEl.scrollTop -= LINE_HEIGHT;
          break;
        case 'd':
          if (e.ctrlKey) scrollEl.scrollTop += pageSize / 2;
          else handled = false;
          break;
        case 'u':
          if (e.ctrlKey) scrollEl.scrollTop -= pageSize / 2;
          else handled = false;
          break;
        case 'g':
          scrollEl.scrollTop = 0;
          break;
        case 'G':
          scrollEl.scrollTop = scrollEl.scrollHeight;
          break;
        case ' ':
        case 'PageDown':
          scrollEl.scrollTop += pageSize;
          break;
        case 'b':
        case 'PageUp':
          scrollEl.scrollTop -= pageSize;
          break;
        case 'Home':
          scrollEl.scrollTop = 0;
          break;
        case 'End':
          scrollEl.scrollTop = scrollEl.scrollHeight;
          break;
        default:
          handled = false;
      }

      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };

    // Capture phase fires before the keyboard actor's bubble-phase listener
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  if (!pane) return null;

  const WidgetComponent = getWidget(widgetInfo.widgetName)!;
  const lastLine = widgetInfo.contentLines.filter((l) => l.trim()).pop() || '';
  const widgetTitle = getWidgetTitle(widgetInfo.contentLines);
  const writeStdin = (data: string) => {
    send({ type: 'WRITE_TO_PANE', paneId, data });
  };

  return (
    <div
      ref={wrapperRef}
      className={`pane-wrapper ${isSinglePane ? 'pane-single' : ''}`}
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      role="group"
      aria-label={`Widget pane ${pane.tmuxId}`}
      data-pane-id={pane.tmuxId}
      tabIndex={0}
      onMouseDown={() => {
        send({ type: 'FOCUS_PANE', paneId });
      }}
    >
      <PaneHeader paneId={paneId} titleOverride={widgetTitle} widgetName={widgetInfo.widgetName} />
      <div className="pane-content" style={{ flex: 1, overflow: 'hidden' }}>
        <WidgetComponent
          paneId={paneId}
          widgetName={widgetInfo.widgetName}
          lines={widgetInfo.contentLines}
          lastLine={lastLine}
          rawContent={pane.content}
          writeStdin={writeStdin}
          width={pane.width}
          height={pane.height}
        />
      </div>
    </div>
  );
}
