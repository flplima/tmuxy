import type { PaneContent, ServerStateEncoded, WireImagePlacement } from '../../../../domain/wire';
import { LifoShell } from './LifoShell';
import { DemoPreviews } from './demoPreview';
import { DemoBuffers } from './demoBuffers';
import { DemoFiles } from './demoFiles';
import {
  type CreateFloatOptions,
  type FakePane,
  type FakeWindow,
  LAYOUT_NAMES,
  type LayoutNode,
  adjustRatio,
  applyWindowLayout,
  buildNamedLayout,
  collectLeafIds,
  findPaneInDirection,
} from './demoLayout';
import {
  type DemoGroupsContext,
  createDemoFloat,
  createDemoSidebar,
  demoGroupAdd,
  demoGroupClose,
  demoGroupNext,
  demoGroupPrev,
  demoGroupSwitch,
  demoNavHorizontal,
  setDemoSidebarCols,
} from './demoGroupsAndFloats';
import {
  breakPaneToWindow,
  buildDemoServerState,
  capturePaneText,
  createNewDemoWindow,
  getPaneScrollbackCells,
  joinPaneBetweenWindows,
  killDemoPane,
  killDemoWindow,
  moveTabWindow,
  splitDemoPane,
  swapDemoPanes,
} from './demoStateAndWindows';

// ============================================
// DemoTmux Engine
// ============================================

export class DemoTmux {
  private panes = new Map<string, FakePane>();
  /**
   * `@tmuxy-pane-state` per pane, as a real server would hold it: set by
   * whatever runs in the pane (`tmuxy pane state working`) and read back out
   * on every list-panes. Absent means the option was never set.
   */
  private paneStates = new Map<string, string>();
  /**
   * `@tmuxy-ask` per pane: the base64 question `tmuxy pane send -t` hangs on the pane
   * it wants keys sent to. Held exactly like `@tmuxy-pane-state` — set by a
   * command, read back on every list-panes — so a story drives the overlay
   * through the real option rather than through a prop.
   */
  private paneAsks = new Map<string, string>();
  /**
   * `@tmuxy-pane-widget` for panes the demo turned into widgets. A widget is
   * rendered only when this names it, the same as on a real server, where
   * `tmuxy-widget` writes the option before printing its marker.
   */
  private paneWidgets = new Map<string, string>();
  /** The panes running `tmuxy open` (`demoPreview.ts`). */
  readonly previews = new DemoPreviews({
    shellOf: (id) => this.panes.get(id)?.shell,
    widgetOf: (id) => this.paneWidgets.get(id),
    writeWidget: (id, name, lines) => this.writeWidget(id, name, lines),
    clearWidget: (id) => this.clearWidget(id),
  });
  readonly buffers = new DemoBuffers();
  private windows: FakeWindow[] = [];
  private activeWindowId = '@0';
  private activePaneId = '%0';
  /** tmux's marked pane (`select-pane -m`), or null. */
  private markedPaneId: string | null = null;
  private nextPaneNum = 0;
  private nextWindowNum = 0;
  private totalWidth = 80;
  private totalHeight = 24;
  private sessionName = 'demo';
  private copyModePanes = new Set<string>();
  private onAsyncUpdate?: () => void;

  // Zoom state
  private zoomedPaneId: string | null = null;
  private savedLayout: LayoutNode | null = null;

  setOnAsyncUpdate(cb: () => void): void {
    this.onAsyncUpdate = cb;
  }

  /** The one disk every pane's shell sees (`demoFiles.ts`). */
  private readonly files = new DemoFiles();

  private makeShell(paneId: string, width: number, height: number): LifoShell {
    const shell = new LifoShell(width, height, this.files);
    shell.setTmux(this, paneId);
    shell.onUpdate = () => this.onAsyncUpdate?.();
    return shell;
  }

