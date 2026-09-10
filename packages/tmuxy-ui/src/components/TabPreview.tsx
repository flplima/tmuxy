/**
 * TabPreview — the picture of a tab that appears under its button on hover.
 *
 * Like Chrome's tab previews, and for the same reason: a strip of names does
 * not tell you which tab has the thing you are looking for, and switching to
 * find out costs you the tab you were on.
 *
 * The first one waits: hovering has to be deliberate, so a pointer merely
 * crossing the strip on its way somewhere else shows nothing. After that the
 * wait is over — while the preview is up, moving along the strip is browsing,
 * and it should keep up. So there is ONE preview for the whole strip: it
 * slides to the next button and swaps its picture, rather than a new one
 * fading in a second later at every stop.
 *
 * It follows the pointer only within the strip; leaving the strip ends the
 * browse, and the next preview waits its second again.
 *
 * Positioning mirrors Tooltip: fixed, portalled into `.app-container` so the
 * config's animations switch reaches it, and clamped to the viewport.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useAppSelector,
  useAppSelectorShallow,
  selectPanes,
  selectCharSize,
  selectContainerSize,
} from '../machines/AppContext';
import { slotBoxes } from '../utils/tabOverview';
import { useTabStill } from '../hooks/useTabStill';
import { TabShot } from './TabShot';
import './TabPreview.css';

/** How long a pointer has to rest on a tab before the FIRST preview opens. */
export const TAB_PREVIEW_DELAY_MS = 1000;

const WIDTH_PX = 280;
const GAP_PX = 6;
const EDGE_PX = 8;

function portalTarget(): HTMLElement {
  return document.querySelector<HTMLElement>('.app-container') ?? document.body;
}

interface TabPreviewProps {
  /** The tab being previewed, or null when nothing is. */
  windowId: string | null;
  /** Its name, for the caption — the strip already knows it. */
  label: string;
}

export function TabPreview({ windowId, label }: TabPreviewProps) {
  const panes = useAppSelectorShallow(selectPanes);
  const { charWidth, charHeight } = useAppSelector(selectCharSize);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);
  const still = useTabStill(panes, windowId !== null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !windowId) return;
    const anchor = document.querySelector<HTMLElement>(`.tab-name[data-window-id="${windowId}"]`);
    if (!anchor) return;
    const tab = anchor.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    // Centred under its button, then pulled back inside the window — a tab at
    // either end would otherwise hang off the edge.
    const left = Math.min(
      Math.max(EDGE_PX, tab.left + tab.width / 2 - box.width / 2),
      window.innerWidth - box.width - EDGE_PX,
    );
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(tab.bottom + GAP_PX)}px`;

    const frame = root.querySelector<HTMLElement>('.tab-preview-frame');
    if (frame) {
      const r = frame.getBoundingClientRect();
      if (r.width > 0 && (r.width !== frameSize?.width || r.height !== frameSize?.height)) {
        setFrameSize({ width: r.width, height: r.height });
      }
    }
  }, [windowId, frameSize]);

  if (!windowId) return null;

  // The still is what keeps a busy tab from redrawing its picture on every
  // frame of output; until the first sample lands the live panes will do.
  const source = still ? panes.map((p) => (still[p.tmuxId] ? still[p.tmuxId] : p)) : panes;
  const boxes = slotBoxes(source, windowId);

  return createPortal(
    <div
      ref={rootRef}
      className="tab-preview"
      role="tooltip"
      aria-hidden="true"
      data-testid="tab-preview"
      data-window-id={windowId}
      // The picture is the tab's shape, so the frame takes the pane area's
      // aspect ratio rather than a fixed one.
      style={
        {
          width: WIDTH_PX,
          '--tab-overview-aspect': String(
            containerWidth > 0 && containerHeight > 0 ? containerWidth / containerHeight : 16 / 9,
          ),
        } as React.CSSProperties
      }
    >
      <div className="tab-preview-frame" aria-hidden="true">
        <TabShot
          boxes={boxes}
          frameSize={frameSize}
          charWidth={charWidth}
          charHeight={charHeight}
        />
      </div>
      <div className="tab-preview-label">{label}</div>
    </div>,
    portalTarget(),
  );
}
