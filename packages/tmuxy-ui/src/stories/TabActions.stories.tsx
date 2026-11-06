/**
 * Tab actions from the keyboard and the tab strip's context menu, over states
 * recorded from real tmux (`fixtures/scenarios/tab-actions.ts`).
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture, type FixtureAdapter } from './fixtures/FixtureAdapter';
import tabActions from './fixtures/gen/tab-actions.json';
import {
  activePaneId,
  activeWindow,
  paneGroups,
  windowTabEls,
  windows,
  type Canvas,
} from './appStoryHelpers';

const meta: Meta<typeof FixtureApp> = {
  title: 'Scenarios/Tab Actions',
  component: FixtureApp,
  args: { fixture: asFixture(tabActions), start: 'one-tab' },
  render: (args) => <FixtureApp {...args} onAdapterReady={keepAdapter} />,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

let adapter: FixtureAdapter | null = null;
function keepAdapter(a: FixtureAdapter) {
  adapter = a;
}
const sent = () => `sent: ${JSON.stringify(adapter?.commands ?? [])}`;

async function waitForTabs(canvas: Canvas, count: number) {
  await waitFor(
    () => {
      expect(windowTabEls(canvas).length).toBe(count);
      expect(paneGroups(canvas).length).toBeGreaterThan(0);
    },
    { timeout: 10000 },
  );
  const pane = paneGroups(canvas)[0];
  await userEvent.click(pane);
  await waitFor(() => expect(activePaneId()).toBe(pane.getAttribute('data-pane-id')), {
    timeout: 10000,
  });
}

/**
 * The tmuxy config binds C-Tab to `next-window` and C-S-Tab to
 * `previous-window`; tmux wraps at either end.
 */
export const TabNextPrev: Story = {
  args: {
    start: 'second-active',
    transitions: [
      { match: /^next-window$/, to: 'first-active' },
      { match: /^previous-window$/, to: 'second-active' },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitForTabs(canvas, 2);
    expect(activeWindow()?.id).toBe('@2');
    await user.keyboard('{Control>}{Tab}{/Control}');
    await waitFor(() => expect(activeWindow()?.id, sent()).toBe('@0'), { timeout: 10000 });
    await user.keyboard('{Control>}{Shift>}{Tab}{/Shift}{/Control}');
    await waitFor(() => expect(activeWindow()?.id, sent()).toBe('@2'), { timeout: 10000 });
  },
};

function contextMenu(tab: HTMLElement) {
  const r = tab.getBoundingClientRect();
  tab.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    }),
  );
}

export const TabContextMenuOps: Story = {
  args: {
    transitions: [
      { match: /^new-window$/, to: 'two-tabs' },
      { match: /^kill-window -t @1\b/, to: 'closed' },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitForTabs(canvas, 1);

    contextMenu(windowTabEls(canvas)[0]);
    await user.click(await canvas.findByText('New Tab', undefined, { timeout: 5000 }));
    await waitFor(
      () => {
        expect(windowTabEls(canvas).length, sent()).toBe(2);
        expect(activeWindow()?.id).toBe('@1');
      },
      { timeout: 10000 },
    );

    const tabs = windowTabEls(canvas);
    contextMenu(tabs[tabs.length - 1]);
    await user.click(await canvas.findByText('Close Tab', undefined, { timeout: 5000 }));
    await waitFor(
      () => {
        expect(windowTabEls(canvas).length, sent()).toBe(1);
        expect(windows().some((w) => w.id === '@1')).toBe(false);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 10000 },
    );
  },
};

/** How long tmux takes to answer the kill: longer than the drop may take. */
const KILL_ANSWER_MS = 1500;

/**
 * "Close Tab" on the current tab drops it within 1.2s, before tmux (slowed to
 * {@link KILL_ANSWER_MS}) answers, and the answer never brings it back. The
 * menu is the path that kills at once: tmuxy's config binds C-a `&` to
 * `confirm-before … kill-window`, which asks for a y/n first.
 */
export const TabKillOptimistic: Story = {
  args: {
    start: 'two-tabs',
    commandDelayMs: KILL_ANSWER_MS,
    transitions: [{ match: /^kill-window -t @1\b/, to: 'closed' }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitForTabs(canvas, 2);
    expect(activeWindow()?.id).toBe('@1');

    const tabs = windowTabEls(canvas);
    contextMenu(tabs[tabs.length - 1]);
    const closeTab = await canvas.findByText('Close Tab', undefined, { timeout: 5000 });
    const pressed = performance.now();
    await user.click(closeTab);
    await waitFor(() => expect(windowTabEls(canvas).length, sent()).toBe(1), {
      timeout: 5000,
      interval: 50,
    });
    expect(performance.now() - pressed).toBeLessThan(1200);

    await new Promise((r) => setTimeout(r, KILL_ANSWER_MS + 500));
    expect(windowTabEls(canvas).length).toBe(1);
    expect(windows().every((w) => w.id !== '@1')).toBe(true);
    expect(activeWindow()?.id).toBe('@0');
    expect(activePaneId()).toMatch(/^%\d+$/);
  },
};