  private groupsContext(): DemoGroupsContext {
    return {
      panes: this.panes,
      windows: this.windows,
      activeWindowId: this.activeWindowId,
      activePaneId: this.activePaneId,
      zoomedPaneId: this.zoomedPaneId,
      totalWidth: this.totalWidth,
      totalHeight: this.totalHeight,
      allocPaneId: () => this.allocPaneId(),
      allocWindowId: () => this.allocWindowId(),
      makeShell: (id, w, h) => this.makeShell(id, w, h),
      setActivePaneId: (id) => {
        this.activePaneId = id;
      },
      setActiveWindowId: (id) => {
        this.activeWindowId = id;
      },
      setWindows: (windows) => {
        this.windows = windows;
      },
      unzoomIfZoomed: (onlyPaneId) => {
        if (this.zoomedPaneId && (!onlyPaneId || this.zoomedPaneId === onlyPaneId)) {
          this.toggleZoom();
        }
      },
      clearZoom: () => {
        this.zoomedPaneId = null;
        this.savedLayout = null;
      },
      newWindow: () => this.newWindow(),
      selectWindow: (id) => this.selectWindow(id),
      killWindow: (id) => this.killWindow(id),
      writeWidget: (id, name, lines) => this.writeWidget(id, name, lines),
      selectPaneByDirection: (dir) => this.selectPaneByDirection(dir),
    };
  }

  /** Initialize with one window and one pane. Writes welcome banner. */
  init(width: number, height: number): void {
    this.totalWidth = width || 80;
    this.totalHeight = height || 24;

    const paneId = this.allocPaneId();
    const windowId = this.allocWindowId();

    // Subtract 1 row for header (pane-border-status top occupies row 0)
    const shell = this.makeShell(paneId, this.totalWidth, Math.max(this.totalHeight - 1, 1));
    shell.writeBanner();
    shell.writePrompt();

    const pane: FakePane = {
      id: paneId,
      numericId: parseInt(paneId.slice(1)),
      windowId,
      shell,
      command: 'bash',
      title: '',
    };
    this.panes.set(paneId, pane);

    const window: FakeWindow = {
      id: windowId,
      index: 0,
      name: 'bash',
      manualName: false,
      layout: { type: 'leaf', paneId },
      layoutCycle: 0,
      windowType: 'tab',
      groupPanes: null,
    };
    this.windows.push(window);

    this.activeWindowId = windowId;
    this.activePaneId = paneId;
  }

  setSize(cols: number, rows: number): void {
    this.totalWidth = cols;
    this.totalHeight = rows;
    for (const win of this.windows) {
      // Floats, groups, and sidebars keep their own size, like real tmux.
      if (win.windowType !== 'tab') continue;
      this.applyLayout(win);
    }
  }

  getState(): ServerStateEncoded {
    return buildDemoServerState({
      sessionName: this.sessionName,
      activeWindowId: this.activeWindowId,
      activePaneId: this.activePaneId,
      markedPaneId: this.markedPaneId,
      zoomedPaneId: this.zoomedPaneId,
      totalWidth: this.totalWidth,
      totalHeight: this.totalHeight,
      panes: this.panes,
      windows: this.windows,
      copyModePanes: this.copyModePanes,
      paneStates: this.paneStates,
      paneAsks: this.paneAsks,
      paneWidgets: this.paneWidgets,
    });
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
    return splitDemoPane(this.groupsContext(), direction);
  }

  enterCopyMode(paneId: string): void {
    this.copyModePanes.add(paneId);
  }

  exitCopyMode(paneId: string): void {
    this.copyModePanes.delete(paneId);
  }

  killPane(paneId?: string): boolean {
    return killDemoPane(this.groupsContext(), paneId);
  }

  newWindow(): string {
    return createNewDemoWindow(this.groupsContext());
  }

  /**
   * Reorder the tab strip: put `windowId` before (`after` = false) or after
   * `targetId` among the tab windows, renumbering their indices the way
   * `renumber-windows on` does. Chrome windows keep their own indices.
   */
  moveWindow(windowId: string, targetId: string, after: boolean): boolean {
    return moveTabWindow(this.windows, windowId, targetId, after);
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
    const visibleWindows = this.windows.filter((w) => w.windowType === 'tab');
    const currentIdx = visibleWindows.findIndex((w) => w.id === this.activeWindowId);
    if (currentIdx === -1) return false;
    const nextIdx = (currentIdx + 1) % visibleWindows.length;
    return this.selectWindow(visibleWindows[nextIdx].id);
  }

