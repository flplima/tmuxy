/**
 * Sidebar stories (demo engine).
 *
 * The left sidebar is now a native React tab/pane tree (`SidebarTree`) rendered
 * in a fixed-width, full-height column that flexes the pane area — no tmux
 * window/pane. The tree is derived from the demo's
 * `context.windows`/`context.panes`, so these stories exercise the real user
 * chain: TOGGLE_LEFT_SIDEBAR (button or `prefix s`) → column opens → tree lists every
 * tab and its panes → clicking / keyboard-navigating a node activates it through
 * the same events the rest of the UI uses.
 *
 * Context menus are floating surfaces portalled out of the tree, so menu queries
 * run against `document`, not `canvasElement`.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';
import { app, tabPanes, waitForTree, rightClick, menuLabels } from '../stories/sidebarStoryHelpers';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Sidebar',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

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
// `prefix s` opens the sidebar docked beside the grid, and closes it again
// ---------------------------------------------------------------------------

export const OpenViaPrefixS: Story = {
  args: { height: 500, initCommands: ['rename-window editor'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    const user = userEvent.setup({ delay: 5 });
    const prefix = () => user.keyboard('{Control>}a{/Control}');
    const column = () => document.querySelector('.sidebar-column-left') as HTMLElement | null;
    // Docked, the grid starts where the column ends.
    const gridBesideColumn = () => {
      const pane = canvasElement.querySelector('.pane-layout-item')!.getBoundingClientRect();
      return pane.left >= column()!.getBoundingClientRect().right - 1;
    };

    // The column opens docked at once, and the grid reflows beside it.
    await prefix();
    await user.keyboard('s');
    await waitForTree();
    await waitFor(() => expect(gridBesideColumn()).toBe(true), { timeout: 5000 });

    // `prefix s` again closes it, at once too.
    await prefix();
    await user.keyboard('s');
    await waitFor(() => expect(column()).toBeNull(), { timeout: 5000 });
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
    // A click picks a target, it does not move into the tree: the keyboard
    // goes to the tab, not to the column the row sits in.
    expect(tree.getAttribute('data-focused')).toBe('false');
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
    expect(tree.getAttribute('data-focused')).toBe('false');

    // And what is typed next lands in that pane — `j` and `k` are tree keys,
    // so a tree still holding the keyboard would eat them.
    await userEvent.setup({ delay: 5 }).keyboard('echo jk-typed');
    await waitFor(
      () =>
        expect(
          document.querySelector(`.pane-wrapper[data-pane-id="${target.tmuxId}"]`)?.textContent,
        ).toContain('echo jk-typed'),
      { timeout: 5000 },
    );
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
// Right-clicking a pane / tab node opens the same context menu the header uses
// ---------------------------------------------------------------------------

export const RightClickContextMenus: Story = {
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
    await waitFor(
      () => {
        const tabs = app().context.windows.filter((win) => win.windowType === 'tab');
        expect(tabs.length).toBeGreaterThanOrEqual(2);
        for (const w of tabs) {
          expect(tree.querySelector(`[data-testid="tree-tab-${w.id}"]`)).not.toBeNull();
        }
        const panes = tabPanes();
        expect(panes.length).toBeGreaterThanOrEqual(2);
        for (const pane of panes) {
          expect(tree.querySelector(`[data-testid="tree-pane-${pane.tmuxId}"]`)).not.toBeNull();
        }
      },
      { timeout: 8000 },
    );

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

export const TogglesKeepTheirPlace: Story = {
  args: { height: 500 },
  play: async ({ canvasElement }) => {
    // The click that opens a column must close it from the same spot: the
    // tree's toggle stays at the header's left end and the dock's at its
    // right end, whether the columns are open or closed.
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane/i }, { timeout: 8000 });
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
