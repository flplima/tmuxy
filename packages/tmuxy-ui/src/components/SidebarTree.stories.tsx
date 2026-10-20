/**
 * Sidebar tree structure, drag-and-drop, and pane state stories (demo engine).
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor, fireEvent } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';
import { app, tabPanes, waitForTree } from '../stories/sidebarStoryHelpers';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Sidebar Tree',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

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
    const transparent = 'rgba(0, 0, 0, 0)';

    // Docked beside the grid, from the tree up to and including the column
    // every element is see-through: a sidebar is chrome, so the window's
    // ground runs on behind it and only the panes are dark.
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