  previousWindow(): boolean {
    const visibleWindows = this.windows.filter((w) => w.windowType === 'tab');
    const currentIdx = visibleWindows.findIndex((w) => w.id === this.activeWindowId);
    if (currentIdx === -1) return false;
    const prevIdx = (currentIdx - 1 + visibleWindows.length) % visibleWindows.length;
    return this.selectWindow(visibleWindows[prevIdx].id);
  }

  killWindow(windowId?: string): boolean {
    return killDemoWindow(this.groupsContext(), windowId);
  }

  /** Mark a pane (`select-pane -m`) or clear the mark (`select-pane -M`, null). */
  markPane(paneId: string | null): void {
    this.markedPaneId = paneId && this.panes.has(paneId) ? paneId : null;
  }

  /**
   * Set `@tmuxy-pane-state` on a pane — what `tmuxy pane state <value>` does
   * on a real server. An empty value unsets the option, which is how a process
   * stops declaring anything (an agent's hook on exit, say).
   */
  setPaneState(paneId: string, value: string): void {
    if (!this.panes.has(paneId)) return;
    if (value) this.paneStates.set(paneId, value);
    else this.paneStates.delete(paneId);
  }

  /**
   * Set `@tmuxy-ask` on a pane — what `tmuxy pane send -t` does before it blocks. An
   * empty value unsets it, which is what answering the question does.
   */
  setPaneAsk(paneId: string, value: string): void {
    if (!this.panes.has(paneId)) return;
    if (value) this.paneAsks.set(paneId, value);
    else this.paneAsks.delete(paneId);
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
    const next = findPaneInDirection(
      layout,
      this.activePaneId,
      direction,
      this.totalWidth,
      this.totalHeight,
    );
    if (next) {
      this.activePaneId = next;
      return true;
    }
    return false;
  }

  resizePane(paneId: string, direction: string, adjustment: number): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    const window = this.windows.find((w) => w.id === pane.windowId);
    if (!window) return false;

