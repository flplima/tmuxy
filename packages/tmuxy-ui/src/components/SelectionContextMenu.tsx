/**
 * SelectionContextMenu - Right-click context menu for selected text.
 *
 * Two things to do with a selection: copy it, or type it into the pane.
 * A floating surface at the point that was right-clicked, like every other
 * menu (components/floating/Menu).
 */

import { useEffect } from 'react';
import { FloatingMenu } from './floating/Menu';
import { useAppSend } from '../machines/appHooks';
import { TmuxOp } from '../domain/commands';
import { selectionMenuSpec } from '../domain/menus/selectionMenu';
import { renderSpec, useMenuDispatch } from './menus/SpecMenu';
import { useMenuEnv } from './menus/menuEnv';
import { flashCopiedRange } from '../utils/copyFlash';
import { writeClipboard } from '../utils/clipboard';
import type { PaneId } from '../domain/ids';
import { useNativeMenu } from './menus/useNativeMenu';

interface SelectionContextMenuProps {
  paneId: PaneId;
  x: number;
  y: number;
  selectedText: string;
  /** The browser's selection the menu is about, kept on screen while it is up. */
  selectionRange?: Range | null;
  onClose: () => void;
}

/**
 * Pin the browser's selection to `range` for as long as the menu is mounted.
 *
 * WebKit collapses the selection on any focus move, and the menu takes focus
 * when it opens; putting the range back on every `selectionchange` keeps the
 * text the menu is about highlighted until it closes.
 */
function useSelectionPinned(range: Range | null): void {
  useEffect(() => {
    if (!range || range.collapsed || typeof window === 'undefined') return;
    const restore = () => {
      const current = window.getSelection();
      if (!current || (current.rangeCount > 0 && !current.isCollapsed)) return;
      current.removeAllRanges();
      current.addRange(range);
    };
    restore();
    document.addEventListener('selectionchange', restore);
    return () => document.removeEventListener('selectionchange', restore);
  }, [range]);
}

export function SelectionContextMenu({
  paneId,
  x,
  y,
  selectedText,
  selectionRange = null,
  onClose,
}: SelectionContextMenuProps) {
  const send = useAppSend();
  const env = useMenuEnv();
  useSelectionPinned(selectionRange);
  const spec = selectionMenuSpec(env);

  // Either action is the end of the selection's job: the scrollback view (or
  // copy mode) closes with the menu.
  const dispatch = useMenuDispatch({
    onLocal: (id) => {
      if (id === 'copy') {
        writeClipboard(selectedText, paneId);
        flashCopiedRange(selectionRange);
      } else if (id === 'send-keys') {
        send({ type: 'DISPATCH_OP', op: TmuxOp.SendText({ target: paneId, text: selectedText }) });
      }
      send({ type: 'EXIT_COPY_MODE', paneId });
      onClose();
    },
  });

  const inApp = useNativeMenu(spec, dispatch, { x, y }, onClose);
  if (!inApp) return null;

  return (
    <FloatingMenu
      id="selection-context-menu"
      label="Selection"
      anchor={{ kind: 'point', x, y }}
      onClose={onClose}
    >
      {renderSpec(spec, dispatch)}
    </FloatingMenu>
  );
}
