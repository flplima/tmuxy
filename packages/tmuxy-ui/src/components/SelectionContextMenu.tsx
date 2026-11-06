/**
 * SelectionContextMenu - Right-click context menu for selected text.
 *
 * Copy the selection, type it into the pane, or hand it to a plugin.
 * A floating surface at the point that was right-clicked, like every other
 * menu (components/floating/Menu).
 */

import { useEffect } from 'react';
import { FloatingMenu } from './floating/Menu';
import { useAppSelector, useAppSend } from '../machines/appHooks';
import { TmuxOp } from '../domain/commands';
import { selectionMenuSpec } from './menus/specs/selectionMenu';
import { renderSpec, useMenuDispatch } from './menus/SpecMenu';
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
  useSelectionPinned(selectionRange);
  const plugins = useAppSelector((ctx) => ctx.plugins);
  const spec = selectionMenuSpec(plugins);

  // Every action is the end of the selection's job: the scrollback view (or
  // copy mode) closes with the menu.
  const dispatch = useMenuDispatch({
    onLocal: (local) => {
      if (local.verb === 'copy-selection') {
        writeClipboard(selectedText, paneId);
        flashCopiedRange(selectionRange);
      } else if (local.verb === 'send-selection') {
        send({ type: 'DISPATCH_OP', op: TmuxOp.SendText({ target: paneId, text: selectedText }) });
      } else if (local.verb === 'plugin-selection') {
        send({
          type: 'PLUGIN_ACTION',
          plugin: local.plugin,
          action: local.action,
          paneId,
          selection: selectedText,
        });
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
