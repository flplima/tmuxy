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
  useAppActor,
  useAppSelector,
  useAppSend,
  usePane,
  useIsPaneInActiveWindow,
  useIsSinglePane,
  useIsDragging,
  useIsResizing,
} from '../machines/AppContext';
import { useFramedPaneFocus } from '../hooks';

interface WidgetPaneProps {
  paneId: string;
  widgetInfo: { widgetName: string; contentLines: string[] };
}

export function WidgetPane({ paneId, widgetInfo }: WidgetPaneProps) {
  const send = useAppSend();
  const actor = useAppActor();
  const pane = usePane(paneId);
  const definition = getWidget(widgetInfo.widgetName)!;
  const isInActiveWindow = useIsPaneInActiveWindow(paneId);
  const isSinglePane = useIsSinglePane();
  const wrapperRef = useRef<HTMLDivElement>(null);
  // A widget that embeds a frame (the browser) swallows the mousedown that
  // would otherwise activate its pane; this reads the focus change instead.
  useFramedPaneFocus(paneId, wrapperRef);
  // While a divider or a pane is being dragged, the gesture belongs to the app
  // and to nothing inside a pane. Both hooks run every render — `||` between
  // two hook calls makes the second one conditional.
  const dragging = useIsDragging();
  const resizing = useIsResizing();
  const gestureInFlight = dragging || resizing;

  // The widget's own title when it declares one — a browser pane names itself
  // after the page it is showing — else the generic `__TITLE__`/URL sniffing.
  const widgetTitle = useAppSelector(
    (context) =>
      definition?.selectTitle?.(context, paneId, widgetInfo.contentLines) ??
      getWidgetTitle(widgetInfo.contentLines),
  );

  // Vi-key navigation: capture-phase window listener that fires BEFORE
  // the keyboard actor's bubble-phase window listener.
  const isActiveWidget = !!pane?.active && isInActiveWindow;
  const widgetKeyRef = useRef({ send, paneId, isActiveWidget, definition, actor, widgetInfo });
  widgetKeyRef.current = { send, paneId, isActiveWidget, definition, actor, widgetInfo };

  useEffect(() => {
    const LINE_HEIGHT = 24;

    const handler = (e: KeyboardEvent) => {
      if (!widgetKeyRef.current.isActiveWidget) return;

      const { send: s, paneId: pid, definition: def, actor: act } = widgetKeyRef.current;

      // The widget's own keys come first — it is the thing on screen, so its
      // bindings outrank both the generic scrolling below and tmux.
      if (
        def.onKeyDown?.(e, {
          paneId: pid,
          lines: widgetKeyRef.current.widgetInfo.contentLines,
          context: act.getSnapshot().context,
          send: s,
        })
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

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

  const WidgetComponent = definition.component;
  const lastLine = widgetInfo.contentLines.filter((l) => l.trim()).pop() || '';
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
      {/* `pointer-events: none` for the length of a drag or a resize, because
          an embedded frame captures the pointer the moment it crosses into the
          pane: the `mousemove`s stop reaching the window listener the gesture
          runs on, so the divider stops following the cursor — and the
          `mouseup` is swallowed too, leaving the resize stuck on until some
          later click lands outside a frame. Nothing inside a pane needs the
          pointer while the app is already using it. */}
      <div
        className="pane-content pane-content-widget"
        style={{
          flex: 1,
          overflow: 'hidden',
          pointerEvents: gestureInFlight ? 'none' : undefined,
        }}
      >
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
