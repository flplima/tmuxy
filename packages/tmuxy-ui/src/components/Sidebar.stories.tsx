/**
 * Sidebar stories (demo engine).
 *
 * The left sidebar is now a native React tab/pane tree (`SidebarTree`) rendered
 * in a fixed-width, full-height column that flexes the pane area — no tmux
 * window/pane, no `tmuxy tree` TUI. The tree is derived from the demo's
 * `context.windows`/`context.panes`, so these stories exercise the real user
 * chain: TOGGLE_LEFT_SIDEBAR (button or `prefix s`) → column opens → tree lists every
 * tab and its panes → clicking / keyboard-navigating a node activates it through
 * the same events the rest of the UI uses.
 *
 * Context menus are floating surfaces portalled out of the tree, so menu queries
 * run against `document`, not `canvasElement`.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor, fireEvent } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';
import { fixColumn } from '../stories/fixColumn';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Sidebar',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

interface AppSnap {
  context: {
    activePaneId: string | null;
    activeWindowId: string | null;
    charWidth: number;
    windows: Array<{
      id: string;
      index: number;
      name: string;
      windowType: string | null;
      sidebarCols?: number | null;
    }>;
    panes: Array<{ tmuxId: string; windowId: string; width: number }>;
    sessions: Array<{ sessionName: string }>;
  };
}
const app = () => (window as unknown as { app: { getSnapshot(): AppSnap } }).app.getSnapshot();

/**
 * The panes that belong to TABS — the only ones the tree lists.
 *
 * `context.panes` also holds each sidebar column's own pane (the left column
 * runs the tree widget in a `sidebar-left` window), and the tree filters those
 * out along with floats — it would otherwise list itself.
 */
function tabPanes() {
  const tabWindowIds = new Set(
    app()
      .context.windows.filter((w) => w.windowType === 'tab')
      .map((w) => w.id),
  );
  return app().context.panes.filter((p) => tabWindowIds.has(p.windowId));
}

/** Wait until the sidebar drawer + tree portal into document.body. */
async function waitForTree(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = document.querySelector('.sidebar-tree') as HTMLElement | null;
      if (!el) throw new Error('no .sidebar-tree yet');
      return el;
    },
    { timeout: 8000 },
  );
}

// ---------------------------------------------------------------------------
// Open via the header toggle button → the tree lists every tab and its panes
// ---------------------------------------------------------------------------

export const OpenShowsTree: Story = {
  args: {
    height: 500,
    initCommands: ['rename-window main', 'new-window', 'rename-window logs', 'split-window -h'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);

    const tree = await waitForTree();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // One tree row per visible tab, and one per pane in the state.
    const tabs = app().context.windows.filter((w) => w.windowType === 'tab');
    for (const w of tabs) {
      expect(tree.querySelector(`[data-testid="tree-tab-${w.id}"]`)).not.toBeNull();
    }
    for (const p of tabPanes()) {
      expect(tree.querySelector(`[data-testid="tree-pane-${p.tmuxId}"]`)).not.toBeNull();
    }
    // Renamed tab labels show up.
    expect(tree.textContent).toContain('main');
    expect(tree.textContent).toContain('logs');
    // Drawer content has real size (catches zero-height / clip bugs). The
    // column widens on a transition, so the size worth asserting is the one it
    // settles at — reading it the frame the tree appears catches the drawer
    // a pixel or two wide and says nothing about whether it is clipped.
    const content = document.querySelector('[data-testid="sidebar-content"]') as HTMLElement;
    await waitFor(() => {
      const rect = content.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(50);
      expect(rect.height).toBeGreaterThan(50);
    });

    // Clicking the toggle again closes the drawer.
    await userEvent.click(toggle);
    await waitFor(() => expect(document.querySelector('.sidebar-tree')).toBeNull(), {
      timeout: 5000,
    });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  },
};

// ---------------------------------------------------------------------------
// `prefix s` opens the sidebar; the same key again frees or fixes it
// ---------------------------------------------------------------------------

