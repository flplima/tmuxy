import { useRef, useEffect } from 'react';
import { PaneHeader } from './PaneHeader';
import type { RegisteredPaneWidget } from './widgets/registry';
import {
  useAppSelector,
  useAppSend,
  usePane,
  useIsDragging,
  useIsResizing,
  useIsSinglePane,
} from '../machines/appHooks';
import { useFramedPaneFocus } from './useFramedPaneFocus';
import { selectPaneHoldsKeyboard } from '../machines/selectors/keyboard';
import type { PaneId } from '../domain/ids';
import { TmuxOp } from '../domain/commands';

interface WidgetPaneProps {
  paneId: PaneId;
  widget: RegisteredPaneWidget;
}

export function WidgetPane({ paneId, widget }: WidgetPaneProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const { definition } = widget;
  const isSinglePane = useIsSinglePane();
  const wrapperRef = useRef<HTMLDivElement>(null);
  // A widget that embeds a frame (a page preview) swallows the mousedown that
  // would otherwise activate its pane; this reads the focus change instead.
  useFramedPaneFocus(paneId, wrapperRef);
  // Both hooks run every render: `||` between two hook calls would make the
  // second one conditional.
  const dragging = useIsDragging();
  const resizing = useIsResizing();
  const gestureInFlight = dragging || resizing;

  const widgetTitle = useAppSelector((context) =>
    definition.selectTitle?.(context, paneId, widget.lines),
  );

  const isActiveWidget = useAppSelector((ctx) => selectPaneHoldsKeyboard(ctx, paneId));
  const widgetKeyRef = useRef({ send, paneId, isActiveWidget });
  widgetKeyRef.current = { send, paneId, isActiveWidget };

  // Capture phase, so it fires before the keyboard actor's bubble-phase
  // window listener.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!widgetKeyRef.current.isActiveWidget) return;

      // SIGINT ends the widget's process and gives the pane back to its shell.
      if (e.ctrlKey && e.key === 'c') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const { send: s, paneId: pid } = widgetKeyRef.current;
        s({ type: 'DISPATCH_OP', op: TmuxOp.SendKeys({ target: pid, keys: 'C-c' }) });
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  if (!pane) return null;

  const WidgetComponent = definition.component;

  return (
    <div
      ref={wrapperRef}
      className={`pane-wrapper ${isSinglePane ? 'pane-single' : ''}`}
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      role="group"
      aria-label={`Widget pane ${pane.tmuxId}`}
      data-pane-id={pane.tmuxId}
      tabIndex={-1}
      onMouseDown={() => {
        send({ type: 'SELECT_PANE', paneId });
      }}
    >
      <PaneHeader paneId={paneId} titleOverride={widgetTitle} />
      {/* An embedded frame captures the pointer the moment it crosses into the
          pane: the window's `mousemove`s stop and the `mouseup` is swallowed,
          leaving a drag or resize stuck on. So no pointer events here while
          one is in flight. */}
      <div
        className="pane-content pane-content-widget"
        style={{
          flex: 1,
          overflow: 'hidden',
          pointerEvents: gestureInFlight ? 'none' : undefined,
        }}
      >
        <WidgetComponent paneId={paneId} lines={widget.lines} />
      </div>
    </div>
  );
}
