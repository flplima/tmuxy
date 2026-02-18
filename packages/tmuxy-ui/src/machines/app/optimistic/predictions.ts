/**
 * Prediction Calculators
 *
 * Calculate optimistic predictions for pane operations.
 * These predictions are applied immediately before server confirmation.
 */

import type { TmuxPane } from '../../../tmux/types';
import type {
  OptimisticOperation,
  SplitPrediction,
  NavigatePrediction,
  SwapPrediction,
} from '../../types';
import type { ParsedCommand, SplitCommand, NavigateCommand, SwapCommand, SelectPaneCommand } from './commandParser';

let optimisticIdCounter = 0;

/**
 * Generate a unique ID for optimistic operations.
 */
function generateOptimisticId(): string {
  return `opt_${Date.now()}_${++optimisticIdCounter}`;
}

/**
 * Calculate prediction for a parsed command.
 * Returns null if no optimistic prediction can be made.
 */
export function calculatePrediction(
  parsed: ParsedCommand,
  panes: TmuxPane[],
  activePaneId: string | null,
  activeWindowId: string | null,
  command: string
): OptimisticOperation | null {
  if (!parsed || !activePaneId) return null;

  switch (parsed.type) {
    case 'split':
      return calculateSplitPrediction(parsed, panes, activePaneId, activeWindowId, command);
    case 'navigate':
      return calculateNavigatePrediction(parsed, panes, activePaneId, command);
    case 'swap':
      return calculateSwapPrediction(parsed, panes, command);
    case 'select-pane':
      return calculateSelectPanePrediction(parsed, panes, activePaneId, command);
    default:
      return null;
  }
}

/**
 * Calculate split prediction.
 *
 * Tmux splits the active pane:
 * - `-h` = horizontal layout (side-by-side) → new pane on RIGHT
 * - `-v` = vertical layout (stacked) → new pane BELOW
 */
function calculateSplitPrediction(
  parsed: SplitCommand,
  panes: TmuxPane[],
  activePaneId: string,
  activeWindowId: string | null,
  command: string
): OptimisticOperation | null {
  const activePane = panes.find(p => p.tmuxId === activePaneId);
  if (!activePane) return null;

  const placeholderId = `__placeholder_${generateOptimisticId()}`;
  let newPane: SplitPrediction['newPane'];
  let resizedPanes: SplitPrediction['resizedPanes'];

  if (parsed.direction === 'vertical') {
    // Vertical split: new pane on RIGHT
    // Split width in half (tmux uses floor for original, ceiling for new)
    const newWidth = Math.floor(activePane.width / 2);
    const originalNewWidth = activePane.width - newWidth - 1; // -1 for separator

    newPane = {
      placeholderId,
      x: activePane.x + originalNewWidth + 1, // +1 for separator
      y: activePane.y,
      width: newWidth,
      height: activePane.height,
      windowId: activeWindowId ?? activePane.windowId,
    };

    resizedPanes = [{
      paneId: activePaneId,
      x: activePane.x,
      y: activePane.y,
      width: originalNewWidth,
      height: activePane.height,
    }];
  } else {
    // Horizontal split: new pane BELOW
    // Split height in half
    const newHeight = Math.floor(activePane.height / 2);
    const originalNewHeight = activePane.height - newHeight - 1; // -1 for separator

    newPane = {
      placeholderId,
      x: activePane.x,
      y: activePane.y + originalNewHeight + 1, // +1 for separator
      width: activePane.width,
      height: newHeight,
      windowId: activeWindowId ?? activePane.windowId,
    };

    resizedPanes = [{
      paneId: activePaneId,
      x: activePane.x,
      y: activePane.y,
      width: activePane.width,
      height: originalNewHeight,
    }];
  }

  return {
    id: generateOptimisticId(),
    type: 'split',
    command,
    timestamp: Date.now(),
    prediction: {
      type: 'split',
      direction: parsed.direction,
      targetPaneId: activePaneId,
      newPane,
      resizedPanes,
    },
  };
}

