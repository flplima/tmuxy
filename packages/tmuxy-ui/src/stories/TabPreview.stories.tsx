/**
 * The tab preview, over a recording of real tmux: three tabs, `alpha`, `bravo`
 * and `charlie` (current). The first preview waits a second, so a pointer
 * crossing the strip shows nothing; once one is up, moving along the strip
 * slides the SAME card to the next button. These stories check it is literally
 * the same DOM node: a remounted card looks the same in a screenshot and is
 * wrong to use.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import threeTabs from './fixtures/gen/three-tabs.json';
import {
  animationNames,
  preview,
  runningAnimation,
  type Snap,
  tabButton,
  waitForCardLeaving,
  waitForPreview,
  waitForPreviewInserted,
} from './tabPreviewHelpers';

/** Switching to `alpha`, and closing `bravo`, answered as tmux answered them. */
const TRANSITIONS = [
  { match: /^select-window -t @0$/, to: 'alpha-active' },
  { match: /^kill-window -t @1\b/, to: 'bravo-killed' },
];

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Tab Preview',
  component: FixtureApp,
  args: { fixture: asFixture(threeTabs), start: 'charlie-active', transitions: TRANSITIONS },
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
type Story = StoryObj<typeof FixtureApp>;

export const RestOpensItAndBrowsingCarriesIt: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
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

    expect(preview()).toBeNull();

    await userEvent.hover(alpha);
    const card = await waitForPreview(alpha.dataset.windowId);

    const box = card.getBoundingClientRect();
    const tab = alpha.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(60);
    expect(box.top).toBeGreaterThanOrEqual(tab.bottom - 1);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    await waitFor(() => expect(card.querySelector('.tab-overview-shot')).not.toBeNull());

    const header = card.querySelector<HTMLElement>('.tab-shot-header .pane-header');
    expect(header, 'the preview drew no pane header').not.toBeNull();
    const scaled = header!.getBoundingClientRect();
    const natural = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--pane-header-height'),
    );
    expect(scaled.height).toBeGreaterThan(0);
    expect(scaled.height).toBeLessThan(natural);
    expect(header!.querySelector('.pane-tab-title')?.textContent ?? '').toMatch(/\S/);

    expect(alpha).toHaveClass('is-previewing');

    await userEvent.hover(bravo);
    await waitFor(() => expect(preview()?.dataset.windowId).toBe(bravo.dataset.windowId), {
      timeout: 1000,
    });
    expect(preview(), 'a new card was created instead of moving the old one').toBe(card);
    expect(bravo).toHaveClass('is-previewing');
    expect(alpha).not.toHaveClass('is-previewing');
    await waitFor(() => {
      const moved = card.getBoundingClientRect();
      const target = bravo.getBoundingClientRect();
      // Give or take the viewport clamp.
      expect(
        Math.abs(moved.left + moved.width / 2 - (target.left + target.width / 2)),
      ).toBeLessThan(moved.width);
    });
  },
};

export const LeavingTheStripEndsIt: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
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

    const pane = canvasElement.querySelector<HTMLElement>('.pane-layout-item');
    await userEvent.unhover(alpha);
    if (pane) await userEvent.hover(pane);
    await waitFor(() => expect(preview()).toBeNull(), { timeout: 3000 });

    await userEvent.hover(alpha);
    await waitForPreview();
    await userEvent.click(alpha);
    await waitFor(() => expect(preview()).toBeNull(), { timeout: 3000 });
  },
};

export const TheCardCanBeReachedAndClosesTheTab: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
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

    const style = getComputedStyle(card);
    expect(parseFloat(style.paddingTop)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(style.paddingLeft)).toBeGreaterThanOrEqual(8);

    await userEvent.unhover(bravo);
    await userEvent.hover(card);
    await new Promise((r) => setTimeout(r, 600));
    expect(preview(), 'the card went away as the pointer reached it').not.toBeNull();

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

