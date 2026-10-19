/**
 * AnimatedPaneWrapper — individual pane wrapper, zoom FLIP observer, and
 * global drag/resize listeners for PaneLayout.
 */

import React, { type ReactNode } from 'react';
import type { TmuxPane } from '../domain/client';
import { swipeOffsetPx } from '../utils/gestures';
import type { RenderItem } from './PaneLayoutMorph';

// ============================================
// Animated Pane Wrapper
// ============================================

interface AnimatedPaneWrapperProps {
  pane: TmuxPane;
  /** Effective React key (paneKeyOverrides honored) — exposed on the DOM
   * for the enter-animation FLIP to find the node post-commit. */
  paneKey: string;
  className: string;
  style: React.CSSProperties;
  targetX: number;
  targetY: number;
  elevated: boolean;
  /** When set, overrides the translate3d transform — the zoom-collapse
   *  translate-to-centre + scale (see the zoom-collapse render branch), or a
   *  empty while a pinch draws the pane (GestureStage owns its transform). */
  collapseTransform?: string;
  children: ReactNode;
}

export function AnimatedPaneWrapper({
  pane,
  paneKey,
  className,
  style,
  targetX,
  targetY,
  elevated,
  collapseTransform,
  children,
}: AnimatedPaneWrapperProps) {
  const transformStyle: React.CSSProperties = {
    ...style,
    transform: collapseTransform ?? `translate3d(${targetX}px, ${targetY}px, 0)`,
    zIndex: elevated ? 'var(--z-dragging)' : undefined,
  };

  return (
    <div
      data-pane-id={pane.tmuxId}
      data-pane-key={paneKey}
      className={className}
      style={transformStyle}
    >
      {children}
    </div>
  );
}

interface PaneLayoutItemProps {
  item: RenderItem;
  zoomCenter: { x: number; y: number };
  totalWidth: number;
  charWidth: number;
  draggedPaneId: string | null;
  isDragging: boolean;
  dragOffset: { x: number; y: number };
  groupSwitchPanes: ReadonlySet<string> | null;
  gesturePaneId: string | null;
  getPaneStyle: (pane: TmuxPane) => React.CSSProperties;
  getPaneClassName: (pane: TmuxPane, key: string) => string;
  renderChild: (pane: TmuxPane) => ReactNode;
}

export function PaneLayoutItem({
  item,
  zoomCenter,
  totalWidth,
  charWidth,
  draggedPaneId,
  isDragging,
  dragOffset,
  groupSwitchPanes,
  gesturePaneId,
  getPaneStyle,
  getPaneClassName,
  renderChild,
}: PaneLayoutItemProps) {
  const { key, pane, hidden, zoomCollapsed, swipeSide } = item;

  if (zoomCollapsed) {
    // A zoomed sibling: keep it at its real box but transform it toward
    // the grid centre, scaled down and faded out, so zoom IN reads as
    // the panes collapsing into the middle while the zoomed pane grows
    // — and zoom OUT reverses it (the DOM node persists by key, so the
    // base transform/opacity transition runs both ways). computePaneBox
    // via getPaneStyle; translate the pane's centre onto zoomCenter.
    const box = getPaneStyle(pane);
    const cx = (box.left as number) + (box.width as number) / 2;
    const cy = (box.top as number) + (box.height as number) / 2;
    return (
      <AnimatedPaneWrapper
        paneKey={key}
        pane={pane}
        className="pane-layout-item pane-inactive pane-zoom-collapsing"
        style={box}
        targetX={0}
        targetY={0}
        elevated={false}
        collapseTransform={`translate(${zoomCenter.x - cx}px, ${zoomCenter.y - cy}px) scale(var(--zoom-collapse-scale, 0.4))`}
      >
        {renderChild(pane)}
      </AnimatedPaneWrapper>
    );
  }

  if (swipeSide !== 0) {
    // The tab a slide is pulling in: its real panes at their own boxes,
    // one grid width to the side, moving with the grid's transform.
    return (
      <AnimatedPaneWrapper
        paneKey={key}
        pane={pane}
        className="pane-layout-item pane-inactive pane-swipe-neighbor"
        style={getPaneStyle(pane)}
        targetX={swipeSide * swipeOffsetPx(totalWidth, charWidth)}
        targetY={0}
        elevated={false}
      >
        {renderChild(pane)}
      </AnimatedPaneWrapper>
    );
  }

  if (hidden) {
    // Window-hidden (another tab's pane): mounted but display:none — no
    // positioning math, no animation, no event handlers. Preserves
    // <TerminalPane> + content so a tab switch shows it instantly.
    return (
      <AnimatedPaneWrapper
        paneKey={key}
        pane={pane}
        className="pane-layout-item pane-window-hidden"
        style={{ display: 'none' }}
        targetX={0}
        targetY={0}
        elevated={false}
      >
        {renderChild(pane)}
      </AnimatedPaneWrapper>
    );
  }

  const isDraggedPane = pane.tmuxId === draggedPaneId;
  const baseStyle = getPaneStyle(pane);

  const isGroupSwitchPane = groupSwitchPanes?.has(pane.tmuxId) ?? false;
  const style = isGroupSwitchPane ? { ...baseStyle, transition: 'none' } : baseStyle;

  const shouldFollowCursor = isDraggedPane && isDragging;

  // A pinch draws this pane where the fingers have it: no transform of
  // React's own, so GestureStage's inline one stands.
  const pinched = pane.tmuxId === gesturePaneId;

  return (
    <AnimatedPaneWrapper
      paneKey={key}
      pane={pane}
      className={`${getPaneClassName(pane, key)}${pinched ? ' pane-gesture-growing' : ''}`}
      style={style}
      targetX={shouldFollowCursor ? dragOffset.x : 0}
      targetY={shouldFollowCursor ? dragOffset.y : 0}
      elevated={shouldFollowCursor}
      collapseTransform={pinched ? '' : undefined}
    >
      {renderChild(pane)}
    </AnimatedPaneWrapper>
  );
}
