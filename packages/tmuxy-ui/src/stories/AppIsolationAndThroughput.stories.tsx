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
 * Shared-engine isolation canary: EVERY story in this file starts on the shared
 * engine after some other story mutated it — this one pins the reset contract
 * hard: exactly the snapshot's 2 panes and 1 tab window, no floats/groups, no
 * sentinel text from any other story's commands, default active state.
 *
 * Then the reattach the reset made must deliver each command exactly once:
 * several round-trips in a row, each rendered exactly twice (the typed line
 * and its output) — a third copy is a duplicated listener or a serial buffer
 * leaked from the reuse path.
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
    // No residue from other stories' unique sentinels.
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
 * Sustained throughput: `seq 1 2000` streams ~9KB through the serial pump and
 * the WASM core. The tail must arrive intact and in order — the pane ends at
 * exactly 2000 (a dropped or reordered chunk breaks the trailing sequence).
 */
export const ThroughputSustained: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('seq 1 2000');
    await waitForBurstTail(canvas, (text) => /199819992000/.test(text.replace(/\s+/g, '')));
  },
};

/**
 * Rapid command burst: ten commands pasted back-to-back must ALL run, in order,
 * exactly once — pressure-testing the byte-paced writer's queue under bursty
 * send-keys load.
 */
export const RapidCommandBurst: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    for (let n = 1; n <= 10; n++) pasteLine(`echo BURST_Q${n}_END`);
    // Ten commands emit ~20 rows (typed echo + output each) — more than the
    // pane can show, so the EARLY commands' lines legitimately scroll out of
    // the viewport and can't be asserted on. The last five (10 rows) always
    // fit: require echo + output for each, in order. The queue pressure the
    // story exists for still comes from all ten back-to-back pastes.
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
        // In-order: the last command's OUTPUT must appear after the sixth's.
        expect(text.lastIndexOf('BURST_Q10_END')).toBeGreaterThan(text.indexOf('BURST_Q6_END'));
      },
      { timeout: 60000, interval: 700 },
    );
  },
};

/**
 * 4.3 — Gemini-CLI-style clear+redraw burst against REAL tmux (the mock twin
 * lives in Mocked App/Resilience): a guest loop repeatedly clears the screen
 * and redraws; the rAF batching + aggregator debounce must deliver each frame
 * whole — zero pane-node flickers, no transient blank pane. Also audits that
 * the glitch recorder's ignore-selectors still match the live DOM (silent
 * selector drift would blind every budget in this file).
 */
export const SteadyStreamNoBlinkV86: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());

    // Ignore-selector audit: each excluded selector must still exist in the
    // live DOM, or the recorder is silently blind to what it thinks it skips.
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
    // Every sampled frame during the burst must have shown a full redraw —
    // no pane-node flicker, no size movement.
    glitches.assertNoGlitches('steadyStream');
  },
};
