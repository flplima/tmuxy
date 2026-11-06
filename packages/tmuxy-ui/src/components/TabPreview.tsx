/**
 * The first preview waits, so a pointer crossing the strip shows nothing.
 * While one is up, moving along the strip is browsing: ONE card slides to the
 * next button and swaps its picture. Leaving the strip ends the browse.
 * Right-clicking the tab turns this card into the tab's menu (`WindowTabs`).
 */

import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppSend, useAppSelector, useAppSelectorShallow } from '../machines/appHooks';
import { selectPanes, selectCharSize, selectContainerSize } from '../machines/selectors/layout';
import { selectAnimationsAllowed } from '../machines/selectors/ui';
import { Tooltip } from './Tooltip';
import { slotBoxes } from '../domain/tabOverview';
import { useTabStill } from './useTabStill';
import { TabShot } from './TabShot';
import { useFloatingSurface, surfacePortalTarget } from './floating/useFloatingSurface';
import './floating/FloatingSurface.css';
import './TabPreview.css';
import type { WindowId } from '../domain/ids';

/** How long a pointer has to rest on a tab before the FIRST preview opens. */
export const TAB_PREVIEW_DELAY_MS = 500;

const WIDTH_PX = 280;

interface TabPreviewProps {
  windowId: WindowId | null;
  label: string;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onActivate: (windowId: WindowId) => void;
  /** Called when another floating surface takes the layer. */
  onDismiss: () => void;
}

export function TabPreview({
  windowId,
  label,
  onPointerEnter,
  onPointerLeave,
  onActivate,
  onDismiss,
}: TabPreviewProps) {
  const send = useAppSend();
  const panes = useAppSelectorShallow(selectPanes);
  const animations = useAppSelector(selectAnimationsAllowed);
  const { charWidth, charHeight } = useAppSelector(selectCharSize);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);

  const {
    ref: rootRef,
    shown: card,
    leaving,
    reposition,
  } = useFloatingSurface<{ windowId: WindowId; label: string }>({
    id: 'tab-preview',
    content: windowId ? { windowId, label } : null,
    anchor: {
      kind: 'element',
      element: windowId
        ? document.querySelector<HTMLElement>(`.tab-name[data-window-id="${windowId}"]`)
        : null,
    },
    placement: { align: 'center' },
    animated: animations,
    onDismiss,
  });

  const shownId = card?.windowId ?? null;
  const still = useTabStill(panes, shownId !== null);

  // The frame's height decides the card's, so the card is re-placed once the
  // frame is measured.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !shownId) return;
    const frame = root.querySelector<HTMLElement>('.tab-preview-frame');
    if (!frame) return;
    const r = frame.getBoundingClientRect();
    if (r.width > 0 && (r.width !== frameSize?.width || r.height !== frameSize?.height)) {
      setFrameSize({ width: r.width, height: r.height });
      reposition();
    }
  }, [shownId, frameSize, rootRef, reposition]);

  if (!card) return null;

  // Until the first still lands, the live panes will do.
  const source = still ? panes.map((p) => (still[p.tmuxId] ? still[p.tmuxId] : p)) : panes;
  const boxes = slotBoxes(source, card.windowId);

  return createPortal(
    <div
      ref={rootRef}
      className={`floating-surface tab-preview${leaving ? ' is-leaving' : ''}`}
      role="tooltip"
      data-testid="tab-preview"
      data-window-id={card.windowId}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onClick={() => onActivate(card.windowId)}
      style={
        {
          width: WIDTH_PX,
          '--tab-overview-aspect': String(
            containerWidth > 0 && containerHeight > 0 ? containerWidth / containerHeight : 16 / 9,
          ),
        } as React.CSSProperties
      }
    >
      <div className="tab-preview-bar">
        <Tooltip label="Close tab">
          <button
            type="button"
            className="tab-preview-close"
            aria-label={`Close ${card.label}`}
            data-testid="tab-preview-close"
            onClick={(e) => {
              e.stopPropagation();
              send({ type: 'CLOSE_TAB', windowId: card.windowId });
            }}
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
    surfacePortalTarget(),
  );
}