    // Adjust ratio in the nearest split ancestor, converting cell-based
    // adjustment to a ratio delta using the available space at that split level.
    adjustRatio(window.layout, paneId, direction, adjustment, this.totalWidth, this.totalHeight);
    this.applyLayout(window);
    return true;
  }

  getScrollbackCells(paneId: string, start?: number, end?: number): PaneContent {
    return getPaneScrollbackCells(this.panes, paneId, start, end);
  }

  /** Cycle to the next layout (even-horizontal → even-vertical → tiled → ...) */
  nextLayout(): void {
    if (this.zoomedPaneId) return; // Can't change layout while zoomed
    const window = this.getActiveWindow();
    if (!window) return;

    const paneIds = collectLeafIds(window.layout);
    if (paneIds.length <= 1) return;

    window.layoutCycle = (window.layoutCycle + 1) % LAYOUT_NAMES.length;
    window.layout = buildNamedLayout(LAYOUT_NAMES[window.layoutCycle], paneIds);
    this.applyLayout(window);
  }

  /** Apply a named layout (even-horizontal, even-vertical, main-horizontal, main-vertical, tiled) */
  selectLayout(name: string): void {
    if (this.zoomedPaneId) return;
    const window = this.getActiveWindow();
    if (!window) return;

    const paneIds = collectLeafIds(window.layout);
    if (paneIds.length <= 1) return;

    const idx = LAYOUT_NAMES.indexOf(name);
    if (idx === -1) return;

    window.layoutCycle = idx;
    window.layout = buildNamedLayout(name, paneIds);
    this.applyLayout(window);
  }

  swapPanes(srcId: string, dstId: string): boolean {
    return swapDemoPanes(this.groupsContext(), srcId, dstId);
  }

  /** Name a pane (tmux `select-pane -T <title>`), the way an app's OSC 0/2 would. */
  setPaneTitle(paneId: string, title: string): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    pane.title = title;
    return true;
  }

  /**
   * Move a pane into another window (tmux `join-pane -s <pane> -t <window>`).
   * Splits the target window's active/first pane with the source pane; if the
   * source window is left empty it is closed. Backs the sidebar tree's
   * drag-a-pane-between-tabs gesture.
   */
  joinPane(srcId: string, targetWindowId: string): boolean {
    return joinPaneBetweenWindows(this.groupsContext(), srcId, targetWindowId);
  }

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
      const paneIds = collectLeafIds(window.layout);
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

  breakPane(paneId?: string): string | null {
    return breakPaneToWindow(this.groupsContext(), paneId ?? this.activePaneId);
  }

  capturePane(paneId?: string): string {
    return capturePaneText(this.panes, paneId ?? this.activePaneId);
  }

  /**
   * Attach an image placement to a pane. Storybook stories and tests use
   * this to simulate the result of the Rust backend parsing an OSC 1337 /
   * Kitty / Sixel sequence — the placement flows through WirePaneEncoded.images
   * → the app machine → Terminal.tsx exactly like a real one.
   *
   * The frontend renders `<img src="/api/images/<paneNum>/<imageId>">`; in
   * Storybook we override that URL via `window.__tmuxyImageSrc` so the
   * image bytes can be a data URL the story registered.
   */
  attachImage(paneId: string, placement: WireImagePlacement): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    pane.images = pane.images ?? [];
    pane.images.push(placement);
    this.onAsyncUpdate?.();
    return true;
  }

  createSidebar(side: 'left' | 'right', widget?: string): string | null {
    return createDemoSidebar(this.groupsContext(), side, widget);
  }

  setSidebarCols(windowId: string, cols: number | null): void {
    setDemoSidebarCols(this.groupsContext(), windowId, cols);
  }

  /** Hide or show a sidebar column (the demo's `@tmuxy-sidebar-hidden`). */
  setSidebarHidden(windowId: string, hidden: boolean): void {
    const window = this.windows.find((w) => w.id === windowId);
    if (!window) return;
    window.sidebarHidden = hidden;
  }

  createFloat(options: CreateFloatOptions = {}): string | null {
    return createDemoFloat(this.groupsContext(), options);
  }

  /** Add the active pane to a group, creating a new sibling pane in the group */
  groupAdd(paneId?: string): string | null {
    return demoGroupAdd(this.groupsContext(), paneId);
  }

  /** Close a pane from its group */
  groupClose(paneId?: string): boolean {
    return demoGroupClose(this.groupsContext(), paneId);
  }

  /** Switch to a specific pane in a group */
  groupSwitch(targetPaneId: string): boolean {
    return demoGroupSwitch(this.groupsContext(), targetPaneId);
  }

  /** Navigate to next pane in group */
  groupNext(paneId?: string): boolean {
    return demoGroupNext(this.groupsContext(), paneId);
  }

  /**
   * Navigate left/right: the neighbouring group member first, without
   * wrapping, then the neighbouring split (mirrors bin/tmuxy/nav). From the
   * last member of a group, right moves on to the pane on the right.
   */
  navHorizontal(direction: 'left' | 'right'): void {
    demoNavHorizontal(this.groupsContext(), direction);
  }

  /** Navigate up/down: vertical pane splits only (no group or tab fallback) */
  navVertical(direction: 'up' | 'down'): void {
    const tmuxDir = direction === 'down' ? 'Down' : 'Up';
    this.selectPaneByDirection(tmuxDir);
  }

  /** Navigate to previous pane in group */
  groupPrev(paneId?: string): boolean {
    return demoGroupPrev(this.groupsContext(), paneId);
  }

  /** Replace a pane's content with a widget marker + content lines */
  writeWidget(paneId: string, widgetName: string, lines: string[]): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    pane.shell.writeWidgetContent(widgetName, lines);
    this.paneWidgets.set(paneId, widgetName);
    pane.title = widgetName;
    pane.command = widgetName;
  }

  /** A widget has exited: its tag goes, and the pane is a shell again. */
  clearWidget(paneId: string): void {
    this.paneWidgets.delete(paneId);
    const pane = this.panes.get(paneId);
    if (pane) pane.title = pane.command = 'bash';
  }

  renameWindow(windowId: string, name: string): boolean {
    const window = this.windows.find((w) => w.id === windowId);
    if (!window) return false;
    window.name = name;
    window.manualName = true;
    return true;
  }

  private allocPaneId(): string {
    return `%${this.nextPaneNum++}`;
  }

  private allocWindowId(): string {
    return `@${this.nextWindowNum++}`;
  }

  private getActiveWindow(): FakeWindow | undefined {
    return this.windows.find((w) => w.id === this.activeWindowId);
  }

  private applyLayout(window: FakeWindow): void {
    applyWindowLayout(window, this.panes, this.totalWidth, this.totalHeight);
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
}
