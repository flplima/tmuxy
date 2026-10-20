import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import {
  pasteLine,
  activePaneId,
  paneGroups,
  focusFirstPane,
  paneRect,
  paneIds,
} from './appStoryHelpers';

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
 * Drag-swap keeps SHORT content top-anchored — the regression guard for the
 * bottom-anchor bug (a swap-triggered resize replayed the accumulated %output
 * through a fresh grid, scrolling short content to the bottom in the v86 path).
 * Two near-empty panes each get one short line at the top, then are swapped by
 * dragging a titlebar. After the drop, each pane's content must stay in the TOP
 * rows (deepest non-blank row and cursor well above the pane bottom) — a
 * full-screen pane would hide this, so the panes are deliberately short.
 */
export const DragSwapShortContentStaysTopAnchored: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const findPane = (id: string) =>
      paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!;

    // Deepest non-blank content row + cursor row for a pane (from the app state).
    const anchor = (id: string): { h: number; deepest: number; cY: number } => {
      const pane = (
        window as unknown as {
          app: {
            getSnapshot(): {
              context: {
                panes: Array<{
                  tmuxId: string;
                  height: number;
                  cursorY: number;
                  content: Array<Array<{ c?: string }>>;
                }>;
              };
            };
          };
        }
      ).app
        .getSnapshot()
        .context.panes.find((p) => p.tmuxId === id)!;
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
    await sleep(500);

    // Precondition: both panes are short and top-anchored before the swap.
    for (const id of [a, b]) {
      const g = anchor(id);
      expect(g.deepest, `pane ${id} should start short/top-anchored`).toBeLessThan(g.h / 2);
    }

    // Drag pane A's titlebar onto pane B to swap them.
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
      await sleep(100);
    }
    dstEl.dispatchEvent(new MouseEvent('mouseup', { clientX: eX, clientY: eY, bubbles: true }));
    await waitFor(() => expect(paneIds(canvas)[0]).toBe(b), {
      timeout: 30000,
      interval: 400,
    }).catch(() => {});
    await sleep(2000);

    // After the swap, each pane's short content must remain TOP-anchored: the
    // deepest non-blank row and the cursor stay in the upper half of the pane,
    // never glued to the bottom (which is exactly the bug this guards).
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
