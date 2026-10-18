import type { WireImagePlacement } from '../../../../domain/wire';
import type { LifoShell } from './LifoShell';

// ============================================
// Layout Tree
// ============================================

export interface LayoutLeaf {
  type: 'leaf';
  paneId: string;
}

export interface LayoutSplit {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  ratio: number; // 0..1, fraction allocated to first child
  children: [LayoutNode, LayoutNode];
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

// ============================================
// Internal Types
// ============================================

export interface FakePane {
  id: string;
  numericId: number;
  windowId: string;
  shell: LifoShell;
  command: string;
  /**
   * App-set pane title (OSC 0/2). Empty until something sets one, mirroring
   * what real tmux reports through `APP_PANE_TITLE` — the pane header then
   * falls back to `command`.
   */
  title: string;
  /** Image placements injected into this pane (storybook / test-only path). */
  images?: WireImagePlacement[];
}

export interface FakeWindow {
  id: string;
  index: number;
  name: string;
  manualName: boolean; // true if renamed manually, prevents auto-update from cwd
  layout: LayoutNode;
  layoutCycle: number; // tracks position in layout cycle
  windowType: 'tab' | 'float' | 'group' | 'sidebar-left' | 'sidebar-right';
  groupPanes: string[] | null;
  // Float options (only meaningful when windowType === 'float'). Mirror the
  // @tmuxy-float-* tmux window options the real CLI sets via bin/tmuxy/float-create.
  /** Dragged width of a sidebar column, in cells (@tmuxy-sidebar-cols). */
  sidebarCols?: number | null;
  /** The user closed this sidebar column (@tmuxy-sidebar-hidden). */
  sidebarHidden?: boolean;
  /** Only the active pane's first-level row is expanded (@tmuxy-collapsible). */
  collapsible?: boolean;
  /** The tab a float was opened over (@tmuxy-float-parent). */
  floatParent?: string | null;
  floatDrawer?: 'left' | 'right' | 'top' | 'bottom' | null;
  floatBg?: 'dim' | 'blur' | 'none' | null;
  floatNoheader?: boolean;
  floatWidth?: number | null;
  floatHeight?: number | null;
}

export interface CreateFloatOptions {
  drawer?: 'left' | 'right' | 'top' | 'bottom';
  bg?: 'dim' | 'blur' | 'none';
  hideHeader?: boolean;
  width?: number;
  height?: number;
}

/**
 * Index for hidden windows (groups, floats). Far above any real tab index so
 * hidden chrome never collides with — or reorders — the user's tabs.
 */
export const GROUP_WINDOW_INDEX_BASE = 1000;

/** Default float size in cells, mirroring bin/tmuxy/float-create. */
export const FLOAT_DEFAULT_COLS = 60;
export const FLOAT_DEFAULT_ROWS = 15;

export const LAYOUT_NAMES = [
  'even-horizontal',
  'even-vertical',
  'main-horizontal',
  'main-vertical',
  'tiled',
];

export function findPaneInDirection(
  layout: LayoutNode,
  activePaneId: string,
  direction: string,
  totalWidth: number,
  totalHeight: number,
): string | null {
  const positions = computePositions(layout, 0, 0, totalWidth, totalHeight);
  const current = positions.find((p) => p.paneId === activePaneId);
  if (!current) return null;

  // tmux-style navigation: candidate must share an edge overlap in the
  // perpendicular axis and be adjacent in the primary axis. Among valid
  // candidates, pick the one whose center is closest in the primary axis,
  // breaking ties by perpendicular center distance.
  let best: { paneId: string; primaryDist: number; crossDist: number } | null = null;
  for (const pos of positions) {
    if (pos.paneId === activePaneId) continue;

    let adjacent = false;
    let overlaps = false;
    let primaryDist = 0;
    let crossDist = 0;

    const cx = current.x + current.width / 2;
    const cy = current.y + current.height / 2;
    const px = pos.x + pos.width / 2;
    const py = pos.y + pos.height / 2;

    switch (direction) {
      case 'Up':
        adjacent = pos.y + pos.height <= current.y;
        overlaps = pos.x < current.x + current.width && pos.x + pos.width > current.x;
        primaryDist = current.y - (pos.y + pos.height);
        crossDist = Math.abs(px - cx);
        break;
      case 'Down':
        adjacent = pos.y >= current.y + current.height;
        overlaps = pos.x < current.x + current.width && pos.x + pos.width > current.x;
        primaryDist = pos.y - (current.y + current.height);
        crossDist = Math.abs(px - cx);
        break;
      case 'Left':
        adjacent = pos.x + pos.width <= current.x;
        overlaps = pos.y < current.y + current.height && pos.y + pos.height > current.y;
        primaryDist = current.x - (pos.x + pos.width);
        crossDist = Math.abs(py - cy);
        break;
      case 'Right':
        adjacent = pos.x >= current.x + current.width;
        overlaps = pos.y < current.y + current.height && pos.y + pos.height > current.y;
        primaryDist = pos.x - (current.x + current.width);
        crossDist = Math.abs(py - cy);
        break;
    }

    if (adjacent && overlaps) {
      if (
        !best ||
        primaryDist < best.primaryDist ||
        (primaryDist === best.primaryDist && crossDist < best.crossDist)
      ) {
        best = { paneId: pos.paneId, primaryDist, crossDist };
      }
    }
  }

  return best ? best.paneId : null;
}

export function buildNamedLayout(name: string, paneIds: string[]): LayoutNode {
  switch (name) {
    case 'even-horizontal':
      return buildEvenHorizontal(paneIds);
    case 'even-vertical':
      return buildEvenVertical(paneIds);
    case 'main-horizontal':
      return buildMainHorizontal(paneIds);
    case 'main-vertical':
      return buildMainVertical(paneIds);
    case 'tiled':
      return buildTiled(paneIds);
    default:
      return buildTiled(paneIds);
  }
}

export function swapLeafIds(node: LayoutNode, idA: string, idB: string): LayoutNode {
  if (node.type === 'leaf') {
    if (node.paneId === idA) return { type: 'leaf', paneId: idB };
    if (node.paneId === idB) return { type: 'leaf', paneId: idA };
    return node;
  }
  return {
    ...node,
    children: [swapLeafIds(node.children[0], idA, idB), swapLeafIds(node.children[1], idA, idB)],
  };
}

/** Replace a pane ID in the layout tree */
export function replaceLeafId(node: LayoutNode, oldId: string, newId: string): LayoutNode {
  if (node.type === 'leaf') {
    return node.paneId === oldId ? { type: 'leaf', paneId: newId } : node;
  }
  return {
    ...node,
    children: [
      replaceLeafId(node.children[0], oldId, newId),
      replaceLeafId(node.children[1], oldId, newId),
    ],
  };
}

export function collectLeafIds(node: LayoutNode): string[] {
  if (node.type === 'leaf') return [node.paneId];
  return [...collectLeafIds(node.children[0]), ...collectLeafIds(node.children[1])];
}

/** All panes side by side (vertical splits) */
function buildEvenHorizontal(paneIds: string[]): LayoutNode {
  return buildBalancedTree(paneIds, 'vertical');
}

/** All panes stacked (horizontal splits) */
function buildEvenVertical(paneIds: string[]): LayoutNode {
  return buildBalancedTree(paneIds, 'horizontal');
}

/** One big pane on top, rest equally distributed below */
function buildMainHorizontal(paneIds: string[]): LayoutNode {
  if (paneIds.length <= 1) return { type: 'leaf', paneId: paneIds[0] };
  const main: LayoutNode = { type: 'leaf', paneId: paneIds[0] };
  const rest = buildBalancedTree(paneIds.slice(1), 'vertical');
  return { type: 'split', direction: 'horizontal', ratio: 0.6, children: [main, rest] };
}

/** One big pane on left, rest equally distributed to the right */
function buildMainVertical(paneIds: string[]): LayoutNode {
  if (paneIds.length <= 1) return { type: 'leaf', paneId: paneIds[0] };
  const main: LayoutNode = { type: 'leaf', paneId: paneIds[0] };
  const rest = buildBalancedTree(paneIds.slice(1), 'horizontal');
  return { type: 'split', direction: 'vertical', ratio: 0.6, children: [main, rest] };
}

/** Grid layout: rows × cols */
function buildTiled(paneIds: string[]): LayoutNode {
  const count = paneIds.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);

