/**
 * Prediction Calculators
 *
 * Calculate optimistic predictions for pane operations.
 * These predictions are applied immediately before server confirmation.
 */

import type { TmuxPane, TmuxWindow } from '../../../tmux/types';
import type {
  OptimisticOperation,
  SplitPrediction,
  NavigatePrediction,
  SwapPrediction,
  NewWindowPrediction,
  SelectWindowPrediction,
} from '../../types';
import type {
  ParsedCommand,
  SplitCommand,
  NavigateCommand,
  SwapCommand,
  SelectPaneCommand,
  NewWindowCommand,
  SelectWindowCommand,
} from './commandParser';

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
  command: string,
  paneActivationOrder: string[] = [],
  windows: TmuxWindow[] = [],
): OptimisticOperation | null {
  if (!parsed) return null;
  if (!activePaneId && parsed.type !== 'new-window') return null;

  switch (parsed.type) {
    case 'split':
      return calculateSplitPrediction(parsed, panes, activePaneId!, activeWindowId, command);
    case 'navigate':
      return calculateNavigatePrediction(
        parsed,
        panes,
        activePaneId!,
        command,
        paneActivationOrder,
      );
    case 'swap':
      return calculateSwapPrediction(parsed, panes, command);
    case 'select-pane':
      return calculateSelectPanePrediction(parsed, panes, activePaneId!, command);
    case 'new-window':
      return calculateNewWindowPrediction(parsed, windows, command);
    case 'select-window':
      return calculateSelectWindowPrediction(parsed, panes, activeWindowId, command, windows);
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
  command: string,
): OptimisticOperation | null {
  const activePane = panes.find((p) => p.tmuxId === activePaneId);
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

    resizedPanes = [
      {
        paneId: activePaneId,
        x: activePane.x,
        y: activePane.y,
        width: originalNewWidth,
        height: activePane.height,
      },
    ];
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

    resizedPanes = [
      {
        paneId: activePaneId,
        x: activePane.x,
        y: activePane.y,
        width: activePane.width,
        height: originalNewHeight,
      },
    ];
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
 * When multiple candidates overlap, pick the most recently used (MRU).
 */
function calculateNavigatePrediction(
  parsed: NavigateCommand,
  panes: TmuxPane[],
  activePaneId: string,
  command: string,
  paneActivationOrder: string[] = [],
): OptimisticOperation | null {
  const activePane = panes.find((p) => p.tmuxId === activePaneId);
  if (!activePane) return null;

  const targetPaneId = findAdjacentPane(panes, activePane, parsed.direction, paneActivationOrder);
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
 * Matches tmux's algorithm (window.c window_pane_find_*):
 * 1. Find all panes on the adjacent edge with any overlap
 * 2. Pick the most recently used (MRU) pane from candidates
 *
 * Adjacency detection:
 * - L: panes where (pane.x + pane.width + 1 === current.x) AND vertical overlap
 * - R: panes where (current.x + current.width + 1 === pane.x) AND vertical overlap
 * - U: panes where (pane.y + pane.height + 1 === current.y) AND horizontal overlap
 * - D: panes where (current.y + current.height + 1 === pane.y) AND horizontal overlap
 */
function findAdjacentPane(
  panes: TmuxPane[],
  current: TmuxPane,
  direction: 'L' | 'R' | 'U' | 'D',
  paneActivationOrder: string[] = [],
): string | null {
  // Only consider panes in the same window
  const samePanes = panes.filter(
    (p) => p.tmuxId !== current.tmuxId && p.windowId === current.windowId,
  );

  // Collect all adjacent candidates with any overlap (matching tmux's overlap check)
  const candidates: TmuxPane[] = [];

  for (const pane of samePanes) {
    let isAdjacent = false;
    let hasOverlap = false;

    switch (direction) {
      case 'L': {
        isAdjacent = pane.x + pane.width + 1 === current.x;
        if (isAdjacent) {
          // tmux overlap check: any of (fully contains, start within, end within)
          const top = current.y;
          const bottom = current.y + current.height;
          const pEnd = pane.y + pane.height - 1;
          hasOverlap =
            (pane.y < top && pEnd > bottom) ||
            (pane.y >= top && pane.y <= bottom) ||
            (pEnd >= top && pEnd <= bottom);
        }
        break;
      }
      case 'R': {
        isAdjacent = current.x + current.width + 1 === pane.x;
        if (isAdjacent) {
          const top = current.y;
          const bottom = current.y + current.height;
          const pEnd = pane.y + pane.height - 1;
          hasOverlap =
            (pane.y < top && pEnd > bottom) ||
            (pane.y >= top && pane.y <= bottom) ||
            (pEnd >= top && pEnd <= bottom);
        }
        break;
      }
      case 'U': {
        isAdjacent = pane.y + pane.height + 1 === current.y;
        if (isAdjacent) {
          const left = current.x;
          const right = current.x + current.width;
          const pEnd = pane.x + pane.width - 1;
          hasOverlap =
            (pane.x < left && pEnd > right) ||
            (pane.x >= left && pane.x <= right) ||
            (pEnd >= left && pEnd <= right);
        }
        break;
      }
      case 'D': {
        isAdjacent = current.y + current.height + 1 === pane.y;
        if (isAdjacent) {
          const left = current.x;
          const right = current.x + current.width;
          const pEnd = pane.x + pane.width - 1;
          hasOverlap =
            (pane.x < left && pEnd > right) ||
            (pane.x >= left && pane.x <= right) ||
            (pEnd >= left && pEnd <= right);
        }
        break;
      }
    }

    if (isAdjacent && hasOverlap) {
      candidates.push(pane);
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].tmuxId;

  // Multiple candidates: pick the most recently used (MRU) pane,
  // matching tmux's window_pane_choose_best (highest active_point)
  for (const paneId of paneActivationOrder) {
    const match = candidates.find((p) => p.tmuxId === paneId);
    if (match) return match.tmuxId;
  }

  // Fallback: first candidate (shouldn't happen if activation order is populated)
  return candidates[0].tmuxId;
}

/**
 * Calculate swap prediction.
 *
 * Exchange positions between source and target panes.
 */
function calculateSwapPrediction(
  parsed: SwapCommand,
  panes: TmuxPane[],
  command: string,
): OptimisticOperation | null {
  const sourcePane = panes.find((p) => p.tmuxId === parsed.sourcePaneId);
  const targetPane = panes.find((p) => p.tmuxId === parsed.targetPaneId);

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
  command: string,
): OptimisticOperation | null {
  const targetPane = panes.find((p) => p.tmuxId === parsed.paneId);
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
  activeWindowId: string | null,
  defaultShell: string = 'bash',
): TmuxPane[] {
  // Only apply to panes in the active window
  const result = panes.map((pane) => {
    if (pane.windowId !== activeWindowId) return pane;

    // Find if this pane was resized
    const resized = prediction.resizedPanes.find((r) => r.paneId === pane.tmuxId);
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
    command: defaultShell,
    title: '',
    borderTitle: '',
    inMode: false,
    copyCursorX: 0,
    copyCursorY: 0,
    alternateOn: false,
    mouseAnyFlag: false,
    paused: false,
    historySize: 0,
    selectionPresent: false,
    selectionStartX: 0,
    selectionStartY: 0,
  };

  return [...result, newPane];
}

/**
 * Apply a swap prediction to panes.
 * Returns new panes array with positions swapped.
 */
export function applySwapPrediction(panes: TmuxPane[], prediction: SwapPrediction): TmuxPane[] {
  return panes.map((pane) => {
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
export function applyNavigatePrediction(prediction: NavigatePrediction): string {
  return prediction.toPaneId;
}

/**
 * Calculate new window prediction.
 * Creates a placeholder window tab with a temporary ID.
 */
function calculateNewWindowPrediction(
  _parsed: NewWindowCommand,
  windows: TmuxWindow[],
  command: string,
): OptimisticOperation {
  const id = generateOptimisticId();
  // Determine the next window index (max index + 1)
  const maxIndex = windows.reduce((max, w) => Math.max(max, w.index), -1);

  return {
    id,
    type: 'new-window',
    command,
    timestamp: Date.now(),
    prediction: {
      type: 'new-window',
      placeholderWindowId: `__placeholder_${id}`,
      placeholderName: `Window ${maxIndex + 1}`,
    },
  };
}

/**
 * Apply a new window prediction to the windows array.
 * Adds a placeholder window tab that appears instantly.
 */
export function applyNewWindowPrediction(
  windows: TmuxWindow[],
  prediction: NewWindowPrediction,
): TmuxWindow[] {
  const maxIndex = windows.reduce((max, w) => Math.max(max, w.index), -1);

  const placeholderWindow: TmuxWindow = {
    id: prediction.placeholderWindowId,
    index: maxIndex + 1,
    name: prediction.placeholderName,
    active: false,
    isPaneGroupWindow: false,
    paneGroupPaneIds: null,
    isFloatWindow: false,
    floatPaneId: null,
  };

  return [...windows, placeholderWindow];
}

/**
 * Calculate select-window prediction.
 *
 * Determines the target window by index or relative navigation (next/previous).
 * Also determines which pane becomes active in the target window.
 */
function calculateSelectWindowPrediction(
  parsed: SelectWindowCommand,
  panes: TmuxPane[],
  activeWindowId: string | null,
  command: string,
  windows: TmuxWindow[],
): OptimisticOperation | null {
  if (!activeWindowId) return null;

  // Filter to visible windows (exclude group/float windows)
  const visibleWindows = windows.filter((w) => !w.isPaneGroupWindow && !w.isFloatWindow);
  if (visibleWindows.length === 0) return null;

  let targetWindow: TmuxWindow | undefined;

  if (typeof parsed.target === 'number') {
    targetWindow = visibleWindows.find((w) => w.index === parsed.target);
  } else {
    const currentIdx = visibleWindows.findIndex((w) => w.id === activeWindowId);
    if (currentIdx === -1) return null;

    if (parsed.target === 'next') {
      const nextIdx = (currentIdx + 1) % visibleWindows.length;
      targetWindow = visibleWindows[nextIdx];
    } else {
      const prevIdx = (currentIdx - 1 + visibleWindows.length) % visibleWindows.length;
      targetWindow = visibleWindows[prevIdx];
    }
  }

  if (!targetWindow || targetWindow.id === activeWindowId) return null;

  // Find the active pane in the target window
  const windowPanes = panes.filter((p) => p.windowId === targetWindow!.id);
  const activePaneInWindow = windowPanes.find((p) => p.active) ?? windowPanes[0];
  if (!activePaneInWindow) return null;

  return {
    id: generateOptimisticId(),
    type: 'select-window',
    command,
    timestamp: Date.now(),
    prediction: {
      type: 'select-window',
      fromWindowId: activeWindowId,
      toWindowId: targetWindow.id,
      toActivePaneId: activePaneInWindow.tmuxId,
    },
  };
}

/**
 * Apply a select-window prediction.
 * Returns the new activeWindowId and activePaneId.
 */
export function applySelectWindowPrediction(prediction: SelectWindowPrediction): {
  activeWindowId: string;
  activePaneId: string;
} {
  return {
    activeWindowId: prediction.toWindowId,
    activePaneId: prediction.toActivePaneId,
  };
}
