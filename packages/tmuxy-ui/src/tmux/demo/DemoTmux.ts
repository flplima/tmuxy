import type { ServerState, ServerPane, ServerWindow, PaneContent } from '../types';
import { VirtualFS } from './virtualFs';
import { DemoShell } from './DemoShell';

// ============================================
// Layout Tree
// ============================================

interface LayoutLeaf {
  type: 'leaf';
  paneId: string;
}

interface LayoutSplit {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  ratio: number; // 0..1, fraction allocated to first child
  children: [LayoutNode, LayoutNode];
}

type LayoutNode = LayoutLeaf | LayoutSplit;

// ============================================
// Internal Types
// ============================================

interface FakePane {
  id: string;
  numericId: number;
  windowId: string;
  shell: DemoShell;
  command: string;
  title: string;
}

interface FakeWindow {
  id: string;
  index: number;
  name: string;
  layout: LayoutNode;
}

// ============================================
// DemoTmux Engine
// ============================================

export class DemoTmux {
  private panes = new Map<string, FakePane>();
  private windows: FakeWindow[] = [];
  private activeWindowId = '@0';
  private activePaneId = '%0';
  private nextPaneNum = 0;
  private nextWindowNum = 0;
  private totalWidth = 80;
  private totalHeight = 24;
  private vfs: VirtualFS;
  private sessionName = 'demo';

  constructor() {
    this.vfs = new VirtualFS();
  }

  /** Initialize with one window and one pane. Writes welcome banner. */
  init(width: number, height: number): void {
    this.totalWidth = width || 80;
    this.totalHeight = height || 24;

    const paneId = this.allocPaneId();
    const windowId = this.allocWindowId();

    const shell = new DemoShell(this.vfs, this.totalWidth, this.totalHeight);
    shell.writeBanner();
    shell.writePrompt();

    const pane: FakePane = {
      id: paneId,
      numericId: parseInt(paneId.slice(1)),
      windowId,
      shell,
      command: 'bash',
      title: 'bash',
    };
    this.panes.set(paneId, pane);

    const window: FakeWindow = {
      id: windowId,
      index: 0,
      name: 'bash',
      layout: { type: 'leaf', paneId },
    };
    this.windows.push(window);

    this.activeWindowId = windowId;
    this.activePaneId = paneId;
  }

  setSize(cols: number, rows: number): void {
    this.totalWidth = cols;
    this.totalHeight = rows;
    // Resize all panes according to layout
    for (const win of this.windows) {
      this.applyLayout(win);
    }
  }

  getState(): ServerState {
    // Compute pane positions from layout
    const window = this.getActiveWindow();
    const panePositions = window
      ? this.computePositions(window.layout, 0, 0, this.totalWidth, this.totalHeight)
      : [];
    const posMap = new Map(panePositions.map((p) => [p.paneId, p]));

    const panes: ServerPane[] = [];
    for (const [, pane] of this.panes) {
      const pos = posMap.get(pane.id);
      // Only include panes from active window
      if (pane.windowId !== this.activeWindowId) continue;
      panes.push({
        id: pane.numericId,
        tmux_id: pane.id,
        window_id: pane.windowId,
        content: pane.shell.getContent(),
        cursor_x: pane.shell.getCursorX(),
        cursor_y: pane.shell.getCursorY(),
        width: pos?.width ?? this.totalWidth,
        height: pos?.height ?? this.totalHeight,
        x: pos?.x ?? 0,
        y: pos?.y ?? 0,
        active: pane.id === this.activePaneId,
        command: pane.command,
        title: pane.title,
        border_title: '',
        in_mode: false,
        copy_cursor_x: 0,
        copy_cursor_y: 0,
      });
    }

    const windows: ServerWindow[] = this.windows.map((w) => ({
      id: w.id,
      index: w.index,
      name: w.name,
      active: w.id === this.activeWindowId,
      is_pane_group_window: false,
    }));

    return {
      session_name: this.sessionName,
      active_window_id: this.activeWindowId,
      active_pane_id: this.activePaneId,
      panes,
      windows,
      total_width: this.totalWidth,
      total_height: this.totalHeight,
      status_line: '',
    };
  }

