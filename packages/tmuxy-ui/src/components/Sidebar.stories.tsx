/**
 * Sidebar stories, over states recorded from real tmux, through the user's
 * chain: TOGGLE_SIDEBAR left (the header button) opens the column, and a click
 * on a node activates it through the same events the rest of the UI uses.
 *
 * Context menus are floating surfaces portalled out of the tree, so menu queries
 * run against `document`, not `canvasElement`.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { FixtureApp } from '../stories/FixtureHarness';
import { asFixture, adapterHolder } from '../stories/fixtures/FixtureAdapter';
import twoTabs from '../stories/fixtures/gen/sidebar-two-tabs.json';
import bothColumns from '../stories/fixtures/gen/sidebar-both-columns.json';
import treeColumn from '../stories/fixtures/gen/tree.json';
import { tabPanes, waitForTree, rightClick, menuLabels } from '../stories/sidebarStoryHelpers';
import { appContext } from '../stories/storyApp';
import { stripTabs } from '../domain/windows';

const OPEN_TREE = /^split-window\b.*@tmuxy-window-type sidebar-left$/;
const OPEN_DOCK = /^split-window\b.*@tmuxy-window-type sidebar-right$/;

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Sidebar',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

const held = adapterHolder();
export const ClickTabAndPaneActivate: Story = {
  args: {
    // Tabs `one` (@0: %0, %1) and `two` (@1: %2, %3), `two` active; the tree's
    // window is @2.
    fixture: asFixture(twoTabs),
    start: 'closed',
    transitions: [
      { match: OPEN_TREE, to: 'open' },
      { match: /^select-window -t @0$/, to: 'one-active' },
      { match: /^select-pane -t %0$/, to: 'pane-picked' },
      { match: /^set-option -w -t @2 @tmuxy-sidebar-hidden 1$/, to: 'hidden' },
    ],
    onAdapterReady: held.keep,
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

    await waitFor(() => {
      for (const w of stripTabs(appContext().windows)) {
        expect(tree.querySelector(`[data-testid="tree-tab-${w.id}"]`)).not.toBeNull();
      }
      for (const p of tabPanes()) {
        expect(tree.querySelector(`[data-testid="tree-pane-${p.tmuxId}"]`)).not.toBeNull();
      }
    });
    expect(tree.textContent).toContain('one');
    expect(tree.textContent).toContain('two');
    const content = document.querySelector('[data-testid="sidebar-content"]') as HTMLElement;
    await waitFor(() => {
      const rect = content.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(50);
      expect(rect.height).toBeGreaterThan(50);
    });

    await userEvent.click(tree.querySelector('[data-testid="tree-tab-@0"]') as HTMLElement);
    await waitFor(() => expect(appContext().activeWindowId).toBe('@0'), { timeout: 5000 });
    // A click picks a target; the keyboard goes to the tab, not into the tree.
    expect(tree.getAttribute('data-focused')).toBe('false');

    // %1 is the tab's active pane.
    await userEvent.click(tree.querySelector('[data-testid="tree-pane-%0"]') as HTMLElement);
    await waitFor(() => expect(appContext().activePaneId).toBe('%0'), { timeout: 5000 });
    expect(tree.getAttribute('data-focused')).toBe('false');

    // `j` and `k` are tree keys, so a tree still holding the keyboard would eat them.
    const sentBefore = held.adapter!.commands.length;
    await userEvent.setup({ delay: 5 }).keyboard('jk-typed');
    await waitFor(() => {
      const keys = held
        .adapter!.commands.slice(sentBefore)
        .filter((c) => c.startsWith('send-keys '));
      expect(keys.length).toBeGreaterThan(0);
      for (const c of keys) expect(c).toMatch(/^send-keys -t %0 /);
      const typed = keys.map((c) => /-l -- '(.*)'$/.exec(c)?.[1] ?? '').join('');
      expect(typed).toBe('jk-typed');
    });

    await userEvent.click(toggle);
    await waitFor(() => expect(document.querySelector('.sidebar-tree')).toBeNull(), {
      timeout: 5000,
    });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  },
};

export const RightClickContextMenus: Story = {
  args: { fixture: asFixture(twoTabs), start: 'open', onAdapterReady: held.keep },
  play: async () => {
    const tree = await waitForTree();
    await waitFor(
      () => {
        for (const id of ['%0', '%1', '%2', '%3']) {
          expect(tree.querySelector(`[data-testid="tree-pane-${id}"]`)).not.toBeNull();
        }
      },
      { timeout: 8000 },
    );

    rightClick(tree.querySelector('[data-testid="tree-pane-%0"]') as HTMLElement);
    await waitFor(() => expect(menuLabels().some((t) => t.includes('Clear Screen'))).toBe(true), {
      timeout: 5000,
    });
    expect(menuLabels().some((t) => t.includes('Close Pane'))).toBe(true);
    const clearItem = [...document.querySelectorAll('[role="menuitem"]')].find((n) =>
      (n.textContent ?? '').includes('Clear Screen'),
    ) as HTMLElement;
    await userEvent.click(clearItem);
    await waitFor(() => expect(document.querySelector('[role="menuitem"]')).toBeNull(), {
      timeout: 5000,
    });
    expect(held.adapter!.commands.some((c) => c.includes('clear-history'))).toBe(true);

    rightClick(tree.querySelector('[data-testid="tree-tab-@1"]') as HTMLElement);
    await waitFor(() => expect(menuLabels().some((t) => t.includes('New Tab'))).toBe(true), {
      timeout: 5000,
    });
    expect(menuLabels().some((t) => t.includes('Close Tab'))).toBe(true);

    const closeTab = [...document.querySelectorAll('[role="menuitem"]')].find((n) =>
      (n.textContent ?? '').includes('Close Tab'),
    ) as HTMLElement;
    await userEvent.click(closeTab);
    await waitFor(() => expect(document.querySelector('[role="menuitem"]')).toBeNull(), {
      timeout: 5000,
    });
    expect(held.adapter!.commands.some((c) => /^kill-window\b/.test(c))).toBe(true);
  },
};

export const TabsCollapseToHideTheirPanes: Story = {
  // One tab (@0) of two panes, %0 and %1, beside the tree.
  args: { fixture: asFixture(treeColumn), start: 'open' },
  play: async () => {
    const user = userEvent.setup({ delay: 5 });
    const tree = await waitForTree();

    const windowId = '@0';
    const paneIds = ['%0', '%1'];
    const paneRow = (id: string) =>
      tree.querySelector(`[data-testid="tree-pane-${id}"]`) as HTMLElement | null;
    const treeBox = () => tree.getBoundingClientRect();
    // Drawn, as the user sees it: the row's height left inside the group that
    // folds it, and reachable (a folded group is inert).
    const shownHeight = (id: string) => {
      const row = paneRow(id);
      const group = row?.closest<HTMLElement>('.sidebar-tree-children');
      if (!row || !group || group.inert) return 0;
      const r = row.getBoundingClientRect();
      const g = group.getBoundingClientRect();
      return Math.max(0, Math.min(r.bottom, g.bottom) - Math.max(r.top, g.top));
    };

    for (const id of paneIds) {
      const row = paneRow(id);
      expect(row).not.toBeNull();
      const box = row!.getBoundingClientRect();
      expect(shownHeight(id)).toBeGreaterThan(0);
      expect(box.top).toBeGreaterThanOrEqual(treeBox().top - 1);
    }

    // The chevron folds; the row itself selects the tab.
    const chevron = tree.querySelector(`[data-testid="tree-chevron-${windowId}"]`) as HTMLElement;
    expect(chevron).not.toBeNull();
    await user.click(chevron);

    await waitFor(
      () => {
        for (const id of paneIds) expect(shownHeight(id)).toBe(0);
      },
      { timeout: 5000 },
    );

    const tabRow = tree.querySelector(`[data-testid="tree-tab-${windowId}"]`) as HTMLElement;
    expect(tabRow.getAttribute('data-collapsed')).toBe('true');
    expect(tabRow.getAttribute('aria-expanded')).toBe('false');
    const count = tabRow.querySelector('.sidebar-tree-count') as HTMLElement;
    expect(count.textContent).toBe(String(paneIds.length));
    const countBox = count.getBoundingClientRect();
    expect(countBox.width).toBeGreaterThan(0);
    expect(countBox.right).toBeLessThanOrEqual(treeBox().right + 1);

    await user.click(chevron);
    await waitFor(
      () => {
        for (const id of paneIds) {
          expect(shownHeight(id)).toBeCloseTo(paneRow(id)!.getBoundingClientRect().height, 0);
        }
      },
      { timeout: 5000 },
    );
    expect(tabRow.getAttribute('aria-expanded')).toBe('true');
  },
};

export const TogglesKeepTheirPlace: Story = {
  args: {
    // The tree's window is @1, the dock's @2.
    fixture: asFixture(bothColumns),
    start: 'closed',
    transitions: [
      { match: OPEN_TREE, to: 'left-open' },
      { match: OPEN_DOCK, to: 'both-open' },
      { match: /^set-option -w -t @1 @tmuxy-sidebar-hidden 1$/, to: 'right-open' },
      { match: /^set-option -w -t @2 @tmuxy-sidebar-hidden 1$/, to: 'both-hidden' },
    ],
  },
  play: async ({ canvasElement }) => {
    // The click that opens a column must close it from the same spot.
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

// Chrome an embedder adds around the header (the demo's traffic lights) must
// not push either cluster's divider off its column's edge.
export const DividersLineUpUnderEmbedderChrome: Story = {
  args: {
    fixture: asFixture(bothColumns),
    start: 'closed',
    transitions: [
      { match: OPEN_TREE, to: 'left-open' },
      { match: OPEN_DOCK, to: 'both-open' },
    ],
    renderTabline: ({ children }) => (
      <>
        <span style={{ width: 60, flexShrink: 0 }} data-testid="lead" />
        {children}
        <span style={{ width: 40, flexShrink: 0 }} data-testid="trail" />
      </>
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane/i }, { timeout: 8000 });
    await userEvent.click(await canvas.findByRole('button', { name: /toggle tree sidebar/i }));
    await userEvent.click(await canvas.findByRole('button', { name: /toggle terminal sidebar/i }));
    const edge = (selector: string, side: 'left' | 'right') => {
      const el = canvasElement.querySelector(selector);
      return el ? Math.round(el.getBoundingClientRect()[side]) : null;
    };
    await waitFor(
      () => {
        expect(edge('.sidebar-column-left', 'right')).not.toBeNull();
        expect(edge('.statusbar-cluster-left.is-docked', 'right')).toBe(
          edge('.sidebar-column-left', 'right'),
        );
        expect(edge('.sidebar-column-right', 'left')).not.toBeNull();
        expect(edge('.statusbar-cluster-right.is-docked', 'left')).toBe(
          edge('.sidebar-column-right', 'left'),
        );
      },
      { timeout: 8000 },
    );
  },
};
