/**
 * Paging an overflowing tab strip (demo engine).
 *
 * The strip scrolls sideways with its scrollbar hidden, so past a certain
 * number of tabs the ones at the end are simply unreachable without a wheel.
 * The ‹ › pair in the header pages it by exactly one strip-width at a time,
 * and the browser clamps the last page to whatever is left.
 *
 * The buttons appear only when there is somewhere to scroll to, and each is
 * disabled at its own end rather than removed — a control that vanished would
 * shuffle the "+" beside it every time you reached an edge.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { AppHarness } from './StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Tab Strip Scroll',
  component: AppHarness,
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
type Story = StoryObj<typeof AppHarness>;

/** Enough tabs, with long enough names, that the strip cannot show them all. */
const MANY_TABS = [
  'rename-window development',
  ...Array.from({ length: 11 }, (_, i) => [
    'new-window',
    `rename-window long-tab-name-${i + 1}`,
  ]).flat(),
];

function strip(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector<HTMLElement>('.tab-list');
  if (!el) throw new Error('.tab-list not found');
  return el;
}

/**
 * Click a pager until it has nothing left to do, letting each smooth scroll
 * settle first — pages fired on top of one another coalesce, the way they
 * would for a user hammering the button, and that is not what is under test.
 */
async function pageUntilDone(button: HTMLElement, list: HTMLElement): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if ((button as HTMLButtonElement).disabled) return;
    const before = list.scrollLeft;
    await userEvent.click(button);
    await waitFor(() => expect(list.scrollLeft).not.toBe(before), { timeout: 4000 });
    // Settled: two readings in a row the same.
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

// ---------------------------------------------------------------------------
// Overflowing — the pair appears and pages a screenful at a time
// ---------------------------------------------------------------------------

export const PagesAScreenfulAtATime: Story = {
  args: { height: 420, initCommands: MANY_TABS },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 420 },
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

    // The newest tab is current, and the strip keeps the current tab in view,
    // so it opens at the far end. Switch to the first tab to bring it home —
    // paging is what is under test here, not where the strip sits when it
    // opens — and let that settle before touching the pager.
    const firstId = list.querySelector<HTMLElement>('.tab-name[data-window-id]')!.dataset.windowId;
    (window as unknown as { app: { send(e: unknown): void } }).app.send({
      type: 'SELECT_TAB',
      windowId: firstId,
    });
    await waitFor(() => expect(list.scrollLeft).toBeLessThan(8), { timeout: 6000 });
    await new Promise((r) => setTimeout(r, 800));

    const left = await canvas.findByTestId('tab-scroll-left');
    const right = await canvas.findByTestId('tab-scroll-right');
    // Both are drawn, and big enough to hit.
    for (const button of [left, right]) {
      const box = button.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(10);
      expect(box.height).toBeGreaterThan(10);
    }
    // Parked at the start: nothing to the left, plenty to the right.
    expect(list.scrollLeft).toBeLessThan(8);
    expect(left).toBeDisabled();
    expect(right).toBeEnabled();

    // One page right is one strip-width, or the end, whichever comes first.
    const page = list.clientWidth;
    const max = list.scrollWidth - list.clientWidth;
    await userEvent.click(right);
    await waitFor(() => expect(list.scrollLeft).toBeGreaterThan(Math.min(page, max) - 8), {
      timeout: 4000,
    });
    expect(list.scrollLeft).toBeLessThanOrEqual(max + 1);
    await waitFor(() => expect(left).toBeEnabled());

    // Keep going: it stops at the end rather than running past it, and the
    // button for that end goes quiet.
    await pageUntilDone(right, list);
    await waitFor(
      () => {
        expect(list.scrollLeft).toBeGreaterThan(max - 8);
        expect(right).toBeDisabled();
      },
      { timeout: 6000 },
    );
    // The last tab is on screen now, which is the point of the whole thing.
    const tabs = [...list.querySelectorAll<HTMLElement>('.tab-name[data-window-id]')];
    const last = tabs[tabs.length - 1].getBoundingClientRect();
    const frame = list.getBoundingClientRect();
    expect(last.right).toBeLessThanOrEqual(frame.right + 2);
    expect(last.left).toBeGreaterThanOrEqual(frame.left - 2);

    // And back: ‹ pages the other way, all the way home.
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

// ---------------------------------------------------------------------------
// Everything fits — no buttons at all
// ---------------------------------------------------------------------------

export const NoButtonsWhenEverythingFits: Story = {
  args: { height: 420, initCommands: ['rename-window main', 'new-window', 'rename-window logs'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 420 },
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
    // The "+" is still there — the pair coming and going must not disturb it.
    expect(canvas.getByLabelText('Create new tab')).toBeInTheDocument();
  },
};

// ---------------------------------------------------------------------------
// Switching to a tab that is off the strip brings it back
// ---------------------------------------------------------------------------

export const SwitchingScrollsTheTabIntoView: Story = {
  args: { height: 420, initCommands: MANY_TABS },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 420 },
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
    const app = (window as unknown as { app: { send(e: unknown): void } }).app;

    // The newest tab is the current one, and it is the last on a strip that
    // does not fit — so the strip has already brought it into view rather
    // than leaving the tab you are looking at off the end.
    const last = tabs()[tabs().length - 1];
    const lastId = last.dataset.windowId as string;
    expect(last.classList.contains('tab-name-active'), 'newest tab is current').toBe(true);
    await waitFor(() => expect(onScreen(byId(lastId)), 'current tab in view at load').toBe(true), {
      timeout: 6000,
    });

    // Switch to the first tab, which is off the other end, without touching
    // the strip — the way ctrl+1 or prefix p does it.
    const firstId = tabs()[0].dataset.windowId as string;
    expect(onScreen(byId(firstId))).toBe(false);
    app.send({ type: 'SELECT_TAB', windowId: firstId });
    await waitFor(
      () => {
        const now = byId(firstId);
        expect(now.classList.contains('tab-name-active'), 'first tab became current').toBe(true);
        expect(onScreen(now), 'first tab scrolled into view').toBe(true);
      },
      { timeout: 6000 },
    );
    // It moved by the least amount that does it: the strip is back at its
    // start rather than having centred anything.
    expect(list.scrollLeft).toBeLessThan(20);

    // ...and back to the far end again.
    app.send({ type: 'SELECT_TAB', windowId: lastId });
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

// ---------------------------------------------------------------------------
// No ✕ on a tab
// ---------------------------------------------------------------------------

export const TabsCarryNoCloseButton: Story = {
  args: { height: 420, initCommands: ['rename-window main', 'new-window', 'rename-window logs'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 420 },
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
    // Clicking anywhere on a tab selects it; there is no sub-target to miss.
    for (const tab of list.querySelectorAll('.tab-name[data-window-id]')) {
      expect(tab.querySelector('button')).toBeNull();
    }
  },
};
