/**
 * Paging an overflowing tab strip, over recordings of real tmux. The strip
 * hides its scrollbar, so without the ‹ › pair the tabs at the end are
 * unreachable without a wheel. Each button is disabled at its own end rather
 * than removed: a control that vanished would shuffle the "+" beside it.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import manyTabs from './fixtures/gen/many-tabs.json';
import tabs from './fixtures/gen/tabs.json';
import { storyApp } from './storyApp';
import type { WindowId } from '../domain/ids';

/** Twelve long-named tabs, more than the strip shows, the last current. */
const MANY_TABS = {
  fixture: asFixture(manyTabs),
  start: 'last-active',
  transitions: [
    { match: /^select-window -t @0$/, to: 'first-active' },
    { match: /^select-window -t @11$/, to: 'last-active' },
  ],
};
const TWO_TABS = { fixture: asFixture(tabs), start: 'logs-active' };

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Tab Strip Scroll',
  component: FixtureApp,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The header’s ‹ › buttons page the tab strip a screenful at a time, and only exist while there is something to page to.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

function strip(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector<HTMLElement>('.tab-list');
  if (!el) throw new Error('.tab-list not found');
  return el;
}

/**
 * Clicks a pager until it has nothing left to do, letting each smooth scroll
 * settle first: pages fired on top of one another coalesce, and that is not
 * what is under test.
 */
async function pageUntilDone(button: HTMLElement, list: HTMLElement): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if ((button as HTMLButtonElement).disabled) return;
    const before = list.scrollLeft;
    await userEvent.click(button);
    await waitFor(() => expect(list.scrollLeft).not.toBe(before), { timeout: 4000 });
    let last = -1;
    await waitFor(
      () => {
        const now = list.scrollLeft;
        const stable = now === last;
        last = now;
        expect(stable).toBe(true);
      },
      { timeout: 4000 },
    );
  }
}

export const PagesAScreenfulAtATime: Story = {
  tags: ['nightly'],
  args: MANY_TABS,
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Twelve tabs with long names overflow the strip. Both buttons appear; the left one starts disabled because there is nothing behind the first tab. Clicking ‹ › moves the strip by its own width, and the last page stops at the end instead of overshooting — at which point the right button is the disabled one.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });

    const list = strip(canvasElement);
    await waitFor(() => expect(list.scrollWidth).toBeGreaterThan(list.clientWidth + 20), {
      timeout: 8000,
    });

    // The strip keeps the current (newest) tab in view, so it opens at the far
    // end; bring it home first, since paging is what is under test.
    const firstId = list.querySelector<HTMLElement>('.tab-name[data-window-id]')!.dataset.windowId;
    storyApp().send({ type: 'SELECT_TAB', windowId: firstId as WindowId });
    await waitFor(() => expect(list.scrollLeft).toBeLessThan(8), { timeout: 6000 });
    await new Promise((r) => setTimeout(r, 800));

    const left = await canvas.findByTestId('tab-scroll-left');
    const right = await canvas.findByTestId('tab-scroll-right');
    for (const button of [left, right]) {
      const box = button.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(10);
      expect(box.height).toBeGreaterThan(10);
    }
    expect(list.scrollLeft).toBeLessThan(8);
    expect(left).toBeDisabled();
    expect(right).toBeEnabled();

    // The browser clamps the last page to whatever is left.
    const page = list.clientWidth;
    const max = list.scrollWidth - list.clientWidth;
    await userEvent.click(right);
    await waitFor(() => expect(list.scrollLeft).toBeGreaterThan(Math.min(page, max) - 8), {
      timeout: 4000,
    });
    expect(list.scrollLeft).toBeLessThanOrEqual(max + 1);
    await waitFor(() => expect(left).toBeEnabled());

    await pageUntilDone(right, list);
    await waitFor(
      () => {
        expect(list.scrollLeft).toBeGreaterThan(max - 8);
        expect(right).toBeDisabled();
      },
      { timeout: 6000 },
    );
    const tabs = [...list.querySelectorAll<HTMLElement>('.tab-name[data-window-id]')];
    const last = tabs[tabs.length - 1].getBoundingClientRect();
    const frame = list.getBoundingClientRect();
    expect(last.right).toBeLessThanOrEqual(frame.right + 2);
    expect(last.left).toBeGreaterThanOrEqual(frame.left - 2);

    await pageUntilDone(left, list);
    await waitFor(
      () => {
        expect(list.scrollLeft).toBeLessThan(8);
        expect(left).toBeDisabled();
      },
      { timeout: 6000 },
    );
  },
};