/**
 * Calculate navigation prediction.
 *
 * Find the nearest pane in the given direction based on adjacency.
 */
function calculateNavigatePrediction(
  parsed: NavigateCommand,
  panes: TmuxPane[],
  activePaneId: string,
  command: string
): OptimisticOperation | null {
  const activePane = panes.find(p => p.tmuxId === activePaneId);
  if (!activePane) return null;

  const targetPaneId = findAdjacentPane(panes, activePane, parsed.direction);
  if (!targetPaneId) return null;

  return {
    id: generateOptimisticId(),
    type: 'navigate',
    command,
    timestamp: Date.now(),
    prediction: {
      type: 'navigate',
      direction: parsed.direction,
      fromPaneId: activePaneId,
      toPaneId: targetPaneId,
    },
  };
}

/**
 * Find the pane adjacent to the given pane in the specified direction.
 *
 * Uses adjacency detection:
 * - L: panes where (pane.x + pane.width + 1 === current.x) AND vertical overlap
 * - R: panes where (current.x + current.width + 1 === pane.x) AND vertical overlap
 * - U: panes where (pane.y + pane.height + 1 === current.y) AND horizontal overlap
 * - D: panes where (current.y + current.height + 1 === pane.y) AND horizontal overlap
 */
function findAdjacentPane(
  panes: TmuxPane[],
  current: TmuxPane,
  direction: 'L' | 'R' | 'U' | 'D'
): string | null {
  // Only consider panes in the same window
  const candidates = panes.filter(p => p.tmuxId !== current.tmuxId && p.windowId === current.windowId);

  let bestMatch: TmuxPane | null = null;
  let bestOverlap = 0;

  for (const pane of candidates) {
    let isAdjacent = false;
    let overlap = 0;

    switch (direction) {
      case 'L':
        // Pane is to the left: its right edge touches current's left edge
        isAdjacent = pane.x + pane.width + 1 === current.x;
        if (isAdjacent) {
          // Calculate vertical overlap
          const overlapStart = Math.max(pane.y, current.y);
          const overlapEnd = Math.min(pane.y + pane.height, current.y + current.height);
          overlap = Math.max(0, overlapEnd - overlapStart);
        }
        break;

      case 'R':
        // Pane is to the right: current's right edge touches pane's left edge
        isAdjacent = current.x + current.width + 1 === pane.x;
        if (isAdjacent) {
          const overlapStart = Math.max(pane.y, current.y);
          const overlapEnd = Math.min(pane.y + pane.height, current.y + current.height);
          overlap = Math.max(0, overlapEnd - overlapStart);
        }
        break;

      case 'U':
        // Pane is above: its bottom edge touches current's top edge
        isAdjacent = pane.y + pane.height + 1 === current.y;
        if (isAdjacent) {
          // Calculate horizontal overlap
          const overlapStart = Math.max(pane.x, current.x);
          const overlapEnd = Math.min(pane.x + pane.width, current.x + current.width);
          overlap = Math.max(0, overlapEnd - overlapStart);
        }
        break;

      case 'D':
        // Pane is below: current's bottom edge touches pane's top edge
        isAdjacent = current.y + current.height + 1 === pane.y;
        if (isAdjacent) {
          const overlapStart = Math.max(pane.x, current.x);
          const overlapEnd = Math.min(pane.x + pane.width, current.x + current.width);
          overlap = Math.max(0, overlapEnd - overlapStart);
        }
        break;
    }

    if (isAdjacent && overlap > bestOverlap) {
      bestMatch = pane;
      bestOverlap = overlap;
    }
  }

  return bestMatch?.tmuxId ?? null;
}

/**
 * Calculate swap prediction.
 *
 * Exchange positions between source and target panes.
 */