  /** Send a tmux key name to the active pane's shell */
  sendKey(key: string): void {
    const pane = this.panes.get(this.activePaneId);
    if (!pane) return;
    pane.shell.processKey(key);
    // Update window name from shell cwd
    this.updateWindowName();
  }

  /** Send literal text to the active pane's shell */
  sendLiteral(text: string): void {
    const pane = this.panes.get(this.activePaneId);
    if (!pane) return;
    pane.shell.processLiteral(text);
  }

  /** Send keys to a specific pane */
  sendKeyToPane(paneId: string, key: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    pane.shell.processKey(key);
  }

  splitPane(direction: 'horizontal' | 'vertical'): string | null {
    const window = this.getActiveWindow();
    if (!window) return null;

    const paneId = this.allocPaneId();
    const parentWidth = this.totalWidth;
    const parentHeight = this.totalHeight;

    // Compute current active pane dimensions
    const positions = this.computePositions(window.layout, 0, 0, parentWidth, parentHeight);
    const activePos = positions.find((p) => p.paneId === this.activePaneId);
    const w = activePos?.width ?? parentWidth;
    const h = activePos?.height ?? parentHeight;

    const newW = direction === 'vertical' ? Math.floor(w / 2) : w;
    const newH = direction === 'horizontal' ? Math.floor(h / 2) : h;

    const shell = new DemoShell(this.vfs, newW, newH);
    shell.writePrompt();

    const pane: FakePane = {
      id: paneId,
      numericId: parseInt(paneId.slice(1)),
      windowId: window.id,
      shell,
      command: 'bash',
      title: 'bash',
    };
    this.panes.set(paneId, pane);

    // Split the active pane's leaf in the layout tree
    window.layout = this.splitLeaf(window.layout, this.activePaneId, paneId, direction);

    // Resize existing pane
    const existingPane = this.panes.get(this.activePaneId);
    if (existingPane) {
      const existW = direction === 'vertical' ? w - newW - 1 : w;
      const existH = direction === 'horizontal' ? h - newH - 1 : h;
      existingPane.shell.resize(Math.max(existW, 1), Math.max(existH, 1));
    }

    this.activePaneId = paneId;
    this.applyLayout(window);
    return paneId;
  }

  killPane(paneId?: string): boolean {
    const targetId = paneId ?? this.activePaneId;
    const pane = this.panes.get(targetId);
    if (!pane) return false;

    const window = this.windows.find((w) => w.id === pane.windowId);
    if (!window) return false;

    // If it's the last pane in the window, kill the window
    const windowPanes = [...this.panes.values()].filter((p) => p.windowId === window.id);
    if (windowPanes.length <= 1) {
      return this.killWindow(window.id);
    }

    // Remove from layout
    window.layout = this.removeLeaf(window.layout, targetId)!;
    this.panes.delete(targetId);

    // If active pane was killed, select first remaining pane in window
    if (this.activePaneId === targetId) {
      const remaining = [...this.panes.values()].find((p) => p.windowId === window.id);
      if (remaining) this.activePaneId = remaining.id;
    }

    this.applyLayout(window);
    return true;
  }

  newWindow(): string {
    const windowId = this.allocWindowId();
    const paneId = this.allocPaneId();

    const shell = new DemoShell(this.vfs, this.totalWidth, this.totalHeight);
    shell.writePrompt();

    const pane: FakePane = {
      id: paneId,
      numericId: parseInt(paneId.slice(1)),
      windowId,
      shell,
      command: 'bash',
      title: 'bash',
    };
    this.panes.set(paneId, pane);

    // Find next available index
    const usedIndices = new Set(this.windows.map((w) => w.index));
    let index = 0;
    while (usedIndices.has(index)) index++;

    const window: FakeWindow = {
      id: windowId,
      index,
      name: 'bash',
      layout: { type: 'leaf', paneId },
    };
    this.windows.push(window);

    this.activeWindowId = windowId;
    this.activePaneId = paneId;
    return windowId;
  }