export const NoButtonsWhenEverythingFits: Story = {
  args: TWO_TABS,
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Two tabs leave the strip with room to spare, so there is nothing to page to and neither button is rendered — the header keeps just the "+" and the grid toggle.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });
    const list = strip(canvasElement);
    await waitFor(() => expect(list.querySelectorAll('.tab-name[data-window-id]').length).toBe(2));
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth + 1);

    expect(canvasElement.querySelector('[data-testid="tab-scroll-left"]')).toBeNull();
    expect(canvasElement.querySelector('[data-testid="tab-scroll-right"]')).toBeNull();
    expect(canvas.getByLabelText('Create new tab')).toBeInTheDocument();
  },
};

export const SwitchingScrollsTheTabIntoView: Story = {
  args: MANY_TABS,
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Switching by keyboard can land on a tab that is scrolled off the strip, which would leave the tab you are now looking at as the one you cannot see. The strip scrolls it back into view by the least amount that does it, so the tabs either side of it stay where they were.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });

    const list = strip(canvasElement);
    await waitFor(() => expect(list.scrollWidth).toBeGreaterThan(list.clientWidth + 20), {
      timeout: 8000,
    });

    const tabs = () => [...list.querySelectorAll<HTMLElement>('.tab-name[data-window-id]')];
    const onScreen = (tab: HTMLElement) => {
      const box = tab.getBoundingClientRect();
      const frame = list.getBoundingClientRect();
      return box.left >= frame.left - 1 && box.right <= frame.right + 1;
    };
    const byId = (id: string) => tabs().find((t) => t.dataset.windowId === id)!;
    const app = storyApp();

    const last = tabs()[tabs().length - 1];
    const lastId = last.dataset.windowId as string;
    expect(last.classList.contains('tab-name-active'), 'newest tab is current').toBe(true);
    await waitFor(() => expect(onScreen(byId(lastId)), 'current tab in view at load').toBe(true), {
      timeout: 6000,
    });

    // Without touching the strip, the way ctrl+1 or prefix p does it.
    const firstId = tabs()[0].dataset.windowId as string;
    expect(onScreen(byId(firstId))).toBe(false);
    app.send({ type: 'SELECT_TAB', windowId: firstId as WindowId });
    await waitFor(
      () => {
        const now = byId(firstId);
        expect(now.classList.contains('tab-name-active'), 'first tab became current').toBe(true);
        expect(onScreen(now), 'first tab scrolled into view').toBe(true);
      },
      { timeout: 6000 },
    );
    // By the least amount that does it: back at its start, nothing centred.
    expect(list.scrollLeft).toBeLessThan(20);

    app.send({ type: 'SELECT_TAB', windowId: lastId as WindowId });
    await waitFor(
      () => {
        const now = byId(lastId);
        expect(now.classList.contains('tab-name-active'), 'last tab became current again').toBe(
          true,
        );
        expect(onScreen(now), 'last tab scrolled back into view').toBe(true);
      },
      { timeout: 6000 },
    );
  },
};

export const TabsCarryNoCloseButton: Story = {
  args: TWO_TABS,
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'A row of buttons each with a target you can hit by accident is a row you cannot click confidently, so no tab carries a ✕. Closing has three unhurried homes instead: the tab’s context menu, its card in the all-tabs view, and the hover preview.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });
    const list = strip(canvasElement);
    await waitFor(() => expect(list.querySelectorAll('.tab-name[data-window-id]').length).toBe(2));

    expect(list.querySelector('.tab-close')).toBeNull();
    expect(canvas.queryByLabelText(/^Close tab/)).toBeNull();
    for (const tab of list.querySelectorAll('.tab-name[data-window-id]')) {
      expect(tab.querySelector('button')).toBeNull();
    }
  },
};