function calculateSwapPrediction(
  parsed: SwapCommand,
  panes: TmuxPane[],
  command: string
): OptimisticOperation | null {
  const sourcePane = panes.find(p => p.tmuxId === parsed.sourcePaneId);
  const targetPane = panes.find(p => p.tmuxId === parsed.targetPaneId);

  if (!sourcePane || !targetPane) return null;

  return {
    id: generateOptimisticId(),
    type: 'swap',
    command,
    timestamp: Date.now(),
    prediction: {
      type: 'swap',
      sourcePaneId: parsed.sourcePaneId,
      targetPaneId: parsed.targetPaneId,
      sourceNewPosition: {
        x: targetPane.x,
        y: targetPane.y,
        width: targetPane.width,
        height: targetPane.height,
      },
      targetNewPosition: {
        x: sourcePane.x,
        y: sourcePane.y,
        width: sourcePane.width,
        height: sourcePane.height,
      },
    },
  };
}

/**
 * Calculate select-pane prediction (focus change).
 */
function calculateSelectPanePrediction(
  parsed: SelectPaneCommand,
  panes: TmuxPane[],
  activePaneId: string,
  command: string
): OptimisticOperation | null {
  const targetPane = panes.find(p => p.tmuxId === parsed.paneId);
  if (!targetPane || parsed.paneId === activePaneId) return null;

  return {
    id: generateOptimisticId(),
    type: 'navigate',
    command,
    timestamp: Date.now(),
    prediction: {
      type: 'navigate',
      direction: 'L', // Direction doesn't matter for direct selection
      fromPaneId: activePaneId,
      toPaneId: parsed.paneId,
    },
  };
}

/**
 * Apply a split prediction to panes.
 * Returns new panes array with the split applied.
 */
export function applySplitPrediction(
  panes: TmuxPane[],
  prediction: SplitPrediction,
  activeWindowId: string | null
): TmuxPane[] {
  // Only apply to panes in the active window
  const result = panes.map(pane => {
    if (pane.windowId !== activeWindowId) return pane;

    // Find if this pane was resized
    const resized = prediction.resizedPanes.find(r => r.paneId === pane.tmuxId);
    if (resized) {
      return {
        ...pane,
        x: resized.x,
        y: resized.y,
        width: resized.width,
        height: resized.height,
      };
    }
    return pane;
  });

  // Add the placeholder new pane
  const newPane: TmuxPane = {
    id: -1, // Placeholder
    tmuxId: prediction.newPane.placeholderId,
    windowId: prediction.newPane.windowId,
    content: [], // Empty content
    cursorX: 0,
    cursorY: 0,
    width: prediction.newPane.width,
    height: prediction.newPane.height,
    x: prediction.newPane.x,
    y: prediction.newPane.y,
    active: true, // New pane becomes active
    command: 'zsh', // Placeholder
    title: '',
    borderTitle: '',
    inMode: false,
    copyCursorX: 0,
    copyCursorY: 0,
    alternateOn: false,
    mouseAnyFlag: false,
    paused: false,
    selectionPresent: false,
    selectionStartX: 0,
    selectionStartY: 0,
    selMode: '',
  };

  return [...result, newPane];
}

/**
 * Apply a swap prediction to panes.
 * Returns new panes array with positions swapped.
 */
export function applySwapPrediction(
  panes: TmuxPane[],
  prediction: SwapPrediction
): TmuxPane[] {
  return panes.map(pane => {
    if (pane.tmuxId === prediction.sourcePaneId) {
      return {
        ...pane,
        x: prediction.sourceNewPosition.x,
        y: prediction.sourceNewPosition.y,
        width: prediction.sourceNewPosition.width,
        height: prediction.sourceNewPosition.height,
      };
    }
    if (pane.tmuxId === prediction.targetPaneId) {
      return {
        ...pane,
        x: prediction.targetNewPosition.x,
        y: prediction.targetNewPosition.y,
        width: prediction.targetNewPosition.width,
        height: prediction.targetNewPosition.height,
      };
    }
    return pane;
  });
}

/**
 * Apply a navigation prediction to get the new active pane ID.
 */
export function applyNavigatePrediction(
  prediction: NavigatePrediction
): string {
  return prediction.toPaneId;
}
