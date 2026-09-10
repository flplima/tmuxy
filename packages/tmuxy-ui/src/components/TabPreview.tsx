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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  selectPanes,
  selectCharSize,
  selectContainerSize,
  selectAnimationsAllowed,
} from '../machines/AppContext';
import { Tooltip } from './Tooltip';
import { slotBoxes } from '../utils/tabOverview';
import { useTabStill } from '../hooks/useTabStill';
import { TabShot } from './TabShot';
import './TabPreview.css';

/**
 * How long a pointer has to rest on a tab before the FIRST preview opens.
 * Long enough that crossing the strip shows nothing, short enough that
 * stopping on a tab feels like it answered.
 */
export const TAB_PREVIEW_DELAY_MS = 500;

/**
 * How long the card takes to fade and slide away. Must stay in sync with the
 * `tab-preview-out` keyframes (TabPreview.css) — the node is held for exactly
 * this long so the exit has something to play on.
 */
const TAB_PREVIEW_EXIT_MS = 150;

const WIDTH_PX = 280;
const GAP_PX = 6;
const EDGE_PX = 8;

function portalTarget(): HTMLElement {
  return document.querySelector<HTMLElement>('.app-container') ?? document.body;
}

interface TabPreviewProps {
  /** The tab being previewed, or null when nothing is. */
  windowId: string | null;
  /** Its name, for the close button's label — the strip already knows it. */
  label: string;
  /** The pointer moved onto the card, or off it. */
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

export function TabPreview({ windowId, label, onPointerEnter, onPointerLeave }: TabPreviewProps) {
  const send = useAppSend();
  const panes = useAppSelectorShallow(selectPanes);
  const animations = useAppSelector(selectAnimationsAllowed);
  const { charWidth, charHeight } = useAppSelector(selectCharSize);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);
  const rootRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);

  // What is DRAWN, which outlives what is asked for: when the strip stops
  // pointing at a tab the card stays for its exit, then goes.
  const [card, setCard] = useState<{ windowId: string; label: string } | null>(null);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (windowId) {
      setCard({ windowId, label });
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = setTimeout(() => setCard(null), animations ? TAB_PREVIEW_EXIT_MS : 0);
    return () => clearTimeout(timer);
  }, [windowId, label, animations]);

  const shownId = card?.windowId ?? null;
  const still = useTabStill(panes, shownId !== null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !shownId) return;
    const anchor = document.querySelector<HTMLElement>(`.tab-name[data-window-id="${shownId}"]`);
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
  }, [shownId, frameSize]);

  if (!card) return null;

  // The still is what keeps a busy tab from redrawing its picture on every
  // frame of output; until the first sample lands the live panes will do.
  const source = still ? panes.map((p) => (still[p.tmuxId] ? still[p.tmuxId] : p)) : panes;
  const boxes = slotBoxes(source, card.windowId);

  return createPortal(
    <div
      ref={rootRef}
      className={`tab-preview${leaving ? ' is-leaving' : ''}`}
      role="tooltip"
      data-testid="tab-preview"
      data-window-id={card.windowId}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
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
      {/* Its own row above the picture, so it sits in the card's padding
          rather than over the thing you are looking at. */}
      <div className="tab-preview-bar">
        <Tooltip label="Close tab">
          <button
            type="button"
            className="tab-preview-close"
            aria-label={`Close ${card.label}`}
            data-testid="tab-preview-close"
            onClick={() => send({ type: 'CLOSE_TAB', windowId: card.windowId })}
          >
            ✕
          </button>
        </Tooltip>
      </div>
      <div className="tab-preview-frame" aria-hidden="true">
        <TabShot
          boxes={boxes}
          frameSize={frameSize}
          charWidth={charWidth}
          charHeight={charHeight}
          panes={source}
        />
      </div>
    </div>,
    portalTarget(),
  );
}