  selectWindow(windowId: string): boolean {
    const window = this.windows.find((w) => w.id === windowId);
    if (!window) {
      // Try by index
      const idx = parseInt(windowId);
      const byIndex = this.windows.find((w) => w.index === idx);
      if (!byIndex) return false;
      this.activeWindowId = byIndex.id;
    } else {
      this.activeWindowId = windowId;
    }
    // Select first pane in window
    const firstPane = [...this.panes.values()].find((p) => p.windowId === this.activeWindowId);
    if (firstPane) this.activePaneId = firstPane.id;
    return true;
  }

  nextWindow(): boolean {
    const currentIdx = this.windows.findIndex((w) => w.id === this.activeWindowId);
    if (currentIdx === -1) return false;
    const nextIdx = (currentIdx + 1) % this.windows.length;
    return this.selectWindow(this.windows[nextIdx].id);
  }

  previousWindow(): boolean {
    const currentIdx = this.windows.findIndex((w) => w.id === this.activeWindowId);
    if (currentIdx === -1) return false;
    const prevIdx = (currentIdx - 1 + this.windows.length) % this.windows.length;
    return this.selectWindow(this.windows[prevIdx].id);
  }

  killWindow(windowId?: string): boolean {
    const targetId = windowId ?? this.activeWindowId;
    const idx = this.windows.findIndex((w) => w.id === targetId);
    if (idx === -1) return false;

    // Remove all panes in this window
    for (const [id, pane] of this.panes) {
      if (pane.windowId === targetId) this.panes.delete(id);
    }

    this.windows.splice(idx, 1);

    // If no windows left, create a new one
    if (this.windows.length === 0) {
      this.newWindow();
      return true;
    }

    // If active window was killed, select next
    if (this.activeWindowId === targetId) {
      const newIdx = Math.min(idx, this.windows.length - 1);
      this.selectWindow(this.windows[newIdx].id);
    }

    return true;
  }

  selectPane(paneId: string): boolean {
    if (!this.panes.has(paneId)) return false;
    const pane = this.panes.get(paneId)!;
    // Ensure we're on the right window
    if (pane.windowId !== this.activeWindowId) {
      this.activeWindowId = pane.windowId;
    }
    this.activePaneId = paneId;
    return true;
  }

  selectPaneByDirection(direction: string): boolean {
    const window = this.getActiveWindow();
    if (!window) return false;

    const positions = this.computePositions(window.layout, 0, 0, this.totalWidth, this.totalHeight);
    const current = positions.find((p) => p.paneId === this.activePaneId);
    if (!current) return false;

    let best: { paneId: string; dist: number } | null = null;
    for (const pos of positions) {
      if (pos.paneId === this.activePaneId) continue;
      let valid = false;
      let dist = 0;
      const cx = current.x + current.width / 2;
      const cy = current.y + current.height / 2;
      const px = pos.x + pos.width / 2;
      const py = pos.y + pos.height / 2;

      switch (direction) {
        case 'Up':
          valid = py < cy;
          dist = cy - py;
          break;
        case 'Down':
          valid = py > cy;
          dist = py - cy;
          break;
        case 'Left':
          valid = px < cx;
          dist = cx - px;
          break;
        case 'Right':
          valid = px > cx;
          dist = px - cx;
          break;
      }
      if (valid && (!best || dist < best.dist)) {
        best = { paneId: pos.paneId, dist };
      }
    }

    if (best) {
      this.activePaneId = best.paneId;
      return true;
    }
    return false;
  }

  resizePane(paneId: string, direction: string, adjustment: number): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    const window = this.windows.find((w) => w.id === pane.windowId);
    if (!window) return false;

