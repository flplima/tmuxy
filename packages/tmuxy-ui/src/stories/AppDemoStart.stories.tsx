import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Demo Start',
  component: V86AppHarness,
  tags: ['v86'],
  args: { shared: true, snapshot: 'demo' },
  parameters: {
    layout: 'fullscreen',
  },
};
export default meta;
type Story = StoryObj<typeof V86AppHarness>;

const shown = (el: Element | null | undefined): el is HTMLElement => {
  const r = el?.getBoundingClientRect();
  return !!r && r.width > 0 && r.height > 0;
};

const windowTabs = (root: HTMLElement) =>
  [...root.querySelectorAll('[role=tab]')]
    .filter((t) => shown(t) && /^Tab \d+:/.test(t.getAttribute('aria-label') ?? ''))
    .map((t) => t.getAttribute('aria-label'));

/** Terminal and widget panes alike. */
const panes = (root: HTMLElement) =>
  [
    ...root.querySelectorAll(
      '[role=group][aria-label^="Pane %"], [role=group][aria-label^="Widget pane %"]',
    ),
  ]
    .filter(shown)
    .map((p) => p.getBoundingClientRect());

/**
 * The demo site's start: the state it restores was saved after its showcase
 * was built (`scripts/demo-showcase/showcase.sh`), so the first frame is the
 * finished session. What a restore does not bring back comes back on its own:
 * the picture, which tmux printed to no client, is drawn again when its tab
 * comes to the front (this box is the size the attach leaves every window
 * at, so no resize draws it first); the preview's document is read from the
 * restored share; the pane group's hidden member is in the restored stash
 * session.
 */
export const OpensOnTheBakedShowcase: Story = {
  tags: ['gate'],
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        expect(windowTabs(canvasElement)).toEqual(['Tab 1: welcome (active)', 'Tab 2: features']);
        expect(panes(canvasElement)).toHaveLength(2);
        const [left, right] = panes(canvasElement);
        expect(right.left).toBeGreaterThanOrEqual(left.right - 1);
        expect(right.top).toBe(left.top);
      },
      { timeout: 60000, interval: 200 },
    );

    await user.click(canvas.getByRole('tab', { name: /^Tab 2: features/ }));
    await waitFor(
      () => {
        expect(windowTabs(canvasElement)).toEqual(['Tab 1: welcome', 'Tab 2: features (active)']);
        expect(panes(canvasElement)).toHaveLength(3);
      },
      { timeout: 15000, interval: 200 },
    );

    await waitFor(
      () => {
        const group = canvasElement.querySelector('.pane-tabs-group');
        expect([...(group?.querySelectorAll('.pane-tab') ?? [])].filter(shown)).toHaveLength(2);

        const heading = canvasElement.querySelector('.preview[data-preview-kind=markdown] h1');
        expect(shown(heading) && heading.textContent).toBe('Markdown in tmux?');

        const picture = canvasElement.querySelector<HTMLImageElement>('img.terminal-image');
        expect(shown(picture)).toBe(true);
        expect(picture!.getBoundingClientRect().width).toBeGreaterThan(100);
        expect(picture!.naturalWidth).toBeGreaterThan(0);
      },
      { timeout: 30000, interval: 250 },
    );
  },
};
