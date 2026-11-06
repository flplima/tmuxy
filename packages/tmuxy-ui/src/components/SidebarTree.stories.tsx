import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, fireEvent } from 'storybook/test';
import { FixtureApp } from '../stories/FixtureHarness';
import { asFixture } from '../stories/fixtures/FixtureAdapter';
import tabReorder from '../stories/fixtures/gen/sidebar-tab-reorder.json';
import twoTabs from '../stories/fixtures/gen/sidebar-two-tabs.json';
import treeColumn from '../stories/fixtures/gen/tree.json';
import paneState from '../stories/fixtures/gen/sidebar-pane-state.json';
import { app, tabPanes, waitForTree } from '../stories/sidebarStoryHelpers';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Sidebar Tree',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

export const DragTabRowToReorder: Story = {
  args: {
    // Tabs `one` (@0) and `two` (@1, active) beside the tree.
    fixture: asFixture(tabReorder),
    start: 'open',
    transitions: [{ match: /^move-window -b -s @1 -t @0$/, to: 'reordered' }],
    // Long enough to see the prediction before tmux's answer lands.
    commandDelayMs: 1500,
  },
  play: async () => {
    const tree = await waitForTree();

    const tabs = () => app().context.windows.filter((w) => w.windowType === 'tab');
    const firstRow = tree.querySelector('[data-testid="tree-tab-@0"]') as HTMLElement;
    const secondRow = tree.querySelector('[data-testid="tree-tab-@1"]') as HTMLElement;
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
    await waitFor(() => {
      expect(secondRow).toHaveClass('is-dragging');
      expect(firstRow).toHaveClass('is-drop-before');
    });
    expect(centre(secondRow).y).toBeLessThan(from.y - 10);

    fireEvent.pointerUp(secondRow, { ...pointer, clientX: from.x, clientY: to.y - 4 });
    fireEvent.click(secondRow, { clientX: from.x, clientY: to.y - 4 });
    // Predicted at once; the click after the drop must not select the tab.
    const rows = () =>
      [...tree.querySelectorAll('.sidebar-tree-tab[data-window-id]')].map(
        (el) => (el as HTMLElement).dataset.windowId,
      );
    await waitFor(() => {
      expect(tabs().map((w) => w.id)).toEqual(['@1', '@0']);
      expect(rows()).toEqual(['@1', '@0']);
    });
    expect(tree.querySelector('.is-dragging, .is-drop-before, .is-drop-after')).toBeNull();
    expect(app().context.activeWindowId).toBe('@1');

    // tmux's answer settles without a flip back.
    await waitFor(() => expect(tabs().find((w) => w.id === '@1')?.index).toBe(1), {
      timeout: 5000,
    });
    expect(rows()).toEqual(['@1', '@0']);
  },
};

export const TreeSitsOnTheChrome: Story = {
  // Tabs `one` and `two` (current) of two panes each beside the tree.
  args: { fixture: asFixture(twoTabs), start: 'open' },
  play: async () => {
    const tree = await waitForTree();
    const transparent = 'rgba(0, 0, 0, 0)';

    // A sidebar is chrome: the window's ground runs on behind it, only the
    // panes are dark.
    let el: HTMLElement | null = tree;
    while (el && !el.classList.contains('sidebar-column')) {
      expect(getComputedStyle(el).backgroundColor, el.className).toBe(transparent);
      el = el.parentElement;
    }
    expect(el).not.toBeNull();
    expect(getComputedStyle(el!).backgroundColor).toBe(transparent);

    // The pane with the keyboard is the one row in its colour.
    await waitFor(() => expect(tree.querySelectorAll('.sidebar-tree-pane')).toHaveLength(4));
    const color = (row: Element) => getComputedStyle(row).color;
    const activePane = tree.querySelector('.sidebar-tree-pane.is-active')!;
    const rows = [...tree.querySelectorAll('.sidebar-tree-tab, .sidebar-tree-pane')];
    expect(rows.filter((row) => color(row) === color(activePane))).toHaveLength(1);
    const currentTab = tree.querySelector('.sidebar-tree-tab.is-active')!;
    const otherTab = tree.querySelector('.sidebar-tree-tab:not(.is-active)')!;
    expect(color(currentTab)).not.toBe(color(otherTab));
    expect(getComputedStyle(currentTab).backgroundColor).not.toBe(transparent);
    expect(getComputedStyle(otherTab).backgroundColor).toBe(transparent);
  },
};

export const PaneNodesShowHeaderTitle: Story = {
  // One tab of two panes, %0 and %1, beside the tree (whose own pane is %2).
  args: { fixture: asFixture(treeColumn), start: 'open' },
  play: async () => {
    const tree = await waitForTree();

    const panes = tabPanes();
    expect(panes.map((p) => p.tmuxId).sort()).toEqual(['%0', '%1']);

    for (const p of panes) {
      const row = tree.querySelector(`[data-testid="tree-pane-${p.tmuxId}"]`) as HTMLElement;
      expect(row).not.toBeNull();
      // The id leads: it is what tells two panes running the same program apart.
      const id = row.querySelector('.sidebar-tree-id') as HTMLElement;
      const name = row.querySelector('.sidebar-tree-name') as HTMLElement;
      expect(id.textContent).toBe(p.tmuxId);
      expect(name.textContent).toBe('bash');
      expect(row.querySelector('.sidebar-tree-icon')).not.toBeNull();
      expect(row.querySelector('.sidebar-tree-branch')).not.toBeNull();
    }

    const treeWindow = app().context.windows.find((w) => w.windowType === 'sidebar-left')!;
    const treePane = app().context.panes.find((p) => p.windowId === treeWindow.id)!;
    expect(treePane.tmuxId).toBe('%2');
    expect(tree.querySelector('[data-testid="tree-pane-%2"]')).toBeNull();
  },
};

export const PaneStateIsWhatThePaneDeclares: Story = {
  args: {
    // Tab `agents` (@0) of two panes, %0 and %1, beside the tree; tmux answers
    // each declaration with the panes' states as it then holds them.
    fixture: asFixture(paneState),
    start: 'open',
    transitions: [
      { match: /^set-option -p -t %1 @tmuxy-pane-state needs-input$/, to: 'declared' },
      { match: /^set-option -p -t %1 @tmuxy-pane-state error$/, to: 'failed' },
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'tmuxy never infers what a pane is doing: the pane says so itself by setting `@tmuxy-pane-state`, which is what `tmuxy pane state <value>` does from inside it — an agent hook, a shell precmd/preexec pair, or a build script on failure. Here the option is set through the same tmux command that CLI issues. A tab rolls its panes up to the most attention-worthy of them, so a tab holding a blocked pane reads as needs-input even when another pane is merely working.',
      },
    },
  },
  play: async () => {
    const tree = await waitForTree();
    const windowId = '@0';
    const [busy, blocked] = ['%0', '%1'];

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

    const tabRow = tree.querySelector(`[data-testid="tree-tab-${windowId}"]`) as HTMLElement;
    expect(tabRow.querySelector('.sidebar-tree-state.is-needs-input')).not.toBeNull();

    // Nerd Font glyphs: U+F071 warning triangle, U+F057 circled x.
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
