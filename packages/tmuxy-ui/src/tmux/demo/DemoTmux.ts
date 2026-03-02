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
  manualName: boolean; // true if renamed manually, prevents auto-update from cwd
  layout: LayoutNode;
  layoutCycle: number; // tracks position in layout cycle
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

  // Zoom state
  private zoomedPaneId: string | null = null;
  private savedLayout: LayoutNode | null = null;

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
    shell.setTmux(this);
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
      manualName: false,
      layout: { type: 'leaf', paneId },
      layoutCycle: 0,
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
    const activeLayout =
      this.zoomedPaneId && window
        ? ({ type: 'leaf', paneId: this.zoomedPaneId } as LayoutNode)
        : window?.layout;
    const panePositions =
      window && activeLayout
        ? this.computePositions(activeLayout, 0, 0, this.totalWidth, this.totalHeight)
        : [];
    const posMap = new Map(panePositions.map((p) => [p.paneId, p]));

    const panes: ServerPane[] = [];
    for (const [, pane] of this.panes) {
      const pos = posMap.get(pane.id);
      // Include panes from active window, float windows, and group windows
      const paneWindow = this.windows.find((w) => w.id === pane.windowId);
      const isFloat = paneWindow?.name.startsWith('__float_') ?? false;
      const isGroup = paneWindow?.name.startsWith('__group_') ?? false;
      if (pane.windowId !== this.activeWindowId && !isFloat && !isGroup) continue;
      // In zoom mode, only show the zoomed pane from the active window
      if (
        this.zoomedPaneId &&
        pane.windowId === this.activeWindowId &&
        pane.id !== this.zoomedPaneId
      )
        continue;
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
        history_size: pane.shell.getHistorySize(),
      });
    }

    const windows: ServerWindow[] = this.windows.map((w) => {
      const isGroup = w.name.startsWith('__group_');
      const isFloat = w.name.startsWith('__float_');
      const groupPaneIds = isGroup ? this.parseGroupPaneIds(w.name) : null;
      const floatPaneId = isFloat ? `%${w.name.slice('__float_'.length)}` : null;
      return {
        id: w.id,
        index: w.index,
        name: w.name,
        active: w.id === this.activeWindowId,
        is_pane_group_window: isGroup,
        pane_group_pane_ids: groupPaneIds,
        is_float_window: isFloat,
        float_pane_id: floatPaneId,
      };
    });

    return {
      session_name: this.sessionName,
      active_window_id: this.activeWindowId,
      active_pane_id: this.activePaneId,
      panes,
      windows,
      total_width: this.totalWidth,
      total_height: this.totalHeight,
      status_line: this.buildStatusLine(),
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
    // Unzoom first if zoomed
    if (this.zoomedPaneId) this.toggleZoom();

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
    shell.setTmux(this);
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

    // Unzoom if zoomed pane is killed
    if (this.zoomedPaneId === targetId) this.toggleZoom();

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
    shell.setTmux(this);
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
      manualName: false,
      layout: { type: 'leaf', paneId },
      layoutCycle: 0,
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
    // Clear zoom when switching windows
    this.zoomedPaneId = null;
    this.savedLayout = null;
    // Select first pane in window
    const firstPane = [...this.panes.values()].find((p) => p.windowId === this.activeWindowId);
    if (firstPane) this.activePaneId = firstPane.id;
    return true;
  }

  nextWindow(): boolean {
    const visibleWindows = this.windows.filter(
      (w) => !w.name.startsWith('__group_') && !w.name.startsWith('__float_'),
    );
    const currentIdx = visibleWindows.findIndex((w) => w.id === this.activeWindowId);
    if (currentIdx === -1) return false;
    const nextIdx = (currentIdx + 1) % visibleWindows.length;
    return this.selectWindow(visibleWindows[nextIdx].id);
  }

  previousWindow(): boolean {
    const visibleWindows = this.windows.filter(
      (w) => !w.name.startsWith('__group_') && !w.name.startsWith('__float_'),
    );
    const currentIdx = visibleWindows.findIndex((w) => w.id === this.activeWindowId);
    if (currentIdx === -1) return false;
    const prevIdx = (currentIdx - 1 + visibleWindows.length) % visibleWindows.length;
    return this.selectWindow(visibleWindows[prevIdx].id);
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

    // Clear zoom if the zoomed window was killed
    if (this.activeWindowId === targetId) {
      this.zoomedPaneId = null;
      this.savedLayout = null;
    }

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

    const layout = this.zoomedPaneId
      ? ({ type: 'leaf', paneId: this.zoomedPaneId } as LayoutNode)
      : window.layout;
    const positions = this.computePositions(layout, 0, 0, this.totalWidth, this.totalHeight);
    const current = positions.find((p) => p.paneId === this.activePaneId);
    if (!current) return false;

    // tmux-style navigation: candidate must share an edge overlap in the
    // perpendicular axis and be adjacent in the primary axis. Among valid
    // candidates, pick the one whose center is closest in the primary axis,
    // breaking ties by perpendicular center distance.
    let best: { paneId: string; primaryDist: number; crossDist: number } | null = null;
    for (const pos of positions) {
      if (pos.paneId === this.activePaneId) continue;

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

  getScrollbackCells(paneId: string, start?: number, end?: number): PaneContent {
    const pane = this.panes.get(paneId);
    if (!pane) return [];
    const historySize = pane.shell.getHistorySize();
    const height = pane.shell.getContent().length;
    const totalLines = historySize + height;
    // Convert tmux-relative offsets to absolute indices
    // Tmux uses negative offsets for history (e.g., -200 to 0 = last 200 history lines + visible)
    const absStart = start !== undefined ? historySize + start : 0;
    const absEnd = end !== undefined ? historySize + end : totalLines;
    return pane.shell.getScrollbackContent(absStart, absEnd);
  }

  /** Cycle to the next layout (even-horizontal → even-vertical → tiled → ...) */
  nextLayout(): void {
    if (this.zoomedPaneId) return; // Can't change layout while zoomed
    const window = this.getActiveWindow();
    if (!window) return;

    const paneIds = this.collectLeafIds(window.layout);
    if (paneIds.length <= 1) return;

    const layouts = [
      (ids: string[]) => this.buildEvenHorizontal(ids),
      (ids: string[]) => this.buildEvenVertical(ids),
      (ids: string[]) => this.buildTiled(ids),
    ];

    window.layoutCycle = (window.layoutCycle + 1) % layouts.length;
    window.layout = layouts[window.layoutCycle](paneIds);
    this.applyLayout(window);
  }

  // ============================================
  // Swap
  // ============================================

  swapPanes(srcId: string, dstId: string): boolean {
    const srcPane = this.panes.get(srcId);
    const dstPane = this.panes.get(dstId);
    if (!srcPane || !dstPane) return false;

    // Must be in the same window
    if (srcPane.windowId !== dstPane.windowId) return false;

    const window = this.windows.find((w) => w.id === srcPane.windowId);
    if (!window) return false;

    // Swap pane IDs in the layout tree
    window.layout = this.swapLeafIds(window.layout, srcId, dstId);
    this.applyLayout(window);
    return true;
  }

  private swapLeafIds(node: LayoutNode, idA: string, idB: string): LayoutNode {
    if (node.type === 'leaf') {
      if (node.paneId === idA) return { type: 'leaf', paneId: idB };
      if (node.paneId === idB) return { type: 'leaf', paneId: idA };
      return node;
    }
    return {
      ...node,
      children: [
        this.swapLeafIds(node.children[0], idA, idB),
        this.swapLeafIds(node.children[1], idA, idB),
      ],
    };
  }

  // ============================================
  // Zoom
  // ============================================

  toggleZoom(paneId?: string): boolean {
    const targetId = paneId ?? this.activePaneId;
    const window = this.getActiveWindow();
    if (!window) return false;

    if (this.zoomedPaneId) {
      // Unzoom: restore saved layout
      if (this.savedLayout) {
        window.layout = this.savedLayout;
        this.savedLayout = null;
      }
      this.zoomedPaneId = null;
      this.applyLayout(window);
    } else {
      // Zoom: only makes sense with multiple panes
      const paneIds = this.collectLeafIds(window.layout);
      if (paneIds.length <= 1) return false;
      if (!paneIds.includes(targetId)) return false;

      this.savedLayout = window.layout;
      this.zoomedPaneId = targetId;
      this.activePaneId = targetId;
      // Resize the zoomed pane to full size
      const pane = this.panes.get(targetId);
      if (pane) {
        pane.shell.resize(this.totalWidth, this.totalHeight - 1);
      }
    }
    return true;
  }

  isZoomed(): boolean {
    return this.zoomedPaneId !== null;
  }

  // ============================================
  // Break Pane
  // ============================================

  breakPane(paneId?: string): string | null {
    if (this.zoomedPaneId) this.toggleZoom();

    const targetId = paneId ?? this.activePaneId;
    const pane = this.panes.get(targetId);
    if (!pane) return null;

    const srcWindow = this.windows.find((w) => w.id === pane.windowId);
    if (!srcWindow) return null;

    // Can't break if it's the only pane
    const windowPanes = [...this.panes.values()].filter((p) => p.windowId === srcWindow.id);
    if (windowPanes.length <= 1) return null;

    // Remove from source layout
    srcWindow.layout = this.removeLeaf(srcWindow.layout, targetId)!;

    // If active pane was broken out, select another in source window
    if (this.activePaneId === targetId) {
      const remaining = [...this.panes.values()].find((p) => p.windowId === srcWindow.id);
      if (remaining) this.activePaneId = remaining.id;
    }
    this.applyLayout(srcWindow);

    // Create new window for this pane
    const windowId = this.allocWindowId();
    const usedIndices = new Set(this.windows.map((w) => w.index));
    let index = 0;
    while (usedIndices.has(index)) index++;

    const newWindow: FakeWindow = {
      id: windowId,
      index,
      name: srcWindow.name,
      manualName: false,
      layout: { type: 'leaf', paneId: targetId },
      layoutCycle: 0,
    };
    this.windows.push(newWindow);

    // Move pane to new window
    pane.windowId = windowId;
    pane.shell.resize(this.totalWidth, this.totalHeight - 1);

    // Switch to new window
    this.activeWindowId = windowId;
    this.activePaneId = targetId;
    return windowId;
  }

  // ============================================
  // Capture
  // ============================================

  capturePane(paneId?: string): string {
    const targetId = paneId ?? this.activePaneId;
    const pane = this.panes.get(targetId);
    if (!pane) return '';

    const content = pane.shell.getContent();
    return content
      .map((line) =>
        line
          .map((cell) => cell.c)
          .join('')
          .trimEnd(),
      )
      .join('\n')
      .trimEnd();
  }

  // ============================================
  // Float Panes
  // ============================================

  createFloat(): string | null {
    const paneId = this.allocPaneId();
    const windowId = this.allocWindowId();
    const numericId = parseInt(paneId.slice(1));

    // Float panes are smaller than full size
    const floatW = Math.min(80, Math.floor(this.totalWidth * 0.75));
    const floatH = Math.min(20, Math.floor(this.totalHeight * 0.75));

    const shell = new DemoShell(this.vfs, floatW, floatH);
    shell.setTmux(this);
    shell.writePrompt();

    const pane: FakePane = {
      id: paneId,
      numericId,
      windowId,
      shell,
      command: 'bash',
      title: 'bash',
    };
    this.panes.set(paneId, pane);

    // Float windows use __float_N naming convention
    const usedIndices = new Set(this.windows.map((w) => w.index));
    let index = 0;
    while (usedIndices.has(index)) index++;

    const window: FakeWindow = {
      id: windowId,
      index,
      name: `__float_${numericId}`,
      manualName: true,
      layout: { type: 'leaf', paneId },
      layoutCycle: 0,
    };
    this.windows.push(window);

    // Don't switch active window — floats are overlays
    return paneId;
  }

  closeFloat(paneId: string): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    const window = this.windows.find((w) => w.id === pane.windowId);
    if (!window || !window.name.startsWith('__float_')) return false;
    return this.killWindow(window.id);
  }

  // ============================================
  // Pane Groups
  // ============================================

  /** Add the active pane to a group, creating a new sibling pane in the group */
  groupAdd(paneId?: string): string | null {
    const targetId = paneId ?? this.activePaneId;
    const pane = this.panes.get(targetId);
    if (!pane) return null;

    // Create a new pane to add to the group
    const newPaneId = this.allocPaneId();
    const newNumericId = parseInt(newPaneId.slice(1));

    // Get the target pane's dimensions
    const window = this.windows.find((w) => w.id === pane.windowId);
    if (!window) return null;
    const positions = this.computePositions(window.layout, 0, 0, this.totalWidth, this.totalHeight);
    const pos = positions.find((p) => p.paneId === targetId);
    const w = pos?.width ?? this.totalWidth;
    const h = pos?.height ?? this.totalHeight;

    const shell = new DemoShell(this.vfs, w, h);
    shell.setTmux(this);
    shell.writePrompt();

    // Find existing group for this pane
    const existingGroup = this.findGroupForPane(targetId);
    const groupPaneIds = existingGroup
      ? [...this.parseGroupPaneIds(existingGroup.name)!, newPaneId]
      : [targetId, newPaneId];

    // Create new pane in a hidden group window
    const groupWindowId = this.allocWindowId();
    const usedIndices = new Set(this.windows.map((w2) => w2.index));
    let index = 0;
    while (usedIndices.has(index)) index++;

    const newPane: FakePane = {
      id: newPaneId,
      numericId: newNumericId,
      windowId: groupWindowId,
      shell,
      command: 'bash',
      title: 'bash',
    };
    this.panes.set(newPaneId, newPane);

    // Build group window name
    const groupName = this.buildGroupName(groupPaneIds);

    // Update or create group window
    if (existingGroup) {
      existingGroup.name = groupName;
    } else {
      const groupWindow: FakeWindow = {
        id: groupWindowId,
        index,
        name: groupName,
        manualName: true,
        layout: { type: 'leaf', paneId: newPaneId },
        layoutCycle: 0,
      };
      this.windows.push(groupWindow);
    }

    // Swap the new pane into view (replace target in the active layout)
    this.swapGroupPanes(
      targetId,
      newPaneId,
      window,
      existingGroup ?? this.windows[this.windows.length - 1],
    );

    return newPaneId;
  }

  /** Close a pane from its group */
  groupClose(paneId?: string): boolean {
    const targetId = paneId ?? this.activePaneId;
    const pane = this.panes.get(targetId);
    if (!pane) return false;

    const groupWindow = this.findGroupForPane(targetId);
    if (!groupWindow) return false;

    const groupPaneIds = this.parseGroupPaneIds(groupWindow.name);
    if (!groupPaneIds || groupPaneIds.length < 2) return false;

    // If the target is visible (in active window), swap another in first
    const activeWindow = this.getActiveWindow();
    if (activeWindow && this.containsPane(activeWindow.layout, targetId)) {
      const nextPaneId = groupPaneIds.find((id) => id !== targetId);
      if (nextPaneId) {
        this.swapGroupPanes(targetId, nextPaneId, activeWindow, groupWindow);
      }
    }

    // Remove the pane
    this.panes.delete(targetId);

    // Update group: remove this pane from the group name
    const remainingIds = groupPaneIds.filter((id) => id !== targetId);
    if (remainingIds.length < 2) {
      // Dissolve group — kill the group window
      this.killWindow(groupWindow.id);
    } else {
      groupWindow.name = this.buildGroupName(remainingIds);
    }

    return true;
  }

  /** Switch to a specific pane in a group */
  groupSwitch(targetPaneId: string): boolean {
    const pane = this.panes.get(targetPaneId);
    if (!pane) return false;

    const groupWindow = this.findGroupForPane(targetPaneId);
    if (!groupWindow) return false;

    const activeWindow = this.getActiveWindow();
    if (!activeWindow) return false;

    // Find which pane from the group is currently visible
    const groupPaneIds = this.parseGroupPaneIds(groupWindow.name);
    if (!groupPaneIds) return false;

    const visibleId = groupPaneIds.find((id) => this.containsPane(activeWindow.layout, id));
    if (!visibleId || visibleId === targetPaneId) return false;

    this.swapGroupPanes(visibleId, targetPaneId, activeWindow, groupWindow);
    return true;
  }

  /** Navigate to next pane in group */
  groupNext(paneId?: string): boolean {
    const targetId = paneId ?? this.activePaneId;
    const groupWindow = this.findGroupForPane(targetId);
    if (!groupWindow) return false;

    const groupPaneIds = this.parseGroupPaneIds(groupWindow.name);
    if (!groupPaneIds || groupPaneIds.length < 2) return false;

    const idx = groupPaneIds.indexOf(targetId);
    if (idx === -1) return false;

    const nextIdx = (idx + 1) % groupPaneIds.length;
    return this.groupSwitch(groupPaneIds[nextIdx]);
  }

  // ============================================
  // Unified Navigation (mirrors nav.sh)
  // ============================================

  /** Navigate left/right: group pane tabs → horizontal pane splits → window tabs (circular wrap) */
  navHorizontal(direction: 'left' | 'right'): void {
    const activeWindow = this.getActiveWindow();
    if (!activeWindow) return;

    // Step 1: Check if active pane is in a group
    const groupWindow = this.findGroupForPane(this.activePaneId);
    if (groupWindow) {
      const groupPaneIds = this.parseGroupPaneIds(groupWindow.name);
      if (groupPaneIds && groupPaneIds.length > 1) {
        // Find which pane from the group is visible in active window
        const visibleId = groupPaneIds.find((id) => this.containsPane(activeWindow.layout, id));
        if (visibleId) {
          const idx = groupPaneIds.indexOf(visibleId);
          if (direction === 'right' && idx < groupPaneIds.length - 1) {
            this.groupSwitch(groupPaneIds[idx + 1]);
            return;
          }
          if (direction === 'left' && idx > 0) {
            this.groupSwitch(groupPaneIds[idx - 1]);
            return;
          }
          // At edge of group — fall through to pane splits
        }
      }
    }

    // Step 2: Try directional pane select
    const tmuxDir = direction === 'right' ? 'Right' : 'Left';
    if (this.selectPaneByDirection(tmuxDir)) return;

    // Step 3: Wrap to next/previous window tab
    if (direction === 'right') {
      this.nextWindow();
    } else {
      this.previousWindow();
    }
  }

  /** Navigate up/down: vertical pane splits only (no group or tab fallback) */
  navVertical(direction: 'up' | 'down'): void {
    const tmuxDir = direction === 'down' ? 'Down' : 'Up';
    this.selectPaneByDirection(tmuxDir);
  }

  /** Navigate to previous pane in group */
  groupPrev(paneId?: string): boolean {
    const targetId = paneId ?? this.activePaneId;
    const groupWindow = this.findGroupForPane(targetId);
    if (!groupWindow) return false;

    const groupPaneIds = this.parseGroupPaneIds(groupWindow.name);
    if (!groupPaneIds || groupPaneIds.length < 2) return false;

    const idx = groupPaneIds.indexOf(targetId);
    if (idx === -1) return false;

    const prevIdx = (idx - 1 + groupPaneIds.length) % groupPaneIds.length;
    return this.groupSwitch(groupPaneIds[prevIdx]);
  }

  /** Find the group window containing a pane */
  private findGroupForPane(paneId: string): FakeWindow | undefined {
    const numericId = paneId.slice(1);
    return this.windows.find((w) => {
      if (!w.name.startsWith('__group_')) return false;
      const ids = w.name.slice('__group_'.length).split('-');
      return ids.includes(numericId);
    });
  }

  /** Parse pane IDs from a group window name like __group_4-6-7 → ["%4", "%6", "%7"] */
  private parseGroupPaneIds(name: string): string[] | null {
    if (!name.startsWith('__group_')) return null;
    const parts = name.slice('__group_'.length).split('-');
    if (parts.length < 2) return null;
    return parts.map((n) => `%${n}`);
  }

  /** Build a group window name from pane IDs */
  private buildGroupName(paneIds: string[]): string {
    return `__group_${paneIds.map((id) => id.slice(1)).join('-')}`;
  }

  /** Swap a visible pane with a hidden group pane */
  private swapGroupPanes(
    visibleId: string,
    hiddenId: string,
    activeWindow: FakeWindow,
    groupWindow: FakeWindow,
  ): void {
    const visiblePane = this.panes.get(visibleId);
    const hiddenPane = this.panes.get(hiddenId);
    if (!visiblePane || !hiddenPane) return;

    // Swap in layout: replace visible with hidden in active window
    activeWindow.layout = this.replaceLeafId(activeWindow.layout, visibleId, hiddenId);

    // Move hidden pane to active window
    hiddenPane.windowId = activeWindow.id;

    // Move visible pane to group window
    visiblePane.windowId = groupWindow.id;
    groupWindow.layout = { type: 'leaf', paneId: visibleId };

    // Update active pane
    this.activePaneId = hiddenId;

    this.applyLayout(activeWindow);
  }

  /** Replace a pane ID in the layout tree */
  private replaceLeafId(node: LayoutNode, oldId: string, newId: string): LayoutNode {
    if (node.type === 'leaf') {
      return node.paneId === oldId ? { type: 'leaf', paneId: newId } : node;
    }
    return {
      ...node,
      children: [
        this.replaceLeafId(node.children[0], oldId, newId),
        this.replaceLeafId(node.children[1], oldId, newId),
      ],
    };
  }

  // ============================================
  // Internal Helpers
  // ============================================

  private collectLeafIds(node: LayoutNode): string[] {
    if (node.type === 'leaf') return [node.paneId];
    return [...this.collectLeafIds(node.children[0]), ...this.collectLeafIds(node.children[1])];
  }

  /** All panes side by side (vertical splits) */
  private buildEvenHorizontal(paneIds: string[]): LayoutNode {
    return this.buildBalancedTree(paneIds, 'vertical');
  }

  /** All panes stacked (horizontal splits) */
  private buildEvenVertical(paneIds: string[]): LayoutNode {
    return this.buildBalancedTree(paneIds, 'horizontal');
  }

  /** Grid layout: rows × cols */
  private buildTiled(paneIds: string[]): LayoutNode {
    const count = paneIds.length;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);

    // Build rows, each row is a horizontal chain of panes
    const rowNodes: LayoutNode[] = [];
    for (let r = 0; r < rows; r++) {
      const rowPanes = paneIds.slice(r * cols, Math.min((r + 1) * cols, count));
      rowNodes.push(this.buildBalancedTree(rowPanes, 'vertical'));
    }
    return this.buildBalancedTree(rowNodes, 'horizontal');
  }

  private buildBalancedTree(
    items: (string | LayoutNode)[],
    direction: 'horizontal' | 'vertical',
  ): LayoutNode {
    if (items.length === 1) {
      const item = items[0];
      return typeof item === 'string' ? { type: 'leaf', paneId: item } : item;
    }
    const mid = Math.ceil(items.length / 2);
    const left = this.buildBalancedTree(items.slice(0, mid), direction);
    const right = this.buildBalancedTree(items.slice(mid), direction);
    return {
      type: 'split',
      direction,
      ratio: mid / items.length,
      children: [left, right],
    };
  }

  /** Returns true if there is only one pane across all windows */
  isLastPane(): boolean {
    return this.panes.size <= 1 && this.windows.length <= 1;
  }

  renameWindow(windowId: string, name: string): boolean {
    const window = this.windows.find((w) => w.id === windowId);
    if (!window) return false;
    window.name = name;
    window.manualName = true;
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
      // Reserve 1 row for the pane header (like tmux pane-border-status top).
      // The UI positions the header at pane.y - 1, so y+1 keeps the header at row y.
      return [{ paneId: node.paneId, x, y: y + 1, width, height: Math.max(height - 1, 1) }];
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
    if (!window || window.manualName) return;
    // Set window name to last path component of cwd
    const cwd = pane.shell.cwd;
    const name = cwd === '/' ? '/' : (cwd.split('/').pop() ?? 'bash');
    window.name = name;
  }

  private buildStatusLine(): string {
    // The .tmux-status-bar container already provides the themed background
    // via --tmux-status-bg. Only set fg color here to avoid ANSI bg mismatch.
    const style = '\x1b[30m'; // black fg (text color on green bar)
    const reset = '\x1b[0m';
    const leftText = ` [${this.sessionName}] `;
    const rightText = ` demo@tmuxy `;
    const padding = Math.max(0, this.totalWidth - leftText.length - rightText.length);
    return `${style}${leftText}${' '.repeat(padding)}${rightText}${reset}`;
  }
}
