import { memo, type ReactNode } from 'react';
import { getTabLabel } from './paneTabDisplay';
import { PaneIcon } from './PaneIcon';
import { PaneStateMark } from './PaneStateMark';
import { paneStateFor } from '../domain/paneState';
import { InlineRename } from './InlineRename';
import type { TmuxPane } from '../domain/client';

interface PaneTabInteraction {
  isSelectedTab: boolean;
  renaming: boolean;
  /** null when the edit was abandoned. */
  onRenameEnd: (name: string | null) => void;

  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /**
   * The member's own ⋮ and ✕, in its share of a group's header: one pair at
   * the far right would belong to whichever member happened to be showing.
   * Null for an ungrouped pane.
   */
  controls: ReactNode;
  /** Where a pane being dragged over this header would land, against this tab. */
  dropMark: 'onto' | 'before' | 'after' | null;
  dragging: boolean;
}

type PaneTabProps = {
  pane: TmuxPane;
  isActivePane: boolean;
  titleOverride?: string;
} & (
  | PaneTabInteraction
  /** A picture of the tab (TabShot): drawn the same, but nothing to press. */
  | { still: true }
);

export const PaneTab = memo(function PaneTab(props: PaneTabProps) {
  const { pane, isActivePane, titleOverride } = props;
  const text = getTabLabel(pane, titleOverride);
  const state = paneStateFor(pane);

  const face =
    state !== 'idle' ? (
      <PaneStateMark state={state} className="pane-tab-icon pane-tab-state" />
    ) : (
      <PaneIcon
        pane={pane}
        titleOverride={titleOverride}
        className="pane-tab-icon pane-tab-icon-static"
      />
    );

  if ('still' in props) {
    return (
      <div className={`pane-tab${isActivePane ? ' pane-tab-active' : ''}`}>
        {face}
        <span className="pane-tab-title">{text}</span>
      </div>
    );
  }

  const {
    isSelectedTab,
    renaming,
    onRenameEnd,
    onClick,
    onContextMenu,
    controls,
    dropMark,
    dragging,
  } = props;
  return (
    <div
      className={`pane-tab ${isActivePane ? 'pane-tab-active' : ''} ${isSelectedTab ? 'pane-tab-selected' : ''} ${dropMark ? `pane-tab-drop-${dropMark}` : ''} ${dragging ? 'pane-tab-dragging' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      role="tab"
      // Roving tabindex: the strip's one tab stop is the tab it shows.
      tabIndex={isSelectedTab ? 0 : -1}
      aria-selected={isSelectedTab}
      aria-label={`Pane ${pane.tmuxId}`}
      data-pane-tab={pane.tmuxId}
    >
      {face}
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
