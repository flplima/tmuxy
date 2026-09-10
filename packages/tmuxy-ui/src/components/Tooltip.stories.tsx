/**
 * Tooltip stories — the app's own tooltip in place of the browser's `title`:
 * how it opens, where it lands, and everything that closes it.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { Tooltip, TOOLTIP_DELAY_MS } from './Tooltip';
import { ProviderHarness } from '../stories/StoryHarness';

const meta: Meta<typeof Tooltip> = {
  title: 'Components/Tooltip',
  component: Tooltip,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof Tooltip>;

/** The portalled tooltip, wherever in the document it landed. */
const tips = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="tooltip"]'));
const tip = () => tips()[0];

export const HoverAndFocus: Story = {
  render: () => (
    <ProviderHarness height={320}>
      <div style={{ display: 'flex', gap: 24, padding: 40 }}>
        <Tooltip label="Close tab">
          <button type="button" data-testid="trigger">
            ✕
          </button>
        </Tooltip>
        <Tooltip label="Nothing to see">
          <button type="button" data-testid="other">
            ⋮
          </button>
        </Tooltip>
      </div>
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByTestId('trigger');

    // Nothing until the pointer has rested: a tooltip that opens on the way
    // past is noise.
    expect(tips()).toHaveLength(0);
    await userEvent.hover(trigger);
    expect(tips()).toHaveLength(0);

    await waitFor(() => expect(tip()).toBeInTheDocument(), { timeout: TOOLTIP_DELAY_MS + 2000 });
    expect(tip()).toHaveTextContent('Close tab');

    // Portalled out of the trigger's subtree so no pane's overflow can clip
    // it and no transformed ancestor becomes its containing block, and placed
    // against its trigger.
    expect(canvasElement.contains(tip())).toBe(false);
    expect(getComputedStyle(tip()).position).toBe('fixed');
    const triggerBox = trigger.getBoundingClientRect();
    const tipBox = tip().getBoundingClientRect();
    expect(tipBox.width).toBeGreaterThan(0);
    expect(tipBox.top).toBeGreaterThanOrEqual(triggerBox.bottom);
    expect(
      Math.abs(tipBox.left + tipBox.width / 2 - (triggerBox.left + triggerBox.width / 2)),
    ).toBeLessThan(triggerBox.width + tipBox.width);
    // It never eats the pointer that summoned it.
    expect(getComputedStyle(tip()).pointerEvents).toBe('none');

    // Leaving closes it, and only one is ever open.
    await userEvent.unhover(trigger);
    await waitFor(() => expect(tips()).toHaveLength(0));

    // A keyboard user gets it too — at once, no dwell to wait out.
    trigger.focus();
    await waitFor(() => expect(tip()).toBeInTheDocument());
    expect(tip()).toHaveTextContent('Close tab');

    // Escape dismisses it while the trigger keeps focus.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(tips()).toHaveLength(0));
    expect(document.activeElement).toBe(trigger);

    trigger.blur();
  },
};

export const FlipsWhenThereIsNoRoomBelow: Story = {
  render: () => (
    <ProviderHarness height={320}>
      <div style={{ position: 'fixed', left: 20, bottom: 4 }}>
        <Tooltip label="Opens upwards at the bottom edge">
          <button type="button" data-testid="bottom-trigger">
            edge
          </button>
        </Tooltip>
      </div>
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByTestId('bottom-trigger');
    await userEvent.hover(trigger);
    await waitFor(() => expect(tip()).toBeInTheDocument(), { timeout: TOOLTIP_DELAY_MS + 2000 });

    const triggerBox = trigger.getBoundingClientRect();
    const tipBox = tip().getBoundingClientRect();
    expect(tipBox.bottom).toBeLessThanOrEqual(triggerBox.top + 1);
    expect(tipBox.top).toBeGreaterThanOrEqual(0);
    expect(tipBox.bottom).toBeLessThanOrEqual(window.innerHeight);

    await userEvent.unhover(trigger);
    await waitFor(() => expect(tips()).toHaveLength(0));
  },
};

export const IgnoresATouch: Story = {
  render: () => (
    <ProviderHarness height={320}>
      <div style={{ padding: 40 }}>
        <Tooltip label="Not for fingers">
          <button type="button" data-testid="tap-trigger">
            tap me
          </button>
        </Tooltip>
      </div>
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    // A tap is not a hover: opening there would cover what the finger was
    // aiming at, and there is no way to dismiss it.
    const trigger = within(canvasElement).getByTestId('tap-trigger');
    trigger.dispatchEvent(
      new PointerEvent('pointerenter', { bubbles: true, pointerType: 'touch' }),
    );
    await new Promise((r) => setTimeout(r, TOOLTIP_DELAY_MS + 200));
    expect(tips()).toHaveLength(0);
  },
};