    // Adjust ratio in the nearest split ancestor
    const delta = adjustment * 0.05; // Each unit = 5% adjustment
    this.adjustRatio(window.layout, paneId, direction, delta);
    this.applyLayout(window);
    return true;
  }

  getScrollbackCells(paneId: string): PaneContent {
    const pane = this.panes.get(paneId);
    if (!pane) return [];
    return pane.shell.getContent();
  }

  renameWindow(windowId: string, name: string): boolean {
    const window = this.windows.find((w) => w.id === windowId);
    if (!window) return false;
    window.name = name;
    return true;
  }

  // ============================================
  // Layout Helpers
  // ============================================

  private allocPaneId(): string {
    return `%${this.nextPaneNum++}`;
  }

  private allocWindowId(): string {
    return `@${this.nextWindowNum++}`;
  }

  private getActiveWindow(): FakeWindow | undefined {
    return this.windows.find((w) => w.id === this.activeWindowId);
  }

  private splitLeaf(
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
        this.splitLeaf(node.children[0], targetPaneId, newPaneId, direction),
        this.splitLeaf(node.children[1], targetPaneId, newPaneId, direction),
      ],
    };
  }

  private removeLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
    if (node.type === 'leaf') {
      return node.paneId === paneId ? null : node;
    }
    const left = this.removeLeaf(node.children[0], paneId);
    const right = this.removeLeaf(node.children[1], paneId);
    if (!left) return right;
    if (!right) return left;
    return { ...node, children: [left, right] };
  }

  private computePositions(
    node: LayoutNode,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Array<{ paneId: string; x: number; y: number; width: number; height: number }> {
    if (node.type === 'leaf') {
      return [{ paneId: node.paneId, x, y, width, height }];
    }

    if (node.direction === 'vertical') {
      const leftW = Math.floor(width * node.ratio);
      const rightW = width - leftW - 1; // -1 for separator
      return [
        ...this.computePositions(node.children[0], x, y, leftW, height),
        ...this.computePositions(node.children[1], x + leftW + 1, y, Math.max(rightW, 1), height),
      ];
    } else {
      const topH = Math.floor(height * node.ratio);
      const bottomH = height - topH - 1; // -1 for separator
      return [
        ...this.computePositions(node.children[0], x, y, width, topH),
        ...this.computePositions(node.children[1], x, y + topH + 1, width, Math.max(bottomH, 1)),
      ];
    }
  }

  private applyLayout(window: FakeWindow): void {
    const positions = this.computePositions(window.layout, 0, 0, this.totalWidth, this.totalHeight);
    for (const pos of positions) {
      const pane = this.panes.get(pos.paneId);
      if (pane) {
        pane.shell.resize(Math.max(pos.width, 1), Math.max(pos.height, 1));
      }
    }
  }

  private adjustRatio(node: LayoutNode, paneId: string, direction: string, delta: number): boolean {
    if (node.type === 'leaf') return false;

    // Check if either child contains the pane
    const leftContains = this.containsPane(node.children[0], paneId);
    const rightContains = this.containsPane(node.children[1], paneId);

    if (leftContains && rightContains) return false; // shouldn't happen

    if (leftContains || rightContains) {
      // Check if the split direction matches the resize direction
      const isVerticalResize = direction === 'Left' || direction === 'Right';
      const isHorizontalResize = direction === 'Up' || direction === 'Down';

      if (
        (node.direction === 'vertical' && isVerticalResize) ||
        (node.direction === 'horizontal' && isHorizontalResize)
      ) {
        const grow =
          (leftContains && (direction === 'Right' || direction === 'Down')) ||
          (rightContains && (direction === 'Left' || direction === 'Up'));
        node.ratio = Math.max(0.1, Math.min(0.9, node.ratio + (grow ? delta : -delta)));
        return true;
      }

      // Recurse into the child that contains the pane
      if (leftContains) return this.adjustRatio(node.children[0], paneId, direction, delta);
      return this.adjustRatio(node.children[1], paneId, direction, delta);
    }

    return false;
  }

  private containsPane(node: LayoutNode, paneId: string): boolean {
    if (node.type === 'leaf') return node.paneId === paneId;
    return (
      this.containsPane(node.children[0], paneId) || this.containsPane(node.children[1], paneId)
    );
  }

  private updateWindowName(): void {
    const pane = this.panes.get(this.activePaneId);
    if (!pane) return;
    const window = this.windows.find((w) => w.id === pane.windowId);
    if (!window) return;
    // Set window name to last path component of cwd
    const cwd = pane.shell.cwd;
    const name = cwd === '/' ? '/' : (cwd.split('/').pop() ?? 'bash');
    window.name = name;
  }
}
