/**
 * Sidebar stories (demo engine).
 *
 * The left sidebar is now a native React tab/pane tree (`SidebarTree`) rendered
 * in a fixed-width, full-height column that flexes the pane area — no tmux
 * window/pane, no `tmuxy tree` TUI. The tree is derived from the demo's
 * `context.windows`/`context.panes`, so these stories exercise the real user
 * chain: TOGGLE_SIDEBAR (button or `prefix t`) → column opens → tree lists every
 * tab and its panes → clicking / keyboard-navigating a node activates it through
 * the same events the rest of the UI uses.
 *
 * Context menus (`@szhsin/react-menu`) portal to document.body, so menu queries
 * run against `document`, not `canvasElement`.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';

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
    windows: Array<{ id: string; index: number; name: string; windowType: string | null }>;
    panes: Array<{ tmuxId: string; windowId: string }>;
  };
}
const app = () => (window as unknown as { app: { getSnapshot(): AppSnap } }).app.getSnapshot();

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
      { name: /toggle sidebar/i },
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
    for (const p of app().context.panes) {
      expect(tree.querySelector(`[data-testid="tree-pane-${p.tmuxId}"]`)).not.toBeNull();
    }
    // Renamed tab labels show up.
    expect(tree.textContent).toContain('main');
    expect(tree.textContent).toContain('logs');
    // Drawer content has real size (catches zero-height / clip bugs).
    const content = document.querySelector('[data-testid="sidebar-content"]') as HTMLElement;
    const rect = content.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(50);
    expect(rect.height).toBeGreaterThan(50);

    // Clicking the toggle again closes the drawer.
    await userEvent.click(toggle);
    await waitFor(() => expect(document.querySelector('.sidebar-tree')).toBeNull(), {
      timeout: 5000,
    });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  },
};

// ---------------------------------------------------------------------------
// `prefix t` toggles the sidebar (keyboard user path)
// ---------------------------------------------------------------------------

export const OpenViaPrefixT: Story = {
  args: { height: 500, initCommands: ['rename-window editor'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('t');
    await waitForTree();
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('t');
    await waitFor(() => expect(document.querySelector('.sidebar-tree')).toBeNull(), {
      timeout: 5000,
    });
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
      { name: /toggle sidebar/i },
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
    // Wait for the switch to SETTLE, not just the optimistic flip: the demo
    // (like tmux list-panes routing) emits panes for the active window, so
    // until its response lands, context.panes still holds the old window's
    // panes. The old removingPane 300ms hold used to mask this transient.
    await waitFor(
      () => expect(app().context.panes.every((p) => p.windowId === otherTab.id)).toBe(true),
      { timeout: 5000 },
    );

    // Click a pane that isn't active → it becomes the active pane.
    const target = app().context.panes.find((p) => p.tmuxId !== app().context.activePaneId)!;
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
      { name: /toggle sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();

    // Focus the tree (a click dispatches FOCUS_SIDEBAR), then drive it by keyboard.
    await userEvent.click(document.querySelector('[data-testid="sidebar-content"]') as HTMLElement);
    await waitFor(() => expect(tree.getAttribute('data-focused')).toBe('true'), { timeout: 5000 });

    const startWindow = app().context.activeWindowId;
    const user = userEvent.setup({ delay: 5 });
    // Move the selection off the current row and Enter to activate something new.
    await user.keyboard('jjjj');
    // A selected row exists.
    await waitFor(() => expect(tree.querySelector('.is-selected')).not.toBeNull(), {
      timeout: 3000,
    });
    await user.keyboard('{Enter}');
    // Enter activated a tab or pane — the active tab or pane changed from the start.
    await waitFor(
      () => {
        const s = app().context;
        expect(s.activeWindowId !== startWindow || tree.querySelector('.is-active')).toBeTruthy();
      },
      { timeout: 5000 },
    );

    // Escape blurs the tree.
    await user.keyboard('{Escape}');
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
      { name: /toggle sidebar/i },
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
      { name: /toggle sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const sidebar = await waitFor(
      () => {
        const el = document.querySelector('.sidebar-fixed') as HTMLElement | null;
        if (!el) throw new Error('no sidebar column');
        return el;
      },
      { timeout: 8000 },
    );

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
      { name: /toggle sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();

    for (const p of app().context.panes) {
      const row = tree.querySelector(`[data-testid="tree-pane-${p.tmuxId}"]`) as HTMLElement;
      const label = row.querySelector('.sidebar-tree-label') as HTMLElement;
      // Same title the pane header shows (command → 'bash' for the demo shell),
      // NOT the old "%id command" form.
      expect(label.textContent).toBe('bash');
      expect(label.textContent).not.toContain(p.tmuxId);
      // Process icon rendered alongside it.
      expect(row.querySelector('.sidebar-tree-icon')).not.toBeNull();
    }
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

export const RightClickContextMenus: Story = {
  args: {
    height: 500,
    initCommands: ['rename-window one', 'new-window', 'rename-window two', 'split-window -h'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();

    // Right-click a pane node → the pane context menu (same items as the header).
    const paneId = app().context.panes[0].tmuxId;
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
// Multi-session tree: once more than one session exists, SESSIONS_UPDATED groups
// the tree by session, with the active session expanded to its live tabs/panes
// and other sessions expanded to read-only foreign rows. The `serversActor` poll
// feeds this on web + desktop alike; here we deliver it the same way the poll
// would.
// ---------------------------------------------------------------------------

export const GroupedSessionsTree: Story = {
  args: {
    height: 500,
    initCommands: ['rename-window main', 'split-window -h'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const tree = await waitForTree();

    const win = window as unknown as {
      app: { getSnapshot(): { context: { sessionName: string } }; send(e: unknown): void };
    };
    const activeName = win.app.getSnapshot().context.sessionName;

    // Simulate the desktop poll delivering every session on the server.
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

    // Both session headers appear; the foreign session expands to read-only rows.
    await waitFor(
      () => {
        expect(tree.querySelector(`[data-testid="tree-session-${activeName}"]`)).not.toBeNull();
      },
      { timeout: 5000 },
    );
    expect(tree.querySelector('[data-testid="tree-session-work"]')).not.toBeNull();
    expect(tree.querySelector('[data-testid="tree-foreign-tab-@9"]')).not.toBeNull();
    expect(tree.querySelector('[data-testid="tree-foreign-pane-%9"]')).not.toBeNull();

    // The active session still shows its LIVE tabs (from real state, not the summary).
    const liveWindowId = app().context.activeWindowId!;
    expect(tree.querySelector(`[data-testid="tree-tab-${liveWindowId}"]`)).not.toBeNull();
  },
};