export const ItFadesAndSlidesBothWays: Story = {
  tags: ['nightly'],
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'The card fades in with a short slide down from the strip it belongs to, and leaves the same way rather than blinking out — the card is caught as it enters the DOM and as it starts to leave, and the animation it carries at each moment must be the declared one and must play through, so one that never runs would fail. With `@tmuxy-animations off` it simply appears and simply goes.',
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

    const inserted = waitForPreviewInserted();
    void userEvent.hover(alpha);
    const card = await inserted;
    expect(animationNames(card)).toContain('floating-surface-in');
    await runningAnimation(card, 'floating-surface-in').finished;
    await waitForPreview();

    const leaving = waitForCardLeaving(card);
    void userEvent.unhover(alpha);
    if (pane) void userEvent.hover(pane);
    await leaving;
    expect(animationNames(card)).toContain('floating-surface-out');
    // Not awaited: the node is held for exactly the exit's length and its
    // removal cancels the animation, so `finished` can reject on the very frame
    // the exit completes.
    runningAnimation(card, 'floating-surface-out');
    await waitFor(() => expect(preview()).toBeNull(), { timeout: 3000 });
  },
};

export const ClickingTheCardOpensThatTab: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
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

export const RightClickTurnsThePreviewIntoTheMenu: Story = {
  tags: ['nightly'],
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Right-clicking a tab you are already looking at turns its preview INTO its menu. The two are surfaces about the same tab, so only one may be up: drawn together, the menu covered the picture it was opened from and left a card underneath that nothing could reach. The card goes in the same commit the menu arrives in, and the menu opens from the box the card occupied — one object changing shape rather than a disappearance beside an appearance (components/floating).',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('.tab-name[data-window-id]').length).toBe(3),
    );

    const tab = tabButton(canvasElement, 'bravo');
    const windowId = tab.dataset.windowId as string;

    // Settled: its box is compared with the menu's below, so it is read once
    // the entrance has stopped moving it.
    await userEvent.hover(tab);
    const card = await waitForPreview(windowId);
    await Promise.all(card.getAnimations().map((a) => a.finished.catch(() => undefined)));
    const cardBox = card.getBoundingClientRect();
    expect(cardBox.height).toBeGreaterThan(0);

    await userEvent.pointer({ target: tab, keys: '[MouseRight]' });

    const menu = await waitFor(
      () => {
        const el = document.querySelector<HTMLElement>('.floating-menu');
        expect(el, 'no context menu').not.toBeNull();
        return el!;
      },
      { timeout: 5000 },
    );
    expect(menu.getBoundingClientRect().height).toBeGreaterThan(0);

    // Checked as a box, not a missing node: a card left at zero opacity is
    // still a card the pointer can hit.
    await waitFor(
      () => {
        const still = preview();
        if (!still) return;
        const box = still.getBoundingClientRect();
        expect(box.width === 0 || box.height === 0, 'preview still drawn under the menu').toBe(
          true,
        );
      },
      { timeout: 3000 },
    );

    // The offsets are asserted rather than the frames: a 150ms animation is
    // over before a busy runner can sample it.
    expect(menu.classList.contains('is-morphing'), 'the menu did not morph').toBe(true);
    // From the placement the surface wrote: the morph is a transform, so a
    // measured box is the box on the way.
    const left = parseFloat(menu.style.left);
    const top = parseFloat(menu.style.top);
    const morphX = parseFloat(menu.style.getPropertyValue('--morph-x'));
    const morphY = parseFloat(menu.style.getPropertyValue('--morph-y'));
    const where =
      `menu placed at (${left},${top}), morph offset (${morphX},${morphY}), ` +
      `card was at (${Math.round(cardBox.left)},${Math.round(cardBox.top)})`;
    expect(Math.abs(left + morphX - cardBox.left), `x: ${where}`).toBeLessThanOrEqual(2);
    expect(Math.abs(top + morphY - cardBox.top), `y: ${where}`).toBeLessThanOrEqual(2);

    expect(top).toBeGreaterThanOrEqual(tab.getBoundingClientRect().bottom - 1);
  },
};
