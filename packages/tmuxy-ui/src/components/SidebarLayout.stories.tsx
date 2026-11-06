/** How the column re-tiles the grid is told by real tmux in `stories/AppSidebarLayout.stories.tsx`. */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { FixtureApp } from '../stories/FixtureHarness';
import { asFixture } from '../stories/fixtures/FixtureAdapter';
import manyTabs from '../stories/fixtures/gen/sidebar-many-tabs.json';
import twoTabs from '../stories/fixtures/gen/sidebar-two-tabs.json';
import { waitForTree } from '../stories/sidebarStoryHelpers';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Sidebar Layout',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

export const TallTreeScrollsInsideTheColumn: Story = {
  tags: ['nightly'],
  // Twelve one-pane tabs, the last active, twenty rows tall; the toggle opens
  // the tree beside them.
  args: {
    fixture: asFixture(manyTabs),
    start: 'closed',
    transitions: [{ match: /^split-window\b.*@tmuxy-window-type sidebar-left$/, to: 'open' }],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Twelve tabs and their panes are more rows than a twenty-row column can show. The tree has to scroll within the column: its box stays inside the column (rather than growing past the bottom edge and being clipped away with no way to reach the rest), and walking the keyboard cursor down to the last row brings that row into view.',
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

    const rows = () => [...tree.querySelectorAll('[role="treeitem"]')] as HTMLElement[];
    await waitFor(() => expect(rows()).toHaveLength(24), { timeout: 8000 });

    const columnBox = column.getBoundingClientRect();
    expect(tree.getBoundingClientRect().bottom).toBeLessThanOrEqual(columnBox.bottom + 1);

    expect(tree.scrollHeight).toBeGreaterThan(tree.clientHeight + 1);

    // It opens on the active pane's row, the last one, so the top starts scrolled off.
    const firstRow = () => rows()[0];
    const lastRow = () => rows()[rows().length - 1];
    const openedAt = tree.scrollTop;
    expect(openedAt).toBeGreaterThan(0);
    expect(firstRow().getBoundingClientRect().top).toBeLessThan(columnBox.top);

    await user.click(tree);
    await waitFor(() => expect(tree.getAttribute('data-focused')).toBe('true'), { timeout: 5000 });
    await user.keyboard('k'.repeat(rows().length));
    await waitFor(
      () => {
        // Not necessarily to 0: the tree's top padding sits above the first
        // row, and `block: 'nearest'` stops at the row itself.
        expect(tree.scrollTop).toBeLessThan(openedAt);
        const box = firstRow().getBoundingClientRect();
        expect(box.top).toBeGreaterThanOrEqual(columnBox.top - 1);
        expect(box.bottom).toBeLessThanOrEqual(columnBox.bottom + 1);
      },
      { timeout: 6000, interval: 100 },
    );

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

/**
 * Tab from the sidebar toggle, both ways, must leave the page rather than
 * stall or circle inside one surface, stop only on visible controls, and move
 * in document order.
 */
export const TabOrderNeverTrapsTheKeyboard: Story = {
  // Tabs `one` and `two` beside the tree.
  args: { fixture: asFixture(twoTabs), start: 'open' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await waitForTree();

    const sidebar = document.querySelector('.sidebar-column-left') as HTMLElement;
    expect(sidebar).not.toBeNull();

    // Tab past the last control leaves the page in any browser; coming back in
    // is the browser's own move, which a page cannot press for. The toggle is
    // focused directly, not clicked: a clicked button hands the next Tab to
    // the shell.
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
        const box = focused.getBoundingClientRect();
        expect(box.width, `a stop with no width: ${focused.className}`).toBeGreaterThan(0);
        expect(box.height, `a stop with no height: ${focused.className}`).toBeGreaterThan(0);
        stops.push(focused);
      }
      throw new Error('Tab never left the page in 30 presses');
    };
    const stops = [...(await walk(true)).reverse(), toggle, ...(await walk(false))];

    for (let i = 1; i < stops.length; i++) {
      const follows =
        stops[i - 1].compareDocumentPosition(stops[i]) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(
        Boolean(follows),
        `${stops[i].className} is reached after ${stops[i - 1].className} but comes before it`,
      ).toBe(true);
    }

    const trace = stops.map((el) => el.className || el.tagName).join(' -> ');
    expect(
      stops.some((el) => el.closest('.tab-add') !== null),
      `the tab strip is not in the tab order: ${trace}`,
    ).toBe(true);
    expect(stops.length, `too few stops to be the whole chrome: ${trace}`).toBeGreaterThan(2);
  },
};
