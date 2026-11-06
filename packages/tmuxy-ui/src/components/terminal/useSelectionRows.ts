import { useEffect } from 'react';
import { markSelectedRows } from './selectionRows';

/**
 * On scroll too: the scroll view builds the rows coming into view afresh, and
 * a selection that stays put fires no `selectionchange` while they do.
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
