import { useAppSend } from '../machines/AppContext';
import type { PaneStack } from '../machines/types';
import type { TmuxPane } from '../tmux/types';
import './PaneHeader.css';

interface PaneHeaderProps {
  tmuxId: string;
  paneIndex: number;
  command: string;
  isActive: boolean;
  stack?: PaneStack;
  stackPanes?: TmuxPane[]; // All panes in the stack (for tab display)
}

export function PaneHeader({
  tmuxId,
  paneIndex,
  command,
  isActive,
  stack,
  stackPanes,
}: PaneHeaderProps) {
  const send = useAppSend();

  const handleClose = (e: React.MouseEvent, paneId: string = tmuxId) => {
    e.preventDefault();
    e.stopPropagation();
    if (stack && stack.paneIds.length > 1) {
      // Close pane in stack
      send({ type: 'STACK_CLOSE_PANE', stackId: stack.id, paneId });
    } else {
      // Close regular pane
      send({ type: 'FOCUS_PANE', paneId });
      send({ type: 'SEND_COMMAND', command: 'kill-pane' });
    }
  };

  const handleAddToStack = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    send({ type: 'STACK_ADD_PANE', paneId: tmuxId });
  };

  const handleSwitchTab = (e: React.MouseEvent, paneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (stack) {
      send({ type: 'STACK_SWITCH', stackId: stack.id, paneId });
    }
  };

  const handleDragStart = (e: React.MouseEvent) => {
    // Prevent drag on buttons
    const target = e.target as HTMLElement;
    if (
      target.classList.contains('pane-close') ||
      target.classList.contains('pane-add') ||
      target.classList.contains('stack-tab')
    ) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    send({
      type: 'DRAG_START',
      paneId: tmuxId,
      startX: e.clientX,
      startY: e.clientY,
    });
  };

  // Render as tabs if this pane is part of a stack with multiple panes
  const isStacked = stack && stack.paneIds.length > 1;

  if (isStacked && stackPanes) {
    return (
      <div
        className={`pane-header pane-header-stacked ${isActive ? 'pane-header-active' : ''}`}
        onMouseDown={handleDragStart}
        role="tablist"
        aria-label={`Stack with ${stackPanes.length} panes`}
      >
        <div className="stack-tabs">
          {stackPanes.map((pane) => {
            const isActiveTab = stack.paneIds[stack.activeIndex] === pane.tmuxId;
            return (
              <div
                key={pane.tmuxId}
                className={`stack-tab ${isActiveTab ? 'stack-tab-active' : ''}`}
                onClick={(e) => handleSwitchTab(e, pane.tmuxId)}
                role="tab"
                aria-selected={isActiveTab}
                aria-label={`Pane ${pane.id}: ${pane.command}`}
              >
                <span className="stack-tab-index">{pane.id}</span>
                <span className="stack-tab-command">{pane.command}</span>
                <button
                  className="stack-tab-close"
                  onClick={(e) => handleClose(e, pane.tmuxId)}
                  title="Close tab"
                  aria-label={`Close pane ${pane.id}`}
                >
                  &times;
                </button>
              </div>
            );
          })}
        </div>
        <button className="pane-add" onClick={handleAddToStack} title="Add to stack" aria-label={`Add pane to stack ${stack.id}`}>
          +
        </button>
      </div>
    );
  }

  // Regular single-pane header
  return (
    <div
      className={`pane-header ${isActive ? 'pane-header-active' : ''}`}
      onMouseDown={handleDragStart}
      role="toolbar"
      aria-label={`Pane ${paneIndex} toolbar`}
    >
      <span className="pane-index">{paneIndex}</span>
      <span className="pane-command">{command}</span>
      <span className="pane-id">{tmuxId}</span>
      <button className="pane-add" onClick={handleAddToStack} title="Add to stack" aria-label={`Stack pane ${paneIndex}`}>
        +
      </button>
      <button className="pane-close" onClick={(e) => handleClose(e)} title="Close pane" aria-label={`Close pane ${paneIndex}`}>
        &times;
      </button>
    </div>
  );
}
