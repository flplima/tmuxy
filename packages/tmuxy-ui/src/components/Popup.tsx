/**
 * Popup - Renders a tmux popup overlay
 *
 * Popups are modal overlays (like fzf, git UIs) that appear centered
 * over the pane layout. When a popup is active, keyboard input routes
 * to the popup instead of the underlying panes.
 *
 * Note: This requires tmux with control mode popup support (PR #4361).
 * Until that's merged, popups won't be detected and this component won't render.
 */

import { useMemo } from 'react';
import { Terminal } from './Terminal';
import type { TmuxPopup } from '../machines/types';
import { useAppSelector } from '../machines/AppContext';

interface PopupProps {
  popup: TmuxPopup;
  charWidth: number;
  charHeight: number;
  containerWidth: number;
  containerHeight: number;
}

export function Popup({
  popup,
  charWidth,
  charHeight,
  containerWidth,
  containerHeight,
}: PopupProps) {
  // Calculate popup pixel dimensions
  const popupWidth = popup.width * charWidth;
  const popupHeight = popup.height * charHeight;

  // Center the popup in the container
  const left = Math.max(0, (containerWidth - popupWidth) / 2);
  const top = Math.max(0, (containerHeight - popupHeight) / 2);

  const style = useMemo(
    () => ({
      position: 'absolute' as const,
      left: `${left}px`,
      top: `${top}px`,
      width: `${popupWidth}px`,
      height: `${popupHeight}px`,
      zIndex: 1000,
      backgroundColor: 'var(--terminal-bg, #1e1e1e)',
      border: '1px solid var(--border-color, #444)',
      borderRadius: '4px',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
      overflow: 'hidden',
    }),
    [left, top, popupWidth, popupHeight]
  );

  const overlayStyle = useMemo(
    () => ({
      position: 'absolute' as const,
      inset: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      zIndex: 999,
    }),
    []
  );

  return (
    <>
      {/* Semi-transparent overlay behind popup */}
      <div style={overlayStyle} data-testid="popup-overlay" />

      {/* Popup container */}
      <div style={style} data-testid="popup-container">
        <Terminal
          content={popup.content}
          cursorX={popup.cursorX}
          cursorY={popup.cursorY}
          height={popup.height}
          isActive={popup.active}
          inMode={false}
          copyCursorX={0}
          copyCursorY={0}
        />
      </div>
    </>
  );
}

/**
 * PopupContainer - Conditionally renders popup if one is active
 */
export function PopupContainer() {
  // useAppSelector receives a function that takes context directly
  const popup = useAppSelector((ctx) => ctx.popup);
  const charWidth = useAppSelector((ctx) => ctx.charWidth);
  const charHeight = useAppSelector((ctx) => ctx.charHeight);
  const containerWidth = useAppSelector((ctx) => ctx.containerWidth);
  const containerHeight = useAppSelector((ctx) => ctx.containerHeight);

  if (!popup) {
    return null;
  }

  return (
    <Popup
      popup={popup}
      charWidth={charWidth}
      charHeight={charHeight}
      containerWidth={containerWidth}
      containerHeight={containerHeight}
    />
  );
}
