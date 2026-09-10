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

    const left = await canvas.findByTestId('tab-scroll-left');
    const right = await canvas.findByTestId('tab-scroll-right');
    // Both are drawn, and big enough to hit.
    for (const button of [left, right]) {
      const box = button.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(10);
      expect(box.height).toBeGreaterThan(10);
    }
    // Parked at the start: nothing to the left, plenty to the right.
    expect(list.scrollLeft).toBe(0);
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
