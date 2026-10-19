import { useEffect } from 'react';
import { markSelectedRows } from '../utils/selectionRows';

/**
 * Keep the rows the browser's selection runs past marked (utils/selectionRows).
 * On every selection change, and on scroll too: the scroll view builds the
 * rows that come into view afresh, and a selection that stays put fires no
 * change while they do.
 */
export function useSelectionRows(): void {
  useEffect(() => {
    let frame = 0;
    const mark = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        markSelectedRows(document.getSelection());
      });
    };
    document.addEventListener('selectionchange', mark);
    document.addEventListener('scroll', mark, true);
    return () => {
      document.removeEventListener('selectionchange', mark);
      document.removeEventListener('scroll', mark, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
}
