import { memo, type ReactNode } from 'react';
import { getTabLabel } from './paneTabDisplay';
import { PaneIcon } from './PaneIcon';
import { PaneStateMark } from './PaneStateMark';
import { paneStateFor } from '../domain/paneState';
import { paneStateLabel } from '../domain/paneStatus';
import { InlineRename } from './InlineRename';
import { Tooltip } from './Tooltip';
import type { TmuxPane } from '../domain/client';

interface PaneTabInteraction {
  isSelectedTab: boolean;
  renaming: boolean;
  /** null when the edit was abandoned. */
  onRenameEnd: (name: string | null) => void;

  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /**
   * The member's own ✕, in its share of a group's header: one at the far
   * right would belong to whichever member happened to be showing. Null for an
   * ungrouped pane.
   */
  controls: ReactNode;
  /**
   * Opens the pane menu from the tab's icon. A tab may hold no control
   * (ARIA), so a member's icon is a pointer target and the tab's context menu
   * key reaches the same menu.
   */
  onFaceClick: (e: React.MouseEvent) => void;
  /** True for an ungrouped pane, whose header draws the icon as a button of its own. */
  faceless: boolean;
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

/** What leads a pane's title: its state while it has one, else its program's icon. */
export function PaneFace({ pane, titleOverride }: { pane: TmuxPane; titleOverride?: string }) {
  const state = paneStateFor(pane);
  return state !== 'idle' ? (
    <PaneStateMark
      state={state}
      label={paneStateLabel(state, pane)}
      className="pane-tab-icon pane-tab-state"
    />
  ) : (
    <PaneIcon
      pane={pane}
      titleOverride={titleOverride}
      className="pane-tab-icon pane-tab-icon-static"
    />
  );
}

export const PaneTab = memo(function PaneTab(props: PaneTabProps) {
  const { pane, isActivePane, titleOverride } = props;
  const text = getTabLabel(pane, titleOverride);
  const face = <PaneFace pane={pane} titleOverride={titleOverride} />;

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
    onFaceClick,
    faceless,
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
      {!faceless && (
        <Tooltip label="Pane menu">
          <span className="pane-tab-face-menu" aria-hidden="true" onClick={onFaceClick}>
            {face}
          </span>
        </Tooltip>
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
