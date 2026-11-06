import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { inputPause } from './tmuxBarrier';
import { withTmuxView } from './tmuxView';
import {
  pasteLine,
  activePaneId,
  paneGroups,
  focusFirstPane,
  paneHistory,
  paneMode,
  paneCopyState,
} from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Copy & Input',
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
 * Wheeling up in a shell opens the scroll view (history from
 * `get_scrollback_cells` in a natively scrolling container) and wheeling back
 * down closes it. tmux never reports `in_mode`: a wheel gesture must not hand a
 * pane a cursor and vi keys (docs/COPY-MODE.md).
 */
export const ScrollViewWheel: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const id = activePaneId();
    pasteLine('seq 1 200');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /199200/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
    // The wheel opens the view only once the client knows the pane has
    // scrollback (historySize from list-panes).
    await waitFor(() => expect(paneHistory(id)).toBeGreaterThan(0), {
      timeout: 15000,
      interval: 400,
    });
    const paneEl = () =>
      paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!;
    const wheel = async (dy: number, times: number, gapMs: number) => {
      for (let i = 0; i < times; i++) {
        paneEl().dispatchEvent(
          new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }),
        );
        await inputPause(gapMs);
      }
    };
    await wheel(-120, 6, 250);
    await waitFor(() => expect(paneCopyState(id), 'scroll view open').toBeTruthy(), {
      timeout: 15000,
      interval: 400,
    });
    expect(paneCopyState(id)?.mode, 'opened as the scroll view, not copy mode').toBe('scroll');
    expect(paneMode(id), 'tmux left out of it').toBe(false);
    await waitFor(() => expect(paneEl().textContent ?? '').toMatch(/1[0-9]\d(?!9200)/), {
      timeout: 15000,
      interval: 500,
    });
    const cs = paneCopyState(id);
    expect(cs && cs.scrollTop < cs.totalLines - 1).toBe(true);
    await wheel(120, 40, 100);
    await waitFor(() => expect(paneCopyState(id), 'scroll view closed at bottom').toBeFalsy(), {
      timeout: 15000,
      interval: 500,
    });
  },
};

/**
 * `synchronize-panes` in real tmux, set at the shell as a user would (no key is
 * bound to it, and `tmuxy run` sets no option: one that mirrors keys would carry
 * an agent's keys into every pane). Set by value, not toggled: the command that
 * turns it off is itself mirrored, and a toggle run twice leaves it on. The
 * sentinel typed after OFF must render in exactly one pane (a stuck setting).
 */
export const SyncPanes: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const inPanes = (re: RegExp) =>
      paneGroups(canvas).filter((p: HTMLElement) => re.test(p.textContent ?? '')).length;
    // The echo chained after the setting prints only once tmux has applied it;
    // the typed line carries the marker too, so the output is its second
    // occurrence. A sentinel typed before the setting lands reads as sync
    // not working.
    const set = async (value: 'on' | 'off', marker: string) => {
      pasteLine(`tmux setw synchronize-panes ${value} && echo ${marker}`);
      await waitFor(
        () =>
          expect(
            paneGroups(canvas).some(
              (p: HTMLElement) => (p.textContent ?? '').split(marker).length - 1 >= 2,
            ),
          ).toBe(true),
        { timeout: 30000, interval: 500 },
      );
    };
    await set('on', 'SYNC_SET_42');
    pasteLine('echo SYNC_ON_42');
    await waitFor(() => expect(inPanes(/SYNC_ON_42/)).toBe(2), { timeout: 30000, interval: 500 });
    await set('off', 'SYNC_UNSET_42');
    pasteLine('echo SYNC_OFF_42');
    await waitFor(() => expect(inPanes(/SYNC_OFF_42/)).toBe(1), { timeout: 30000, interval: 500 });
    // Stayed in one pane, not just raced: a fence typed into the other pane
    // runs after anything mirrored into it, since its shell reads input in
    // order.
    const other: HTMLElement = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') !== activePaneId(),
    )!;
    const otherId = other.getAttribute('data-pane-id');
    await user.click((other.querySelector('.terminal-line') as HTMLElement | null) ?? other);
    await waitFor(() => expect(activePaneId()).toBe(otherId), { timeout: 15000, interval: 200 });
    pasteLine('echo SYNC_FENCE_42');
    await waitFor(
      () => expect((other.textContent ?? '').split('SYNC_FENCE_42').length - 1).toBe(2),
      { timeout: 30000, interval: 500 },
    );
    expect(inPanes(/SYNC_OFF_42/)).toBe(1);
  },
};
