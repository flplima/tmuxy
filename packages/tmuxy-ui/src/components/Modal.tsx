import React, { useCallback } from 'react';
import { Tooltip } from './Tooltip';
import './Modal.css';

/** `.modal-header`'s height (Modal.css), for a caller that sizes the box around it. */
export const MODAL_HEADER_HEIGHT = 28;

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  width?: number;
  className?: string;
  /** Its place among the floats open over the tab, lowest first: lifts it on the float rung. */
  stack?: number;
  containerStyle?: React.CSSProperties;
  backdrop?: 'dim' | 'blur' | 'none';
  hideHeader?: boolean;
  /** Whether it can be dismissed at all: false drops the close button, and a click on the backdrop does nothing. */
  closable?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width,
  className,
  stack = 0,
  containerStyle,
  backdrop = 'dim',
  hideHeader = false,
  closable = true,
}: ModalProps) {
  const handleBackdropClick = useCallback(() => {
    if (closable) onClose();
  }, [closable, onClose]);

  if (!open) return null;

  const backdropClass =
    backdrop === 'blur'
      ? 'modal-backdrop modal-backdrop-blur'
      : backdrop === 'none'
        ? 'modal-backdrop modal-backdrop-none'
        : 'modal-backdrop';

  const showHeader = !hideHeader && title !== undefined;

  // Rendered in place, not portaled: the overlay is positioned against the
  // pane container, which keeps the backdrop over the tab's content only.
  // Portaled to the body it dimmed the sidebars, tab strip and status line.
  return (
    <div
      className={`modal-overlay${className ? ` ${className}` : ''}`}
      style={{ '--float-stack': stack } as React.CSSProperties}
    >
      <div className={backdropClass} onClick={handleBackdropClick} />
      <div
        className="modal-container"
        style={{ ...containerStyle, ...(width ? { width } : undefined) }}
      >
        {showHeader && (
          <div className="modal-header">
            <span className="modal-title">{title}</span>
            {closable && (
              <Tooltip label="Close">
                <button className="modal-close" onClick={onClose} aria-label="Close">
                  ×
                </button>
              </Tooltip>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
