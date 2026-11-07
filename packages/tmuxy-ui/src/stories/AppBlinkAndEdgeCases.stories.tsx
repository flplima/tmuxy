import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { inputPause, tmuxCaughtUp } from './tmuxBarrier';
import { withTmuxView } from './tmuxView';
import {
  pasteLine,
  activePaneId,
  paneGroups,
  focusFirstPane,
  paneRect,
  paneIds,
} from './appStoryHelpers';
import { appContext } from './storyApp';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Blink & Edge Cases',
  component: V86AppHarness,
  tags: ['v86'],
  args: { shared: true },
  decorators: [withTmuxView],
  parameters: {
    layout: 'fullscreen',
  },
};
export default meta;
type Story = StoryObj<typeof V86AppHarness>;

/**
 * Drag-swap keeps short content top-anchored: a swap-triggered resize used to
 * replay the accumulated %output through a fresh grid, scrolling short content
 * to the bottom in the v86 path. The panes are deliberately near-empty: a
 * full screen would hide it.
 */
export const DragSwapShortContentStaysTopAnchored: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const findPane = (id: string) =>
      paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!;

    const anchor = (id: string): { h: number; deepest: number; cY: number } => {
      const pane = appContext().panes.find((p) => p.tmuxId === id)!;
      let deepest = -1;
      pane.content.forEach((line, i) => {
        if (line.some((cell) => (cell.c ?? '').trim().length > 0)) deepest = i;
      });
      return { h: pane.height, deepest, cY: pane.cursorY };
    };

    const [a, b] = paneIds(canvas);
    const fillShort = async (id: string, marker: string) => {
      await user.click(findPane(id));
      await waitFor(() => expect(activePaneId()).toBe(id), { timeout: 15000, interval: 200 });
      pasteLine(`echo ${marker}`);
      await waitFor(() => expect(findPane(id).textContent ?? '').toContain(marker), {
        timeout: 30000,
        interval: 400,
      });
    };
    await fillShort(a, 'SHORT_AAA');
    await fillShort(b, 'SHORT_BBB');
    await tmuxCaughtUp();

    for (const id of [a, b]) {
      const g = anchor(id);
      expect(g.deepest, `pane ${id} should start short/top-anchored`).toBeLessThan(g.h / 2);
    }

    const header = findPane(a).querySelector('.pane-header') as HTMLElement;
    const hRect = header.getBoundingClientRect();
    const dstRect = paneRect(canvas, b);
    const sX = hRect.left + hRect.width / 2;
    const sY = hRect.top + hRect.height / 2;
    const eX = dstRect.left + dstRect.width / 2;
    const eY = dstRect.top + dstRect.height / 2;
    const dstEl = findPane(b);
    header.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: sX, clientY: sY, bubbles: true }),
    );
    for (let i = 1; i <= 8; i++) {
      (i <= 2 ? header : dstEl).dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: sX + ((eX - sX) * i) / 8,
          clientY: sY + ((eY - sY) * i) / 8,
          bubbles: true,
        }),
      );
      await inputPause(100);
    }
    dstEl.dispatchEvent(new MouseEvent('mouseup', { clientX: eX, clientY: eY, bubbles: true }));
    await waitFor(() => expect(paneIds(canvas)[0]).toBe(b), {
      timeout: 30000,
      interval: 400,
    }).catch(() => {});
    await tmuxCaughtUp();

    for (const id of paneIds(canvas)) {
      const g = anchor(id);
      expect(
        g.deepest,
        `pane ${id} content bottom-anchored after swap (deepest=${g.deepest}/${g.h})`,
      ).toBeLessThan(g.h / 2);
      expect(g.cY, `pane ${id} cursor bottom-anchored after swap (cY=${g.cY}/${g.h})`).toBeLessThan(
        g.h / 2,
      );
    }
  },
};
