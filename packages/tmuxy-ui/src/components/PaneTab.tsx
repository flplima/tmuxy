/**
 * PaneTab - Individual tab inside a PaneHeader tablist.
 */

import { memo, type ReactNode } from 'react';
import { useAppSelector } from '../machines/AppContext';
import { getTabIcon, getTabLabel } from './paneTabDisplay';
import { PaneStateMark } from './PaneStateMark';
import { paneStateFor } from '../utils/paneState';
import { InlineRename } from './InlineRename';
import type { TmuxPane } from '../domain/client';

export const PaneTab = memo(function PaneTab({
  pane,
  isSelectedTab,
  isActivePane,
  titleOverride,
  widgetName,
  renaming,
  onRenameEnd,
  disabled,
  onClick,
  onContextMenu,
  controls,
  dropMark,
  dragging,
}: {
  pane: TmuxPane;
  isSelectedTab: boolean;
  isActivePane: boolean;
  titleOverride?: string;
  widgetName?: string;
  /** This pane's title is being edited in place. */
  renaming: boolean;
  /** The new title, or null if the edit was abandoned. */
  onRenameEnd: (name: string | null) => void;
  /** Shown but not selectable: a parked group member, to a client that cannot swap it in. */
  disabled: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /**
   * The member's own ⋮ and ✕, drawn at the right of ITS share of the header.
   * A group's header is divided between its members, so a single pair of
   * buttons at the far right would have belonged to whichever member happened
   * to be showing — and there is no way to tell that by looking. Null for an
   * ungrouped pane, whose buttons stay at the header's own right edge.
   */
  controls: ReactNode;
  /** Where a pane being dragged over this header would land, against this tab. */
  dropMark: 'onto' | 'before' | 'after' | null;
  /** This member is the pane being dragged. */
  dragging: boolean;
}) {
  const icon = getTabIcon(pane, widgetName, titleOverride);
  const text = getTabLabel(pane, titleOverride);
  // What the pane is doing takes the icon's place while it is anything but idle.
  const unread = useAppSelector((ctx) => ctx.unreadPaneIds.includes(pane.tmuxId));
  const state = paneStateFor(pane, unread);

  return (
    <div
      className={`pane-tab ${isActivePane ? 'pane-tab-active' : ''} ${isSelectedTab ? 'pane-tab-selected' : ''} ${disabled ? 'pane-tab-disabled' : ''} ${dropMark ? `pane-tab-drop-${dropMark}` : ''} ${dragging ? 'pane-tab-dragging' : ''}`}
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled}
      onContextMenu={onContextMenu}
      role="tab"
      // The strip's one tab stop is the tab it shows.
      tabIndex={isSelectedTab && !disabled ? 0 : -1}
      aria-selected={isSelectedTab}
      aria-label={`Pane ${pane.tmuxId}`}
      data-pane-tab={pane.tmuxId}
    >
      {state !== 'idle' ? (
        <PaneStateMark state={state} className="pane-tab-icon pane-tab-state" />
      ) : (
        icon && <span className="pane-tab-icon pane-tab-icon-static">{icon}</span>
      )}
      {renaming ? (
        <InlineRename
          className="pane-tab-input"
          value={text}
          ariaLabel={`Rename pane ${pane.tmuxId}`}
          onCommit={(name) => onRenameEnd(name)}
          onCancel={() => onRenameEnd(null)}
        />
      ) : (
        <span className="pane-tab-title">{text}</span>
      )}
      {controls}
    </div>
  );
});