export const OpenViaPrefixS: Story = {
  args: { height: 500, initCommands: ['rename-window editor'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    const user = userEvent.setup({ delay: 5 });
    const prefix = () => user.keyboard('{Control>}a{/Control}');
    const column = () => document.querySelector('.sidebar-column-left') as HTMLElement;
    // Docked, the grid starts where the column ends; overlaying, under it.
    const gridUnderColumn = () => {
      const pane = canvasElement.querySelector('.pane-layout-item')!.getBoundingClientRect();
      return pane.left < column().getBoundingClientRect().right - 1;
    };

    // One key to look: the column opens over the panes.
    await prefix();
    await user.keyboard('s');
    await waitForTree();
    await waitFor(() => expect(column()).toHaveClass('is-overlay'), { timeout: 5000 });
    await waitFor(() => expect(gridUnderColumn()).toBe(true), { timeout: 5000 });

    // The same key twice to keep (`prefix s s`): it docks, and the grid
    // reflows beside it.
    await user.keyboard('s');
    await waitFor(() => expect(column()).not.toHaveClass('is-overlay'), { timeout: 5000 });
    await waitFor(() => expect(gridUnderColumn()).toBe(false), { timeout: 5000 });

    // `prefix s` on an open, fixed column frees it to overlay again.
    await prefix();
    await user.keyboard('s');
    await waitFor(() => expect(column()).toHaveClass('is-overlay'), { timeout: 5000 });
    await waitFor(() => expect(gridUnderColumn()).toBe(true), { timeout: 5000 });
  },
};

// ---------------------------------------------------------------------------
// Clicking a tab node switches tabs; clicking a pane node activates that pane
// ---------------------------------------------------------------------------

export const ClickTabAndPaneActivate: Story = {
  args: {
    height: 500,
    initCommands: [
      'rename-window one',
      'split-window -h',
      'new-window',
      'rename-window two',
      'split-window -h',
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();

    // Click a non-active tab → the app switches to it.
    const tabs = app().context.windows.filter((w) => w.windowType === 'tab');
    const otherTab = tabs.find((w) => w.id !== app().context.activeWindowId)!;
    await userEvent.click(
      tree.querySelector(`[data-testid="tree-tab-${otherTab.id}"]`) as HTMLElement,
    );
    await waitFor(() => expect(app().context.activeWindowId).toBe(otherTab.id), { timeout: 5000 });
    // Wait for the switch to SETTLE, not just the optimistic flip: the state
    // carries every window's panes (like the server's), so the new tab's
    // panes must be there before one can be picked.
    await waitFor(() => expect(tabPanes().some((p) => p.windowId === otherTab.id)).toBe(true), {
      timeout: 5000,
    });

    // Click a pane of that tab that isn't active → it becomes the active pane.
    const target = tabPanes().find(
      (p) => p.windowId === otherTab.id && p.tmuxId !== app().context.activePaneId,
    )!;
    await userEvent.click(
      tree.querySelector(`[data-testid="tree-pane-${target.tmuxId}"]`) as HTMLElement,
    );
    await waitFor(() => expect(app().context.activePaneId).toBe(target.tmuxId), { timeout: 5000 });
  },
};

// ---------------------------------------------------------------------------
// Keyboard navigation: focus the tree, move with j/k, activate with Enter
// ---------------------------------------------------------------------------

export const KeyboardNavigate: Story = {
  args: {
    height: 500,
    initCommands: ['rename-window a', 'new-window', 'rename-window b'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();
    // Every row the two tabs and their panes produce has to be drawn before a
    // key is pressed: the tree fills in as the demo engine answers, and `j`
    // counted against a half-built tree lands on a different row.
    await waitFor(
      () => {
        for (const w of app().context.windows.filter((win) => win.windowType === 'tab')) {
          expect(tree.querySelector(`[data-testid="tree-tab-${w.id}"]`)).not.toBeNull();
        }
        for (const pane of tabPanes()) {
          expect(tree.querySelector(`[data-testid="tree-pane-${pane.tmuxId}"]`)).not.toBeNull();
        }
      },
      { timeout: 8000 },
    );

    // Focus the tree (a click dispatches FOCUS_LEFT_SIDEBAR), then drive it by keyboard.
    await userEvent.click(document.querySelector('[data-testid="sidebar-content"]') as HTMLElement);
    await waitFor(() => expect(tree.getAttribute('data-focused')).toBe('true'), { timeout: 5000 });

    const startWindow = app().context.activeWindowId;
    const user = userEvent.setup({ delay: 5 });
    // Move the selection off the current row and Enter to activate something new.
    await user.keyboard('jjjj');
    // A selected row exists.
    await waitFor(() => expect(tree.querySelector('.is-selected')).not.toBeNull(), {
      timeout: 8000,
    });
    await user.keyboard('{Enter}');
    // Enter activated a tab or pane — the active tab or pane changed from the
    // start — and handed the keyboard to it, the way a click on a pane does.
    await waitFor(
      () => {
        const s = app().context;
        expect(s.activeWindowId !== startWindow || tree.querySelector('.is-active')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    await waitFor(() => expect(tree.getAttribute('data-focused')).toBe('false'), { timeout: 5000 });

    // Back in the tree: Escape is not a tree key (a sidebar pane may need it);
    // `l` hands the keyboard back to the panes.
    await userEvent.click(document.querySelector('[data-testid="sidebar-content"]') as HTMLElement);
    await waitFor(() => expect(tree.getAttribute('data-focused')).toBe('true'), { timeout: 5000 });
    await user.keyboard('{Escape}');
    expect(tree.getAttribute('data-focused')).toBe('true');
    await user.keyboard('l');
    await waitFor(() => expect(tree.getAttribute('data-focused')).toBe('false'), { timeout: 5000 });
  },
};

// ---------------------------------------------------------------------------
// Drag a pane node onto another tab → the pane moves into that tab (join-pane)
// ---------------------------------------------------------------------------

export const DragPaneToAnotherTab: Story = {
  args: {
    // Active tab ("src") has two panes so moving one doesn't close it; a second
    // tab ("dst") is the drop target.
    height: 500,
    initCommands: ['rename-window dst', 'new-window', 'rename-window src', 'split-window -h'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();

    const srcWindowId = app().context.activeWindowId!;
    const dstWindowId = app().context.windows.find(
      (w) => w.windowType === 'tab' && w.id !== srcWindowId,
    )!.id;
    // A pane in the active (src) tab — the only panes the demo exposes.
    const paneToMove = app().context.panes.find((p) => p.windowId === srcWindowId)!.tmuxId;

    const paneEl = tree.querySelector(`[data-testid="tree-pane-${paneToMove}"]`) as HTMLElement;
    const dstTabEl = tree.querySelector(`[data-testid="tree-tab-${dstWindowId}"]`) as HTMLElement;
    expect(paneEl).not.toBeNull();
    expect(dstTabEl).not.toBeNull();

    // Simulate an HTML5 drag-and-drop of the pane node onto the dst tab node.
    const dt = new DataTransfer();
    paneEl.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    dstTabEl.dispatchEvent(
      new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    dstTabEl.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    paneEl.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));

    // The pane now lives in the destination tab's window.
    await waitFor(
      () => {
        const moved = app().context.panes.find((p) => p.tmuxId === paneToMove);
        expect(moved?.windowId).toBe(dstWindowId);
      },
      { timeout: 6000 },
    );
  },
};

// ---------------------------------------------------------------------------
// Drag a tab row up the tree → the tabs reorder, shown before tmux answers
// ---------------------------------------------------------------------------

export const DragTabRowToReorder: Story = {
  args: {
    height: 500,
    initCommands: ['rename-window one', 'new-window', 'rename-window two'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();

    const tabs = () => app().context.windows.filter((w) => w.windowType === 'tab');
    const [first, second] = tabs();
    const firstRow = tree.querySelector(`[data-testid="tree-tab-${first.id}"]`) as HTMLElement;
    const secondRow = tree.querySelector(`[data-testid="tree-tab-${second.id}"]`) as HTMLElement;
    expect(firstRow).not.toBeNull();
    expect(secondRow).not.toBeNull();

    const centre = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const from = centre(secondRow);
    const to = centre(firstRow);
    const pointer = { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true };
    fireEvent.pointerDown(secondRow, { ...pointer, clientX: from.x, clientY: from.y });
    fireEvent.pointerMove(secondRow, { ...pointer, clientX: from.x, clientY: to.y - 4 });
    // Mid-drag: the row rides with the pointer and the first tab carries the
    // drop bar — the tree says where the drop lands before it lands.
    await waitFor(() => {
      expect(secondRow).toHaveClass('is-dragging');
      expect(firstRow).toHaveClass('is-drop-before');
    });
    expect(centre(secondRow).y).toBeLessThan(from.y - 10);

    fireEvent.pointerUp(secondRow, { ...pointer, clientX: from.x, clientY: to.y - 4 });
    fireEvent.click(secondRow, { clientX: from.x, clientY: to.y - 4 });
    // The order is the dropped one at once (predicted), in the model and in
    // the tree; the drop was not a click, so the active tab did not change.
    await waitFor(() => {
      expect(tabs().map((w) => w.id)).toEqual([second.id, first.id]);
      const rows = [...tree.querySelectorAll('.sidebar-tree-tab[data-window-id]')].map(
        (el) => (el as HTMLElement).dataset.windowId,
      );
      expect(rows).toEqual([second.id, first.id]);
    });
    expect(tree.querySelector('.is-dragging, .is-drop-before, .is-drop-after')).toBeNull();
    expect(app().context.activeWindowId).toBe(second.id);
  },
};

// ---------------------------------------------------------------------------
// The tree sits on the chrome: nothing up to the column paints a background,
// and one row in the whole tree takes the accent
// ---------------------------------------------------------------------------

export const TreeSitsOnTheChrome: Story = {
  args: { height: 400, initCommands: ['split-window -h', 'new-window'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();
    const column = document.querySelector('.sidebar-column-left') as HTMLElement;
    const transparent = 'rgba(0, 0, 0, 0)';

    // Over the panes, the column brings the window's ground with it — the
    // panes must not read through the tree.
    await waitFor(() => expect(column).toHaveClass('is-overlay'));
    const windowGround = document.createElement('span');
    windowGround.style.backgroundColor = 'rgb(var(--window-bg-rgb))';
    document.body.appendChild(windowGround);
    expect(getComputedStyle(column).backgroundColor).toBe(
      getComputedStyle(windowGround).backgroundColor,
    );
    windowGround.remove();

    // Fixed (`prefix s` on the open column), it docks beside the grid, and
    // from the tree up to and including the column every element is
    // see-through: a sidebar is chrome, so the window's ground runs on behind
    // it and only the panes are dark.
    await userEvent.keyboard('{Control>}a{/Control}');
    await userEvent.keyboard('s');
    await waitFor(() => expect(column).not.toHaveClass('is-overlay'));
    let el: HTMLElement | null = tree;
    while (el && !el.classList.contains('sidebar-column')) {
      expect(getComputedStyle(el).backgroundColor, el.className).toBe(transparent);
      el = el.parentElement;
    }
    expect(el).not.toBeNull();
    expect(getComputedStyle(el!).backgroundColor).toBe(transparent);

    // The ink ladder: the pane with the keyboard is the one row in its colour,
    // and the current tab's row above it is not drawn in it.
    await waitFor(() => expect(tree.querySelectorAll('.sidebar-tree-pane')).toHaveLength(3));
    const color = (row: Element) => getComputedStyle(row).color;
    const activePane = tree.querySelector('.sidebar-tree-pane.is-active')!;
    const rows = [...tree.querySelectorAll('.sidebar-tree-tab, .sidebar-tree-pane')];
    expect(rows.filter((row) => color(row) === color(activePane))).toHaveLength(1);
    const currentTab = tree.querySelector('.sidebar-tree-tab.is-active')!;
    const otherTab = tree.querySelector('.sidebar-tree-tab:not(.is-active)')!;
    expect(color(currentTab)).not.toBe(color(otherTab));
    // Only the current tab's row sits on a band.
    expect(getComputedStyle(currentTab).backgroundColor).not.toBe(transparent);
    expect(getComputedStyle(otherTab).backgroundColor).toBe(transparent);
  },
};

// ---------------------------------------------------------------------------
// Fixed sidebar reflows the panes into the remaining width (not an overlay)
// ---------------------------------------------------------------------------

export const FixedSidebarReflowsPanes: Story = {
  args: { height: 500, initCommands: ['split-window -h'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const paneRects = () =>
      [...canvasElement.querySelectorAll('.pane-layout-item[data-pane-id]')].map((el) =>
        el.getBoundingClientRect(),
      );
    await waitFor(() => expect(paneRects().length).toBeGreaterThanOrEqual(2), { timeout: 8000 });

    // Before: panes fill the whole width, starting at the container's left edge.
    const before = paneRects();
    const beforeLeft = Math.min(...before.map((r) => r.left));
    const beforeRight = Math.max(...before.map((r) => r.right));

    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const sidebar = await waitFor(
      () => {
        const el = document.querySelector('.sidebar-column-left') as HTMLElement | null;
        if (!el) throw new Error('no sidebar column');
        return el;
      },
      { timeout: 8000 },
    );
    // A column opens over the panes; `prefix s` on the open column fixes it.
    await userEvent.keyboard('{Control>}a{/Control}');
    await userEvent.keyboard('s');

    // After: the sidebar is a real column, and every pane sits to the RIGHT of
    // it (no overlap) while still reaching the same right edge (fills the space
    // that's left — the pane area recalculated, it's not an overlay).
    await waitFor(
      () => {
        const s = sidebar.getBoundingClientRect();
        expect(s.width).toBeGreaterThan(50);
        const after = paneRects();
        expect(after.length).toBeGreaterThanOrEqual(2);
        const afterLeft = Math.min(...after.map((r) => r.left));
        const afterRight = Math.max(...after.map((r) => r.right));
        // Panes shifted right, clear of the sidebar column.
        expect(afterLeft).toBeGreaterThanOrEqual(s.right - 1);
        expect(afterLeft).toBeGreaterThan(beforeLeft + 50);
        // Still filling to (about) the same right edge — no dead gap.
        expect(Math.abs(afterRight - beforeRight)).toBeLessThan(12);
      },
      { timeout: 6000, interval: 200 },
    );

    // Sidebar column is full-height (matches the pane area height).
    const paneArea = canvasElement.querySelector('.pane-container') as HTMLElement;
    expect(sidebar.getBoundingClientRect().height).toBeGreaterThan(
      paneArea.getBoundingClientRect().height - 4,
    );
  },
};

// ---------------------------------------------------------------------------
// Pane nodes show the same title + process icon as the pane header tabs
// ---------------------------------------------------------------------------

export const PaneNodesShowHeaderTitle: Story = {
  args: { height: 500, initCommands: ['split-window -h'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();

    const panes = tabPanes();
    expect(panes.length).toBeGreaterThanOrEqual(2);

    for (const p of panes) {
      const row = tree.querySelector(`[data-testid="tree-pane-${p.tmuxId}"]`) as HTMLElement;
      expect(row).not.toBeNull();
      // `%id name` — the id leads, dim, because it is what tells two panes
      // running the same program apart ('bash' twice is the common case); the
      // process name follows it as the bold half.
      const id = row.querySelector('.sidebar-tree-id') as HTMLElement;
      const name = row.querySelector('.sidebar-tree-name') as HTMLElement;
      expect(id.textContent).toBe(p.tmuxId);
      expect(name.textContent).toBe('bash');
      // Process icon rendered alongside it, after the tree connector.
      expect(row.querySelector('.sidebar-tree-icon')).not.toBeNull();
      expect(row.querySelector('.sidebar-tree-branch')).not.toBeNull();
    }

    // The tree column itself is never a row in its own tree.
    const treeWindow = app().context.windows.find((w) => w.windowType === 'sidebar-left')!;
    const treePane = app().context.panes.find((p) => p.windowId === treeWindow.id)!;
    expect(treePane).not.toBeUndefined();
    expect(tree.querySelector(`[data-testid="tree-pane-${treePane.tmuxId}"]`)).toBeNull();
  },
};

// ---------------------------------------------------------------------------
// Right-clicking a pane / tab node opens the same context menu the header uses
// ---------------------------------------------------------------------------

function rightClick(el: HTMLElement): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
  );
}

const menuLabels = (): string[] =>
  [...document.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent ?? '');

// Nightly while quarantined for `probe-timeout` (scripts/probe-quarantine.json):
// a story that is going to sit at the per-story deadline costs the commit
// probe two minutes a push and gates nothing there.
export const RightClickContextMenus: Story = {
  tags: ['nightly'],
  args: {
    height: 500,
    initCommands: ['rename-window one', 'new-window', 'rename-window two', 'split-window -h'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();

    // Right-click a pane node → the pane context menu (same items as the header).
    const paneId = tabPanes()[0].tmuxId;
    rightClick(tree.querySelector(`[data-testid="tree-pane-${paneId}"]`) as HTMLElement);
    await waitFor(() => expect(menuLabels().some((t) => t.includes('Clear Screen'))).toBe(true), {
      timeout: 5000,
    });
    expect(menuLabels().some((t) => t.includes('Close Pane'))).toBe(true);
    // Clicking an item runs it and dismisses the menu.
    const clearItem = [...document.querySelectorAll('[role="menuitem"]')].find((n) =>
      (n.textContent ?? '').includes('Clear Screen'),
    ) as HTMLElement;
    await userEvent.click(clearItem);
    await waitFor(() => expect(document.querySelector('[role="menuitem"]')).toBeNull(), {
      timeout: 5000,
    });

    // Right-click a tab node → the tab context menu (New Tab / Close Tab / …).
    const windowId = app().context.activeWindowId!;
    rightClick(tree.querySelector(`[data-testid="tree-tab-${windowId}"]`) as HTMLElement);
    await waitFor(() => expect(menuLabels().some((t) => t.includes('New Tab'))).toBe(true), {
      timeout: 5000,
    });
    expect(menuLabels().some((t) => t.includes('Close Tab'))).toBe(true);

    // Clicking an item runs it and closes the menu (proves the action wiring).
    const closeTab = [...document.querySelectorAll('[role="menuitem"]')].find((n) =>
      (n.textContent ?? '').includes('Close Tab'),
    ) as HTMLElement;
    await userEvent.click(closeTab);
    await waitFor(() => expect(document.querySelector('[role="menuitem"]')).toBeNull(), {
      timeout: 5000,
    });
  },
};

// ---------------------------------------------------------------------------
// The RIGHT column's slide leaves the panes' left edge exactly where it was
// ---------------------------------------------------------------------------

export const RightColumnSlideDoesNotMoveTheLeftEdge: Story = {
  tags: ['nightly'],
  args: { height: 500, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      description: {
        story:
          "Toggling the dock resizes the pane area from its right edge, so its LEFT edge must not move — not at the end, and not for a frame in between. The grid is re-tiled for the settled width the moment the toggle starts, so it is centred against that width rather than against the container's live one; centring a settled grid inside a still-moving container is what used to walk the panes sideways for the length of the animation.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const leftEdge = () => {
      const rects = [...canvasElement.querySelectorAll('.pane-layout-item[data-pane-id]')].map(
        (el) => el.getBoundingClientRect(),
      );
      return rects.length ? Math.min(...rects.map((r) => r.left)) : null;
    };
    await waitFor(() => expect(leftEdge()).not.toBeNull(), { timeout: 8000 });
    // A docked dock is what resizes the pane area.
    await fixColumn(canvasElement, 'right');
    await waitFor(() => expect(leftEdge()).not.toBeNull(), { timeout: 8000 });

    const before = leftEdge()!;
    const samples: number[] = [];
    let sampling = true;
    const tick = () => {
      const edge = leftEdge();
      if (edge !== null) samples.push(edge);
      if (sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle terminal sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);

    // Wait for the column to be there and the slide to be over.
    await waitFor(
      () => {
        const el = document.querySelector('.sidebar-column-right') as HTMLElement | null;
        if (!el) throw new Error('no dock column');
        expect(el.getBoundingClientRect().width).toBeGreaterThan(20);
      },
      { timeout: 8000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    sampling = false;

    // The dock really took width out of the pane area...
    const after = leftEdge()!;
    const rects = [...canvasElement.querySelectorAll('.pane-layout-item[data-pane-id]')].map((el) =>
      el.getBoundingClientRect(),
    );
    const dock = document.querySelector('.sidebar-column-right')!.getBoundingClientRect();
    expect(Math.max(...rects.map((r) => r.right))).toBeLessThanOrEqual(dock.left + 1);

    // ...and the left edge never moved, at any frame of it. The tolerance is
    // the sub-cell remainder the grid is centred within, not room for a slide.
    expect(samples.length).toBeGreaterThan(5);
    const drift = Math.max(...samples.map((x) => Math.abs(x - before)));
    expect(drift).toBeLessThan(6);
    expect(Math.abs(after - before)).toBeLessThan(6);
  },
};

// ---------------------------------------------------------------------------
// The tree is THIS session's, whatever else the socket hosts
// ---------------------------------------------------------------------------

export const OtherSessionsStayOutOfTheTree: Story = {
  args: {
    height: 500,
    initCommands: ['rename-window main', 'split-window -h'],
  },
  parameters: {
    docs: {
      description: {
        story:
          'The `serversActor` poll enumerates every session on the socket — the session switcher is built from it — but the tree draws only the session the client is attached to. Rows for another session had no live state behind them and nothing in the tree could act on them; switching session is asked and answered in the switcher instead.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();

    const win = window as unknown as {
      app: { getSnapshot(): { context: { sessionName: string } }; send(e: unknown): void };
    };
    const activeName = win.app.getSnapshot().context.sessionName;

    // The live tabs are there to begin with.
    const liveWindowId = app().context.activeWindowId!;
    await waitFor(
      () => {
        expect(tree.querySelector(`[data-testid="tree-tab-${liveWindowId}"]`)).not.toBeNull();
      },
      { timeout: 5000 },
    );
    const rowsBefore = tree.querySelectorAll('[role="treeitem"]').length;

    // The poll reports a second session on the socket, exactly as it would on
    // a real multi-session server.
    win.app.send({
      type: 'SESSIONS_UPDATED',
      sessions: [
        { sessionName: activeName, windows: [], panes: [] },
        {
          sessionName: 'work',
          windows: [{ id: '@9', index: 0, name: 'editor' }],
          panes: [{ id: '%9', windowId: '@9', command: 'nvim', active: true }],
        },
      ],
    });

    // Nothing about the tree changes: no session header, no row for the other
    // session's tab or pane, and the same rows as before.
    await waitFor(
      () => {
        expect(app().context.sessions.length).toBe(2);
      },
      { timeout: 5000 },
    );
    expect(tree.querySelector('[data-testid="tree-session-work"]')).toBeNull();
    expect(tree.querySelector(`[data-testid="tree-session-${activeName}"]`)).toBeNull();
    expect(tree.querySelector('[data-testid="tree-foreign-tab-@9"]')).toBeNull();
    expect(tree.querySelector('[data-testid="tree-foreign-pane-%9"]')).toBeNull();
    expect(tree.querySelectorAll('[role="treeitem"]').length).toBe(rowsBefore);
    expect(tree.querySelector(`[data-testid="tree-tab-${liveWindowId}"]`)).not.toBeNull();
  },
};

// ---------------------------------------------------------------------------
// Dragging a column's inner edge resizes both the column and its tmux pane
// ---------------------------------------------------------------------------

export const DragResizesTheColumn: Story = {
  args: { height: 500 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // A docked column, so the grid gives up what the column takes.
    await fixColumn(canvasElement, 'left');
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);

    const column = await waitFor(
      () => {
        const el = document.querySelector('.sidebar-column-left') as HTMLElement | null;
        if (!el) throw new Error('no sidebar column');
        return el;
      },
      { timeout: 8000 },
    );
    const handle = column.querySelector('.sidebar-resize-handle') as HTMLElement;
    expect(handle).not.toBeNull();
    // The column slides open; measure it once it has stopped moving, or the
    // widths below are mid-slide and a column short. Generously — on a loaded
    // machine the slide alone can take seconds, which is a slow runner rather
    // than a column that never settles.
    await waitFor(() => expect(column.className).not.toContain('is-moving'), { timeout: 8000 });

    const startWidth = column.getBoundingClientRect().width;
    // The width the grid has left. A column that grew without the grid giving
    // up the same space would be overlapping the panes, not docked beside them.
    const gridCols = () => Math.max(...tabPanes().map((p) => p.width));
    const startGridCols = gridCols();
    expect(startGridCols).toBeGreaterThan(0);

    // Drag the inner edge 90px to the right. Driven as pointer events on the
    // handle, because the drag is what a user actually does — the column has no
    // width control to call. The handle captures the pointer, so the move and
    // the release go to the handle itself, as they would from a real mouse.
    const box = handle.getBoundingClientRect();
    const startX = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    const pointer = (type: string, clientX: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY: y,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      });
    handle.dispatchEvent(pointer('pointerdown', startX));
    // The drag state lands on the next render; a real drag has human-scale
    // delay here, so wait for it rather than moving synchronously.
    await waitFor(() => expect(handle.className).toContain('is-dragging'), { timeout: 8000 });
    handle.dispatchEvent(pointer('pointermove', startX + 90));
    // A real mouse never releases in the same task as the move it finished on.
    // The handler applies the move on the next frame, so releasing immediately
    // let the release be handled first and the drag end where it started.
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    handle.dispatchEvent(pointer('pointerup', startX + 90));

    // The column is drawn wider, and the pane grid gave space up for it — the
    // resize re-tiles the panes rather than covering them. (How MUCH the grid
    // loses is the container's business, not the drag's.)
    await waitFor(
      () => {
        expect(column.getBoundingClientRect().width).toBeGreaterThan(startWidth + 40);
        expect(gridCols()).toBeLessThan(startGridCols);
      },
      { timeout: 6000, interval: 200 },
    );

    // The width is committed on the column's own tmux window, which is what
    // makes it outlive this client rather than being a local style.
    const treeWindow = app().context.windows.find((w) => w.windowType === 'sidebar-left')!;
    expect(treeWindow.sidebarCols).toBe(
      Math.round(column.getBoundingClientRect().width / app().context.charWidth),
    );
  },
};

// ---------------------------------------------------------------------------
// A tab folds its panes away, leaving the count + rolled-up state behind
// ---------------------------------------------------------------------------

export const TabsCollapseToHideTheirPanes: Story = {
  args: { height: 500, initCommands: ['rename-window main', 'split-window -h'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup({ delay: 5 });
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await user.click(toggle);
    const tree = await waitForTree();

    const windowId = app().context.activeWindowId!;
    const paneIds = tabPanes()
      .filter((p) => p.windowId === windowId)
      .map((p) => p.tmuxId);
    expect(paneIds.length).toBeGreaterThanOrEqual(2);

    const paneRow = (id: string) =>
      tree.querySelector(`[data-testid="tree-pane-${id}"]`) as HTMLElement | null;
    const treeBox = () => tree.getBoundingClientRect();

    // Expanded by default: every pane row is drawn, and drawn inside the column.
    for (const id of paneIds) {
      const row = paneRow(id);
      expect(row).not.toBeNull();
      const box = row!.getBoundingClientRect();
      expect(box.height).toBeGreaterThan(0);
      expect(box.top).toBeGreaterThanOrEqual(treeBox().top - 1);
    }

    // Fold it from the chevron — the row itself still selects the tab.
    const chevron = tree.querySelector(`[data-testid="tree-chevron-${windowId}"]`) as HTMLElement;
    expect(chevron).not.toBeNull();
    await user.click(chevron);

    await waitFor(
      () => {
        for (const id of paneIds) expect(paneRow(id)).toBeNull();
      },
      { timeout: 5000 },
    );

    // Folded, the tab still says how much it is hiding — that count and the
    // state beside it are the only signal a collapsed tab has left.
    const tabRow = tree.querySelector(`[data-testid="tree-tab-${windowId}"]`) as HTMLElement;
    expect(tabRow.getAttribute('data-collapsed')).toBe('true');
    expect(tabRow.getAttribute('aria-expanded')).toBe('false');
    const count = tabRow.querySelector('.sidebar-tree-count') as HTMLElement;
    expect(count.textContent).toBe(String(paneIds.length));
    const countBox = count.getBoundingClientRect();
    expect(countBox.width).toBeGreaterThan(0);
    expect(countBox.right).toBeLessThanOrEqual(treeBox().right + 1);

    // ...and unfolding brings them back.
    await user.click(chevron);
    await waitFor(
      () => {
        for (const id of paneIds) expect(paneRow(id)).not.toBeNull();
      },
      { timeout: 5000 },
    );
    expect(tabRow.getAttribute('aria-expanded')).toBe('true');
  },
};

// ---------------------------------------------------------------------------
// A pane's state is whatever the pane declared, and a tab rolls its panes up
// ---------------------------------------------------------------------------

export const PaneStateIsWhatThePaneDeclares: Story = {
  args: { height: 500, initCommands: ['rename-window agents', 'split-window -h'] },
  parameters: {
    docs: {
      description: {
        story:
          'tmuxy never infers what a pane is doing: the pane says so itself by setting `@tmuxy-pane-state`, which is what `tmuxy pane state <value>` does from inside it — an agent hook, a shell precmd/preexec pair, or a build script on failure. Here the option is set through the same tmux command that CLI issues. A tab rolls its panes up to the most attention-worthy of them, so a tab holding a blocked pane reads as needs-input even when another pane is merely working.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup({ delay: 5 });
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await user.click(toggle);
    const tree = await waitForTree();

    const windowId = app().context.activeWindowId!;
    const paneIds = tabPanes()
      .filter((p) => p.windowId === windowId)
      .map((p) => p.tmuxId);
    expect(paneIds.length).toBeGreaterThanOrEqual(2);
    const [busy, blocked] = paneIds;

    // What `tmuxy pane state` runs, through the same command path.
    const win = window as unknown as { app: { send(e: unknown): void } };
    const declare = (paneId: string, state: string) =>
      win.app.send({
        type: 'SEND_TMUX_COMMAND',
        command: `set-option -p -t ${paneId} @tmuxy-pane-state ${state}`,
      });
    declare(busy, 'working');
    declare(blocked, 'needs-input');

    const paneRow = (id: string) =>
      tree.querySelector(`[data-testid="tree-pane-${id}"]`) as HTMLElement;

    await waitFor(
      () => {
        expect(paneRow(busy).getAttribute('data-pane-state')).toBe('working');
        expect(paneRow(blocked).getAttribute('data-pane-state')).toBe('needs-input');
      },
      { timeout: 6000, interval: 100 },
    );

    // The indicator is really drawn, in the pane's icon place: on the first
    // line, just ahead of the process name, as on the pane's own header.
    const badge = paneRow(blocked).querySelector(
      '.sidebar-tree-state.is-needs-input',
    ) as HTMLElement;
    expect(badge).not.toBeNull();
    const badgeBox = badge.getBoundingClientRect();
    const name = paneRow(blocked).querySelector('.sidebar-tree-line .sidebar-tree-name')!;
    const nameBox = name.getBoundingClientRect();
    expect(badgeBox.width).toBeGreaterThan(0);
    expect(badgeBox.right).toBeLessThanOrEqual(nameBox.left + 1);
    expect(
      Math.abs(badgeBox.top + badgeBox.height / 2 - (nameBox.top + nameBox.height / 2)),
    ).toBeLessThan(nameBox.height / 2);

    // The tab shows the most attention-worthy state among its panes, so the
    // blocked pane wins over the working one.
    const tabRow = tree.querySelector(`[data-testid="tree-tab-${windowId}"]`) as HTMLElement;
    expect(tabRow.querySelector('.sidebar-tree-state.is-needs-input')).not.toBeNull();

    // The mark is the Nerd Font warning triangle in the theme's orange, its
    // whole ink inside its box; a failure is the circled x in the error red.
    const tokenColor = (token: string) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const inkFits = (mark: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(mark);
      return range.getBoundingClientRect().width <= mark.getBoundingClientRect().width + 0.5;
    };
    expect(badge.textContent).toBe('\u{f071}');
    expect(getComputedStyle(badge).color).toBe(tokenColor('--accent-orange'));
    expect(inkFits(badge)).toBe(true);

    declare(blocked, 'error');
    const failed = await waitFor(
      () => {
        const mark = paneRow(blocked).querySelector('.sidebar-tree-state.is-error');
        expect(mark).not.toBeNull();
        return mark as HTMLElement;
      },
      { timeout: 6000, interval: 100 },
    );
    expect(failed.textContent).toBe('\u{f057}');
    expect(getComputedStyle(failed).color).toBe(tokenColor('--error-color'));
    expect(inkFits(failed)).toBe(true);
  },
};

// ---------------------------------------------------------------------------
// A tree with more rows than the column is tall scrolls INSIDE the column
// ---------------------------------------------------------------------------

export const TallTreeScrollsInsideTheColumn: Story = {
  tags: ['nightly'],
  args: {
    height: 400,
    initCommands: ['rename-window main', ...Array.from({ length: 11 }, () => 'new-window')],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Twelve tabs and their panes are more rows than a 400px column can show. The tree has to scroll within the column: its box stays inside the column (rather than growing past the bottom edge and being clipped away with no way to reach the rest), and walking the keyboard cursor down to the last row brings that row into view.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup({ delay: 1 });
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await user.click(toggle);
    const tree = await waitForTree();
    const column = document.querySelector('.sidebar-column-left') as HTMLElement;
    expect(column).not.toBeNull();
    await waitFor(() => expect(column.className).not.toContain('is-moving'), { timeout: 3000 });

    // Every tab and its pane got a row — far more rows than the column is tall.
    const rows = () => [...tree.querySelectorAll('[role="treeitem"]')] as HTMLElement[];
    await waitFor(() => expect(rows().length).toBeGreaterThanOrEqual(20), { timeout: 8000 });

    // The tree is bounded by its column: a box that grew past the bottom edge
    // would have its extra rows clipped by the column with nothing to scroll.
    const columnBox = column.getBoundingClientRect();
    expect(tree.getBoundingClientRect().bottom).toBeLessThanOrEqual(columnBox.bottom + 1);

    // …and it overflows that box, so it is genuinely scrollable.
    expect(tree.scrollHeight).toBeGreaterThan(tree.clientHeight + 1);

    // It opens on the active pane's row, at the bottom of a tree this long, so
    // the top of it starts out scrolled off the column.
    const firstRow = () => rows()[0];
    const lastRow = () => rows()[rows().length - 1];
    const openedAt = tree.scrollTop;
    expect(openedAt).toBeGreaterThan(0);
    expect(firstRow().getBoundingClientRect().top).toBeLessThan(columnBox.top);

    // Walking the keyboard cursor up brings the top of the tree back into view —
    // which is what makes the rows past a fold reachable at all.
    await user.click(tree);
    await waitFor(() => expect(tree.getAttribute('data-focused')).toBe('true'), { timeout: 5000 });
    await user.keyboard('k'.repeat(rows().length));
    await waitFor(
      () => {
        // Scrolled back up (not necessarily to 0 — the tree's top padding sits
        // above the first row, and `block: 'nearest'` stops at the row itself).
        expect(tree.scrollTop).toBeLessThan(openedAt);
        const box = firstRow().getBoundingClientRect();
        expect(box.top).toBeGreaterThanOrEqual(columnBox.top - 1);
        expect(box.bottom).toBeLessThanOrEqual(columnBox.bottom + 1);
      },
      { timeout: 6000, interval: 100 },
    );

    // …and walking it back down scrolls the far end into view the same way.
    await user.keyboard('j'.repeat(rows().length));
    await waitFor(
      () => {
        expect(tree.scrollTop).toBeGreaterThan(0);
        const box = lastRow().getBoundingClientRect();
        expect(box.top).toBeGreaterThanOrEqual(columnBox.top - 1);
        expect(box.bottom).toBeLessThanOrEqual(columnBox.bottom + 1);
      },
      { timeout: 6000, interval: 100 },
    );
  },
};

export const TogglesKeepTheirPlace: Story = {
  args: { height: 500 },
  play: async ({ canvasElement }) => {
    // The click that opens a column must close it from the same spot: the
    // tree's toggle stays at the header's left end and the dock's at its
    // right end, whether the columns are open or closed. Both columns fixed,
    // so both can be open at once (overlaying, only one shows).
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane/i }, { timeout: 8000 });
    await fixColumn(canvasElement, 'left');
    await fixColumn(canvasElement, 'right');
    const left = await canvas.findByRole('button', { name: /toggle tree sidebar/i });
    const right = await canvas.findByRole('button', { name: /toggle terminal sidebar/i });
    const place = () => ({
      left: Math.round(left.getBoundingClientRect().left),
      right: Math.round(right.getBoundingClientRect().right),
    });
    const closed = place();

    await userEvent.click(left);
    await waitFor(() => expect(left).toHaveAttribute('aria-pressed', 'true'), { timeout: 8000 });
    await userEvent.click(right);
    await waitFor(() => expect(right).toHaveAttribute('aria-pressed', 'true'), { timeout: 8000 });
    await waitFor(() => expect(document.querySelector('.sidebar-column-right')).not.toBeNull(), {
      timeout: 8000,
    });
    expect(place()).toEqual(closed);

    await userEvent.click(left);
    await userEvent.click(right);
    await waitFor(() => expect(left).toHaveAttribute('aria-pressed', 'false'), { timeout: 8000 });
    await waitFor(() => expect(right).toHaveAttribute('aria-pressed', 'false'), { timeout: 8000 });
    expect(place()).toEqual(closed);
  },
};

// ---------------------------------------------------------------------------
// Keyboard only: Tab walks the chrome in order and always finds its way back
// ---------------------------------------------------------------------------

/**
 * Someone driving the app from the keyboard alone has to be able to walk the
 * chrome and get back where they started. With the tree column open, Tab is
 * pressed from the sidebar toggle until the focus wraps round to it again, and
 * every stop is recorded.
 *
 * The walk has to complete the loop rather than stalling or circling inside
 * one surface, take in the tab strip and the app menu on the way, stop only on
 * controls the user can actually see, and move in document order, which is the
 * order the controls are read in.
 */
export const TabOrderNeverTrapsTheKeyboard: Story = {
  args: {
    height: 500,
    initCommands: ['rename-window main', 'new-window', 'rename-window logs'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    await waitForTree();

    const sidebar = document.querySelector('.sidebar-column-left') as HTMLElement;
    expect(sidebar).not.toBeNull();
    // The column slides in; walking it mid-slide measures boxes that are still
    // moving and can tab onto a control that has not arrived yet.
    await waitFor(() => expect(sidebar.className).not.toContain('is-moving'), { timeout: 8000 });

    // Walk both ways from the toggle until the focus leaves the page, which is
    // what Tab past the last control does in any browser: a walk that never
    // leaves is the trap. (Back into the page is the browser's own move, which
    // a page cannot press for; from nothing focused, Tab is the terminal's.)
    // The toggle is focused the way a keyboard user arrives, not by the click
    // above: a clicked button keeps the focus, and the Tab typed next is the
    // shell's.
    toggle.blur();
    toggle.focus();
    const walk = async (shift: boolean): Promise<HTMLElement[]> => {
      toggle.focus();
      const stops: HTMLElement[] = [toggle];
      for (let press = 0; press < 30; press++) {
        await userEvent.tab({ shift });
        const focused = document.activeElement as HTMLElement;
        if (focused === document.body) return stops.slice(1);
        const trace = stops.map((el) => el.className || el.tagName).join(' -> ');
        expect(
          focused,
          `Tab did not move the focus off ${focused.className || focused.outerHTML.slice(0, 120)}: ${trace}`,
        ).not.toBe(stops[stops.length - 1]);
        expect(
          stops.includes(focused),
          `Tab came back to ${focused.className} without leaving the page: ${trace}`,
        ).toBe(false);
        // Every stop is a control the user can see — a focus ring on a clipped
        // or zero-sized element is a stop nobody can find.
        const box = focused.getBoundingClientRect();
        expect(box.width, `a stop with no width: ${focused.className}`).toBeGreaterThan(0);
        expect(box.height, `a stop with no height: ${focused.className}`).toBeGreaterThan(0);
        stops.push(focused);
      }
      throw new Error('Tab never left the page in 30 presses');
    };
    const stops = [...(await walk(true)).reverse(), toggle, ...(await walk(false))];

    // In document order: the reading order and the tab order are the same.
    for (let i = 1; i < stops.length; i++) {
      const follows =
        stops[i - 1].compareDocumentPosition(stops[i]) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(
        Boolean(follows),
        `${stops[i].className} is reached after ${stops[i - 1].className} but comes before it`,
      ).toBe(true);
    }

    // The tab strip is on the way: its "new tab" control is a stop. The trace
    // goes in the message so a walk that changes shape says how it changed.
    const trace = stops.map((el) => el.className || el.tagName).join(' -> ');
    expect(
      stops.some((el) => el.closest('.tab-add') !== null),
      `the tab strip is not in the tab order: ${trace}`,
    ).toBe(true);
    expect(stops.length, `too few stops to be the whole chrome: ${trace}`).toBeGreaterThan(2);
  },
};
