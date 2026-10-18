/**
 * TabOverviewSlots — the cards and trailing "+" slot rendered inside the
 * TabOverview grid.
 */

import type React from 'react';
import type { AppMachineEvent } from '../machines/types/events';
import type { overviewSlots } from '../utils/tabOverview';
import type { useReorderDrag } from '../hooks/useReorderDrag';
import type { WindowId } from '../domain/ids';
import { TabShot } from './TabShot';
import { Tooltip } from './Tooltip';

interface TabOverviewSlotsProps {
  slots: ReturnType<typeof overviewSlots>;
  activeWindowId: WindowId | null;
  selected: number;
  readOnly: boolean;
  frameSize: { width: number; height: number } | null;
  charWidth: number;
  charHeight: number;
  reorder: ReturnType<typeof useReorderDrag>;
  activateSlot: (index: number) => void;
  send: (event: AppMachineEvent) => void;
}

export function TabOverviewSlots({
  slots,
  activeWindowId,
  selected,
  readOnly,
  frameSize,
  charWidth,
  charHeight,
  reorder,
  activateSlot,
  send,
}: TabOverviewSlotsProps) {
  const { dragging, dropMarkerAt } = reorder;

  // ---- pointer: click to open, drag to reorder ------------------------------
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>, index: number) => {
    const slot = slots[index];
    if (!slot || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    reorder.handlePointerDown(e, slot.window.id, index);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>, index: number) => {
    const press = reorder.handlePointerUp(e);
    // A press that never became a drag is a click: open that tab.
    if (press && !press.active) activateSlot(index);
  };

  return (
    <>
      {slots.map((slot, index) => {
        const isActive = slot.window.id === activeWindowId;
        const isDragged = dragging?.windowId === slot.window.id;
        const cls = [
          'tab-overview-slot',
          isActive ? 'is-active' : '',
          index === selected ? 'is-selected' : '',
          isDragged ? 'is-dragging' : '',
          dropMarkerAt === index ? 'is-drop-before' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const style = isDragged
          ? ({
              transform: `translate(${dragging!.dx}px, ${dragging!.dy}px)`,
            } as React.CSSProperties)
          : undefined;
        return (
          <div
            key={slot.window.id}
            id={`tab-overview-slot-${index}`}
            className={cls}
            style={style}
            role="option"
            aria-selected={index === selected}
            data-window-id={slot.window.id}
            data-testid={`tab-overview-slot-${slot.window.id}`}
            onPointerDown={(e) => handlePointerDown(e, index)}
            onPointerMove={reorder.handlePointerMove}
            onPointerUp={(e) => handlePointerUp(e, index)}
            onPointerCancel={reorder.handlePointerCancel}
          >
            <div className="tab-overview-slot-header">
              <span className="tab-overview-slot-label">
                {slot.position}:{slot.window.name || `Tab ${slot.position}`}
              </span>
              {!readOnly && (
                <Tooltip label="Close tab">
                  {/* A pointer shortcut for Delete on the selected slot: an
                      option may hold no control of its own, so this is no
                      button, and is hidden from assistive technology. */}
                  <span
                    className="tab-overview-slot-close"
                    aria-hidden="true"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      send({ type: 'CLOSE_TAB', windowId: slot.window.id });
                    }}
                  >
                    ✕
                  </span>
                </Tooltip>
              )}
            </div>
            {/* The active tab's frame is the FLIP target: the live grid is
                drawn over it, so its wireframe only shows through the
                zoom animation. */}
            <div className="tab-overview-frame" aria-hidden="true">
              <TabShot
                boxes={slot.boxes}
                frameSize={frameSize}
                charWidth={charWidth}
                charHeight={charHeight}
              />
            </div>
          </div>
        );
      })}
      {!readOnly && (
        <div
          id={`tab-overview-slot-${slots.length}`}
          className={`tab-overview-slot tab-overview-slot-new${
            selected === slots.length ? ' is-selected' : ''
          }${dropMarkerAt === slots.length ? ' is-drop-before' : ''}`}
          role="option"
          aria-selected={selected === slots.length}
          aria-label="New tab"
          data-testid="tab-overview-new"
          onClick={(e) => {
            e.stopPropagation();
            send({ type: 'TAB_OVERVIEW_ACTIVATE', index: slots.length });
          }}
        >
          <div className="tab-overview-slot-header">
            <span className="tab-overview-slot-label">New tab</span>
          </div>
          <div className="tab-overview-frame tab-overview-frame-new" aria-hidden="true">
            <span className="tab-overview-plus">+</span>
          </div>
        </div>
      )}
    </>
  );
}