  // Build rows, each row is a horizontal chain of panes
  const rowNodes: LayoutNode[] = [];
  for (let r = 0; r < rows; r++) {
    const rowPanes = paneIds.slice(r * cols, Math.min((r + 1) * cols, count));
    rowNodes.push(buildBalancedTree(rowPanes, 'vertical'));
  }
  return buildBalancedTree(rowNodes, 'horizontal');
}

function buildBalancedTree(
  items: (string | LayoutNode)[],
  direction: 'horizontal' | 'vertical',
): LayoutNode {
  if (items.length === 1) {
    const item = items[0];
    return typeof item === 'string' ? { type: 'leaf', paneId: item } : item;
  }
  const mid = Math.ceil(items.length / 2);
  const left = buildBalancedTree(items.slice(0, mid), direction);
  const right = buildBalancedTree(items.slice(mid), direction);
  return {
    type: 'split',
    direction,
    ratio: mid / items.length,
    children: [left, right],
  };
}

export function splitLeaf(
  node: LayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: 'horizontal' | 'vertical',
): LayoutNode {
  if (node.type === 'leaf') {
    if (node.paneId === targetPaneId) {
      return {
        type: 'split',
        direction,
        ratio: 0.5,
        children: [
          { type: 'leaf', paneId: targetPaneId },
          { type: 'leaf', paneId: newPaneId },
        ],
      };
    }
    return node;
  }
  return {
    ...node,
    children: [
      splitLeaf(node.children[0], targetPaneId, newPaneId, direction),
      splitLeaf(node.children[1], targetPaneId, newPaneId, direction),
    ],
  };
}

