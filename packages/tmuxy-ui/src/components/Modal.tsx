import React, { useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  width?: number;
  className?: string;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  zIndex?: number;
  containerStyle?: React.CSSProperties;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width,
  className,
  closeOnBackdrop = true,
  closeOnEsc = true,
  zIndex = 1000,
  containerStyle,
}: ModalProps) {
  const handleBackdropClick = useCallback(() => {
    if (closeOnBackdrop) onClose();
  }, [closeOnBackdrop, onClose]);

  useEffect(() => {
    if (!open || !closeOnEsc) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, closeOnEsc, onClose]);

  if (!open) return null;

  return createPortal(
    <div className={`modal-overlay${className ? ` ${className}` : ''}`} style={{ zIndex }}>
      <div className="modal-backdrop" onClick={handleBackdropClick} />
      <div
        className="modal-container"
        style={{ ...containerStyle, ...(width ? { width } : undefined) }}
      >
        {title !== undefined && (
          <div className="modal-header">
            <span className="modal-title">{title}</span>
            <button className="modal-close" onClick={onClose} title="Close">
              ×
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
