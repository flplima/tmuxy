import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
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
 * The scroll view: wheeling up in a shell opens the native-like scrollback view
 * — history fetched from tmux via `get_scrollback_cells` and rendered in a
 * natively-scrolling container — and wheeling back to the bottom closes it.
 *
 * What makes it the scroll view rather than copy mode is asserted too: the mode
 * on the client record, and tmux never reporting `in_mode` for the pane. A
 * wheel gesture must not hand a pane a cursor and vi keys. See COPY-MODE.md.
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
    // The wheel handler gates scroll-up on the client knowing the pane HAS
    // scrollback (historySize from list-panes) — wait for it like a real user.
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
        await new Promise((r) => setTimeout(r, gapMs));
      }
    };
    // Wheel up: opens the scroll view and scrolls the ScrollbackTerminal back.
    await wheel(-120, 6, 250);
    await waitFor(() => expect(paneCopyState(id), 'scroll view open').toBeTruthy(), {
      timeout: 15000,
      interval: 400,
    });
    expect(paneCopyState(id)?.mode, 'opened as the scroll view, not copy mode').toBe('scroll');
    // tmux was never told: the pane is not in a mode, so whatever runs in it
    // carries on and no cursor is drawn over the scrollback.
    expect(paneMode(id), 'tmux left out of it').toBe(false);
    // The rendered viewport shows earlier scrollback lines (100s, not the 199200 tail).
    await waitFor(() => expect(paneEl().textContent ?? '').toMatch(/1[0-9]\d(?!9200)/), {
      timeout: 15000,
      interval: 500,
    });
    // The client scroll offset moved off the bottom of history.
    const cs = paneCopyState(id);
    expect(cs && cs.scrollTop < cs.totalLines - 1).toBe(true);
    // Wheel back down to the bottom → the view closes and the pane follows
    // live output again.
    await wheel(120, 40, 100);
    await waitFor(() => expect(paneCopyState(id), 'scroll view closed at bottom').toBeFalsy(), {
      timeout: 15000,
      interval: 500,
    });
  },
};

/**
 * Sync panes: `synchronize-panes` in real tmux — typed input then mirrors into
 * every pane of the window. Set through the CLI (no key is bound to it), and
 * by value rather than toggled: the command that turns it off is itself
 * mirrored into every pane, and a toggle run twice would leave it on. We paste
 * a sentinel with sync ON (must render in BOTH panes) and another after
 * turning it OFF (must render in exactly one) — the negative half guards
 * against a stuck setting.
 */
export const SyncPanes: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const inPanes = (re: RegExp) =>
      paneGroups(canvas).filter((p: HTMLElement) => re.test(p.textContent ?? '')).length;
    // Set, then wait for the echo chained after it: it prints only once tmux
    // has applied the setting, and the typed line carries the marker too, so
    // the output is its second occurrence. A sentinel typed before the setting
    // lands would reach one pane and read as sync not working.
    const set = async (value: 'on' | 'off', marker: string) => {
      pasteLine(`tmuxy run setw synchronize-panes ${value} && echo ${marker}`);
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
    // Give the mirror a beat, then confirm it STAYED in one pane (not just raced).
    await new Promise((r) => setTimeout(r, 1500));
    expect(inPanes(/SYNC_OFF_42/)).toBe(1);
  },
};
