import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import { GlitchRecorder } from './glitchRecorder';
import {
  pasteLine,
  paneGroups,
  waitForBurstTail,
  focusFirstPane,
  windows,
  paneGroupsState,
  paneIds,
  tabWindows,
  realTabWindows,
  settleGeometry,
} from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Isolation & Throughput',
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
 * Shared-engine isolation canary: a story starts on the shared engine after
 * others mutated it, and the reset must give exactly the snapshot (2 panes, 1
 * window, no floats or groups, no other story's text). The reattach must then
 * deliver each command once: a third copy of a line is a duplicated listener
 * or a serial buffer leaked from the reuse path.
 */
export const SharedIsolation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    expect(paneIds(canvas).sort()).toEqual(['%0', '%1']);
    expect(tabWindows().length).toBe(1);
    expect(windows().some((w) => w.windowType === 'float') || paneGroupsState().length > 0).toBe(
      false,
    );
    const text = paneGroups(canvas)
      .map((p: HTMLElement) => p.textContent ?? '')
      .join('');
    expect(text).not.toMatch(
      /NOERR_9|BURST_Q\d+_END|STORY_LATENCY_6042|SHORT_AAA|SHORT_BBB|SYNC_ON_42|STREAM_DONE/,
    );

    for (const n of [1, 2, 3]) {
      pasteLine(`echo REATTACH_S${n}`);
      await waitFor(
        () => {
          const now = paneGroups(canvas)
            .map((p: HTMLElement) => p.textContent ?? '')
            .join('');
          expect((now.match(new RegExp(`REATTACH_S${n}`, 'g')) ?? []).length).toBe(2);
        },
        { timeout: 30000, interval: 500 },
      );
    }
  },
};

/**
 * `seq 1 2000` streams ~9KB through the serial pump and the WASM core; the pane
 * must end at exactly 2000 (a dropped or reordered chunk breaks the tail).
 */
export const ThroughputSustained: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('seq 1 2000');
    await waitForBurstTail(canvas, (text) => /199819992000/.test(text.replace(/\s+/g, '')));
  },
};

/** Ten pasted commands must all run, in order, once: the byte-paced writer's queue under load. */
export const RapidCommandBurst: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    for (let n = 1; n <= 10; n++) pasteLine(`echo BURST_Q${n}_END`);
    // ~20 rows is more than the pane shows, so the early commands scroll out;
    // the last five always fit.
    await waitFor(
      () => {
        const text = paneGroups(canvas)
          .map((p: HTMLElement) => p.textContent ?? '')
          .join('');
        for (let n = 6; n <= 10; n++) {
          expect(
            (text.match(new RegExp(`BURST_Q${n}_END`, 'g')) ?? []).length,
          ).toBeGreaterThanOrEqual(2);
        }
        expect(text.lastIndexOf('BURST_Q10_END')).toBeGreaterThan(text.indexOf('BURST_Q6_END'));
      },
      { timeout: 60000, interval: 700 },
    );
  },
};

/**
 * Five new tabs from `+` with no pause cost kilobytes of commands on the serial
 * line; a command typed right after must still echo within a typing round
 * trip. The writer used to pace at 2 KB/s, so such a burst put seconds between
 * a keystroke and the guest and tracked commands timed out unwritten.
 */
export const LayoutBurstThenTypingStaysPrompt: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const before = realTabWindows().length;
    const plus = canvas.getByLabelText('Create new tab');
    for (let i = 0; i < 5; i++) plus.click();
    await waitFor(
      () => {
        expect(windows().some((w) => w.id.startsWith('__placeholder_'))).toBe(false);
        expect(realTabWindows().length).toBe(before + 5);
      },
      { timeout: 15000, interval: 200 },
    );
    const typedAt = performance.now();
    await user.keyboard('echo BURST_DONE_MARK{Enter}');
    await waitFor(
      () => {
        const text = paneGroups(canvas)
          .map((p: HTMLElement) => p.textContent ?? '')
          .join('');
        expect((text.match(/BURST_DONE_MARK/g) ?? []).length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 6000, interval: 100 },
    );
    expect(performance.now() - typedAt).toBeLessThan(4000);
  },
};

/**
 * A Gemini-CLI-style clear+redraw loop against real tmux (the mock twin is in
 * Mocked App/Resilience) delivers each frame whole: no pane-node flicker, no
 * blank pane.
 */
export const SteadyStreamNoBlinkV86: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());

    // Each excluded selector must still exist, or the recorder is silently
    // blind to what it thinks it skips.
    for (const sel of ['.terminal-content', '.terminal-line']) {
      expect(canvasElement.querySelector(sel), `ignore-selector ${sel} matches`).not.toBeNull();
    }

    await settleGeometry(canvas);
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    pasteLine(
      'for i in $(seq 1 30); do printf "\\033[2J\\033[HREDRAW_%02d\\n" "$i"; done; echo STREAM_DONE',
    );
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            (p.textContent ?? '').includes('STREAM_DONE'),
          ),
        ).toBe(true),
      { timeout: 45000, interval: 500 },
    );
    glitches.assertNoGlitches('steadyStream');
  },
};