export function removeLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === 'leaf') {
    return node.paneId === paneId ? null : node;
  }
  const left = removeLeaf(node.children[0], paneId);
  const right = removeLeaf(node.children[1], paneId);
  if (!left) return right;
  if (!right) return left;
  return { ...node, children: [left, right] };
}

export function computePositions(
  node: LayoutNode,
  x: number,
  y: number,
  width: number,
  height: number,
): Array<{ paneId: string; x: number; y: number; width: number; height: number }> {
  if (node.type === 'leaf') {
    if (y === 0) {
      // Top of grid: header occupies row 0, content starts at row 1.
      // Report y=1, height=height-1 (content rows only) — matches real tmux.
      return [{ paneId: node.paneId, x, y: 1, width, height: Math.max(height - 1, 1) }];
    }
    // Below a separator: header sits in separator row at y-1 (no adjustment needed).
    return [{ paneId: node.paneId, x, y, width, height }];
  }

  if (node.direction === 'vertical') {
    const leftW = Math.floor(width * node.ratio);
    const rightW = width - leftW - 1; // -1 for separator
    return [
      ...computePositions(node.children[0], x, y, leftW, height),
      ...computePositions(node.children[1], x + leftW + 1, y, Math.max(rightW, 1), height),
    ];
  } else {
    const topH = Math.floor(height * node.ratio);
    const bottomH = height - topH - 1; // -1 for separator
    return [
      ...computePositions(node.children[0], x, y, width, topH),
      ...computePositions(node.children[1], x, y + topH + 1, width, Math.max(bottomH, 1)),
    ];
  }
}

export function applyWindowLayout(
  window: FakeWindow,
  panes: Map<string, FakePane>,
  totalWidth: number,
  totalHeight: number,
): void {
  const positions = computePositions(window.layout, 0, 0, totalWidth, totalHeight);
  for (const pos of positions) {
    const pane = panes.get(pos.paneId);
    if (pane) {
      pane.shell.resize(Math.max(pos.width, 1), Math.max(pos.height, 1));
    }
  }
}

export function adjustRatio(
  node: LayoutNode,
  paneId: string,
  direction: string,
  adjustment: number,
  availWidth: number,
  availHeight: number,
): boolean {
  if (node.type === 'leaf') return false;

  // Check if either child contains the pane
  const leftContains = containsPane(node.children[0], paneId);
  const rightContains = containsPane(node.children[1], paneId);

  if (leftContains && rightContains) return false; // shouldn't happen

  if (leftContains || rightContains) {
    // Check if the split direction matches the resize direction
    const isVerticalResize = direction === 'Left' || direction === 'Right';
    const isHorizontalResize = direction === 'Up' || direction === 'Down';

    if (
      (node.direction === 'vertical' && isVerticalResize) ||
      (node.direction === 'horizontal' && isHorizontalResize)
    ) {
      // Convert cell-based adjustment to ratio delta using available space
      const available = node.direction === 'vertical' ? availWidth : availHeight;
      const delta = adjustment / Math.max(available, 1);
      const grow =
        (leftContains && (direction === 'Right' || direction === 'Down')) ||
        (rightContains && (direction === 'Left' || direction === 'Up'));
      node.ratio = Math.max(0.1, Math.min(0.9, node.ratio + (grow ? delta : -delta)));
      return true;
    }

    // Recurse into the child that contains the pane, propagating available space
    if (node.direction === 'vertical') {
      const leftW = Math.floor(availWidth * node.ratio);
      const rightW = availWidth - leftW - 1;
      if (leftContains)
        return adjustRatio(node.children[0], paneId, direction, adjustment, leftW, availHeight);
      return adjustRatio(node.children[1], paneId, direction, adjustment, rightW, availHeight);
    } else {
      const topH = Math.floor(availHeight * node.ratio);
      const bottomH = availHeight - topH - 1;
      if (leftContains)
        return adjustRatio(node.children[0], paneId, direction, adjustment, availWidth, topH);
      return adjustRatio(node.children[1], paneId, direction, adjustment, availWidth, bottomH);
    }
  }

  return false;
}

export function containsPane(node: LayoutNode, paneId: string): boolean {
  if (node.type === 'leaf') return node.paneId === paneId;
  return containsPane(node.children[0], paneId) || containsPane(node.children[1], paneId);
}
