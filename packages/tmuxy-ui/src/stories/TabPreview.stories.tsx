/**
 * The picture of a tab that appears when you rest on its button (demo engine).
 *
 * Chrome-style, and for the same reason: a strip of names does not tell you
 * which tab has the thing you are after, and switching to find out costs you
 * the tab you were on.
 *
 * The behaviour worth pinning down is the browsing: the FIRST preview waits a
 * second, so a pointer crossing the strip shows nothing, but once one is up,
 * moving along the strip slides the SAME card to the next button and swaps its
 * picture at once. These stories check that it is literally the same DOM node
 * that moves — a card that unmounted and remounted would look almost the same
 * in a screenshot and be completely wrong to use.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { AppHarness } from './StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Tab Preview',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Resting on a tab shows a picture of it after a second; moving along the strip then slides that same card from tab to tab.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

interface Snap {
  context: {
    activeWindowId: string | null;
  };
}

const THREE_TABS = [
  'rename-window alpha',
  'new-window',
  'rename-window bravo',
  'new-window',
  'rename-window charlie',
];

function tabButton(canvasElement: HTMLElement, name: string): HTMLElement {
  const el = [...canvasElement.querySelectorAll<HTMLElement>('.tab-name[data-window-id]')].find(
    (t) => t.textContent?.includes(name),
  );
  if (!el) throw new Error(`no tab button for ${name}`);
  return el;
}

/** The preview card, wherever it has been portalled to. */
function preview(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="tab-preview"]');
}

async function waitForPreview(windowId?: string): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = preview();
      expect(el, 'no preview card').not.toBeNull();
      if (windowId) expect(el!.dataset.windowId).toBe(windowId);
      return el!;
    },
    { timeout: 5000 },
  );
}

// ---------------------------------------------------------------------------
// Resting opens it; moving along the strip carries the same card
// ---------------------------------------------------------------------------

export const RestOpensItAndBrowsingCarriesIt: Story = {
  args: { height: 460, initCommands: THREE_TABS },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 460 },
      description: {
        story:
          'Resting on a tab opens a card under it with that tab’s panes drawn to scale. Moving to the next tab does not open a second card: the same node moves, its picture swaps to the new tab, and it does so at once rather than waiting the second again. Node identity is asserted directly, and the card is checked to be on screen and roughly under the button it belongs to.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('.tab-name[data-window-id]').length).toBe(3),
    );

    const alpha = tabButton(canvasElement, 'alpha');
    const bravo = tabButton(canvasElement, 'bravo');

    // Nothing yet — the pointer has not been anywhere.
    expect(preview()).toBeNull();

    await userEvent.hover(alpha);
    const card = await waitForPreview(alpha.dataset.windowId);

    // It is drawn, under the tab it belongs to, and inside the window.
    const box = card.getBoundingClientRect();
    const tab = alpha.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(60);
    expect(box.top).toBeGreaterThanOrEqual(tab.bottom - 1);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    // It shows that tab's screen rather than a wireframe of it, and names
    // each pane the way that pane's own header does.
    await waitFor(() => expect(card.querySelector('.tab-overview-shot')).not.toBeNull());
    expect(card.querySelectorAll('.tab-shot-title').length).toBeGreaterThan(0);

    // The tab it belongs to stays lit while its card is up, so the card is
    // visibly about that tab.
    expect(alpha).toHaveClass('is-previewing');

    // Move along the strip: the SAME node follows, showing the next tab.
    await userEvent.hover(bravo);
    await waitFor(() => expect(preview()?.dataset.windowId).toBe(bravo.dataset.windowId), {
      timeout: 1000,
    });
    expect(preview(), 'a new card was created instead of moving the old one').toBe(card);
    // The lit tab moves along with it.
    expect(bravo).toHaveClass('is-previewing');
    expect(alpha).not.toHaveClass('is-previewing');
    await waitFor(() => {
      const moved = card.getBoundingClientRect();
      const target = bravo.getBoundingClientRect();
      // Centred on its new button, give or take the viewport clamp.
      expect(
        Math.abs(moved.left + moved.width / 2 - (target.left + target.width / 2)),
      ).toBeLessThan(moved.width);
    });
  },
};

// ---------------------------------------------------------------------------
// Leaving the strip ends it, and the next one waits again
// ---------------------------------------------------------------------------

export const LeavingTheStripEndsIt: Story = {
  args: { height: 460, initCommands: THREE_TABS },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 460 },
      description: {
        story:
          'The card follows the pointer only within the strip. Moving off it puts the card away, and pressing a tab puts it away too — an action on a tab should not be watched through a picture of it.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('.tab-name[data-window-id]').length).toBe(3),
    );

    const alpha = tabButton(canvasElement, 'alpha');
    await userEvent.hover(alpha);
    await waitForPreview();

    // Off the strip entirely: the card goes.
    const pane = canvasElement.querySelector<HTMLElement>('.pane-layout-item');
    await userEvent.unhover(alpha);
    if (pane) await userEvent.hover(pane);
    await waitFor(() => expect(preview()).toBeNull(), { timeout: 3000 });

    // Pressing a tab dismisses it as well.
    await userEvent.hover(alpha);
    await waitForPreview();
    await userEvent.click(alpha);
    await waitFor(() => expect(preview()).toBeNull(), { timeout: 3000 });
  },
};

