import React, { useCallback } from 'react';
import { Tooltip } from './Tooltip';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  width?: number;
  className?: string;
  zIndex?: number;
  containerStyle?: React.CSSProperties;
  /** Backdrop style: 'dim' (default), 'blur', or 'none' */
  backdrop?: 'dim' | 'blur' | 'none';
  /** Hide the header bar (title + close button) */
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
  zIndex = 1000,
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

  // Rendered in place, NOT portaled to the body: the overlay is absolutely
  // positioned against its nearest positioned ancestor, and a float's ancestor
  // is the pane container. That is what keeps the backdrop over the tab's
  // content only — portaled to the body it resolved against the viewport and
  // dimmed the sidebars, the tab strip and the status line with it.
  return (
    <div className={`modal-overlay${className ? ` ${className}` : ''}`} style={{ zIndex }}>
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
