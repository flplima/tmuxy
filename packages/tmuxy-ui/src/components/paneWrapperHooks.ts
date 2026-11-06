/**
 * Hooks behind AnimatedPaneWrapper: the zoom observer.
 */

import React, { useEffect, useRef } from 'react';
import { isModelPaneId } from '../domain/ids';
import { gridPixelSize, type PaneBox } from '../domain/paneGeometry';
import { takeZoomHandoff } from './gestures/zoomHandoff';
import type { AppMachineEvent } from '../machines/types/events';
import { morphFallbackMs, MORPH_PROPERTIES, onMorphEnd } from './PaneLayoutMorph';

const ZOOM_FLIP_TRANSITION = [...MORPH_PROPERTIES]
  .map((prop) => `${prop} var(--transition-pane-zoom)`)
  .join(', ');

export function usePaneZoomObserver({
  containerRef,
  totalWidth,
  totalHeight,
  charWidth,
  charHeight,
  zoomedPaneId,
  send,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  totalWidth: number;
  totalHeight: number;
  charWidth: number;
  charHeight: number;
  zoomedPaneId: string | null;
  send: (event: AppMachineEvent) => void;
}) {
  // In pixels: the zoomed pane's cell height is one row short of the grid (the
  // pane-border-status header row), but its pixel box spans the whole grid.
  const zoomGeometryRef = useRef({ gridWidth: 0, gridHeight: 0, charWidth, charHeight });
  const grid = gridPixelSize(totalWidth, totalHeight, charWidth, charHeight);
  zoomGeometryRef.current = {
    gridWidth: grid.width,
    gridHeight: grid.height,
    charWidth,
    charHeight,
  };
  // Tells a zoom from a pane closing or splitting whether the zoomed flag
  // lands with the geometry or a render after it.
  const zoomRenderRef = useRef<{ now: string | null; before: string | null }>({
    now: null,
    before: null,
  });
  if (zoomRenderRef.current.now !== zoomedPaneId) {
    zoomRenderRef.current = { now: zoomedPaneId, before: zoomRenderRef.current.now };
  }

  // Zoom FLIP, driven by the DOM: the window's zoomed flag can land a render
  // after the box change, so diffing renders misses the moment or catches it
  // after the full box was painted. The observer sees the style mutation before
  // paint, and animates from the box the pane really had, or from where a
  // committed pinch left it (zoomHandoff).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const isPaneItem = (node: Node) =>
      node instanceof HTMLElement && node.classList.contains('pane-layout-item');
    const watch = (node: Node) => {
      if (isPaneItem(node)) {
        observer.observe(node, {
          attributes: true,
          attributeFilter: ['style'],
          attributeOldValue: true,
        });
      }
    };
    const observer = new MutationObserver((records) => {
      let removed = false;
      const before = new Map<HTMLElement, string>();
      for (const r of records) {
        if (r.type === 'childList') {
          r.addedNodes.forEach(watch);
          r.removedNodes.forEach((n) => {
            if (isPaneItem(n)) removed = true;
          });
        } else if (r.oldValue !== null && !before.has(r.target as HTMLElement)) {
          before.set(r.target as HTMLElement, r.oldValue);
        }
      }
      const { gridWidth, gridHeight, charWidth: cw, charHeight: ch } = zoomGeometryRef.current;
      const full = (b: PaneBox) => b.width >= gridWidth - cw && b.height >= gridHeight - ch;
      const zoom = zoomRenderRef.current;
      for (const [node, oldStyle] of before) {
        const from = styleBox(oldStyle);
        const to = styleBox(node.getAttribute('style') ?? '');
        if (!from || !to || full(from) === full(to)) continue;
        const id = node.dataset.paneId;
        if (!isModelPaneId(id)) continue;
        // Filling the grid is a zoom when this pane is the zoomed one, or when
        // its siblings are all still here (tmux keeps them while zoomed and the
        // flag can lag), not when one just closed.
        const zooming = full(to)
          ? zoom.now === id || !removed
          : zoom.now === id || zoom.before === id;
        if (!zooming) continue;
        const handoff = takeZoomHandoff(id);
        if (handoff) {
          // The pinch stops drawing the pane - and the grid - this same frame.
          node.style.transform = '';
          container.style.transform = '';
          send({ type: 'GESTURE_SETTLE' });
        }
        flipZoom(node, handoff ?? from);
      }
      // The FLIP's own writes are not zooms.
      observer.takeRecords();
    });
    observer.observe(container, { childList: true });
    container.childNodes.forEach(watch);
    return () => observer.disconnect();
  }, [containerRef, send]);
}

/** null when the pane has no box (hidden). */
function styleBox(style: string): PaneBox | null {
  const px = (prop: string) => {
    const m = style.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`));
    return m ? parseFloat(m[1]) : null;
  };
  const left = px('left');
  const top = px('top');
  const width = px('width');
  const height = px('height');
  if (left === null || top === null || width === null || height === null) return null;
  return { left, top, width, height };
}

/**
 * The transition is set inline so it wins over the suppression classes the
 * zoom's layout change carries.
 */
function flipZoom(node: HTMLElement, from: PaneBox): void {
  const to = {
    left: node.style.left,
    top: node.style.top,
    width: node.style.width,
    height: node.style.height,
  };
  node.style.transition = 'none';
  node.style.zIndex = 'var(--z-pane-anim)';
  node.style.left = `${from.left}px`;
  node.style.top = `${from.top}px`;
  node.style.width = `${from.width}px`;
  node.style.height = `${from.height}px`;
  node.getBoundingClientRect();
  node.style.transition = ZOOM_FLIP_TRANSITION;
  Object.assign(node.style, to);
  let done = false;
  let timer = 0;
  const finish = () => {
    if (done) return;
    done = true;
    unlisten();
    clearTimeout(timer);
    node.style.transition = '';
    node.style.zIndex = '';
  };
  const unlisten = onMorphEnd(node, finish);
  timer = window.setTimeout(finish, morphFallbackMs(node));
}