// ---------------------------------------------------------------------------
// The card takes the pointer, and closes the tab from its own corner
// ---------------------------------------------------------------------------

export const TheCardCanBeReachedAndClosesTheTab: Story = {
  args: { height: 460, initCommands: THREE_TABS },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 460 },
      description: {
        story:
          'Moving onto the card does not dismiss it — reaching for a control must not be what takes it away — and the ✕ in its corner closes the tab it is showing. The card sits below the strip, so the pointer has a gap to cross on the way; a short grace period covers the crossing.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('.tab-name[data-window-id]').length).toBe(3),
    );

    const bravo = tabButton(canvasElement, 'bravo');
    const doomed = bravo.dataset.windowId as string;
    await userEvent.hover(bravo);
    const card = await waitForPreview(doomed);

    // Room to breathe: the frame is not pressed against the card's edge.
    const style = getComputedStyle(card);
    expect(parseFloat(style.paddingTop)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(style.paddingLeft)).toBeGreaterThanOrEqual(8);

    // Leave the tab for the card: it stays, because the card takes the pointer.
    await userEvent.unhover(bravo);
    await userEvent.hover(card);
    await new Promise((r) => setTimeout(r, 600));
    expect(preview(), 'the card went away as the pointer reached it').not.toBeNull();

    // Its ✕ sits in the card's padding above the picture, not over it.
    const close = canvasElement.ownerDocument.querySelector<HTMLElement>(
      '[data-testid="tab-preview-close"]',
    );
    expect(close).not.toBeNull();
    const closeBox = close!.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const frameBox = card.querySelector('.tab-preview-frame')!.getBoundingClientRect();
    expect(closeBox.right).toBeLessThanOrEqual(cardBox.right + 1);
    expect(closeBox.top).toBeGreaterThanOrEqual(cardBox.top - 1);
    expect(closeBox.bottom, 'the ✕ overlaps the picture').toBeLessThanOrEqual(frameBox.top + 1);

    await userEvent.click(close!);
    await waitFor(
      () =>
        expect(
          [...canvasElement.querySelectorAll<HTMLElement>('.tab-name[data-window-id]')].map(
            (t) => t.dataset.windowId,
          ),
        ).not.toContain(doomed),
      { timeout: 6000 },
    );
  },
};

// ---------------------------------------------------------------------------
// It fades and slides, both ways, unless the config says not to
// ---------------------------------------------------------------------------

export const ItFadesAndSlidesBothWays: Story = {
  args: { height: 460, initCommands: THREE_TABS },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 460 },
      description: {
        story:
          'The card fades in with a short slide down from the strip it belongs to, and leaves the same way rather than blinking out — sampled per paint, so a declared animation that never runs would fail. With `@tmuxy-animations off` it simply appears and simply goes.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('.tab-name[data-window-id]').length).toBe(3),
    );
    const alpha = tabButton(canvasElement, 'alpha');
    const pane = canvasElement.querySelector<HTMLElement>('.pane-layout-item');

    /** Sample the card's painted opacity while `act` runs. */
    const sample = async (act: () => void, ms: number) => {
      const seen: number[] = [];
      let sampling = true;
      const frame = () => {
        const el = preview();
        if (el) seen.push(Number(getComputedStyle(el).opacity));
        if (sampling) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      act();
      await new Promise((r) => setTimeout(r, ms));
      sampling = false;
      return seen;
    };

    // In: it is drawn part-way there, not switched on.
    const appearing = await sample(() => void userEvent.hover(alpha), 1600);
    await waitForPreview();
    expect(appearing.some((o) => o > 0.02 && o < 0.98)).toBe(true);

    // Out: the same, in reverse — and it is still in the DOM while it goes.
    const leaving = await sample(() => {
      void userEvent.unhover(alpha);
      if (pane) void userEvent.hover(pane);
    }, 900);
    expect(leaving.some((o) => o > 0.02 && o < 0.98)).toBe(true);
    await waitFor(() => expect(preview()).toBeNull(), { timeout: 3000 });
  },
};

// ---------------------------------------------------------------------------
// Clicking the card opens its tab
// ---------------------------------------------------------------------------

export const ClickingTheCardOpensThatTab: Story = {
  args: { height: 460, initCommands: THREE_TABS },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 460 },
      description: {
        story:
          'The card is the tab’s button drawn larger, so it does what that button does: clicking it switches to that tab and puts the card away. Anything else would make you aim back at a strip of small targets to act on the thing you are already looking at. Its ✕ is the one part that means something else.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('.tab-name[data-window-id]').length).toBe(3),
    );

    const app = (window as unknown as { app: { getSnapshot(): Snap } }).app;
    const current = app.getSnapshot().context.activeWindowId;
    const target = [...canvasElement.querySelectorAll<HTMLElement>('.tab-name[data-window-id]')]
      .map((t) => t.dataset.windowId as string)
      .find((id) => id !== current)!;
    const tab = canvasElement.querySelector<HTMLElement>(`.tab-name[data-window-id="${target}"]`)!;

    await userEvent.hover(tab);
    const card = await waitForPreview(target);

    await userEvent.click(card);
    await waitFor(() => expect(app.getSnapshot().context.activeWindowId).toBe(target));
    await waitFor(() => expect(preview()).toBeNull(), { timeout: 3000 });
  },
};
