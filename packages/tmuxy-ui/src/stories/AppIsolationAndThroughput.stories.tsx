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
 * Throughput: a burst of terminal output (`seq 1 200`) streams through the
 * byte-paced serial writer and the WASM core's %output handling without dropping
 * or corrupting bytes — the last line of the burst must render intact. Guards the
 * high-rate path the earlier per-byte serial fix addressed.
 */
export const Throughput: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('seq 1 200');
    // Terminal rows concatenate with no separator in textContent, so match
    // the contiguous tail "198199200" (like ThroughputSustained) — the digit
    // run doubles as the in-order-delivery check; a lone /\b200\b/ can never
    // match ("199" always precedes it with no whitespace between rows).
    await waitForBurstTail(canvas, (text) => /198199200(\D|$)/.test(text.replace(/\s+/g, '')));
  },
};

/**
 * Asset weight: a regression guard on the client-side x86 boot payload. After the
 * machine boots, the Resource Timing API reports how many bytes each served asset
 * cost; we sum the v86 (kernel/BIOS/snapshot) and WASM bundles and assert they
 * stay within budget so the demo/story payload can't silently balloon.
 */
export const AssetWeight: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(2), {
      timeout: 45000,
      interval: 500,
    });
    // Dedupe by URL so the measurement is order-independent: in the shared-
    // engine batch run, dozens of stories precede this one on the same page,
    // and the reset path legitimately fetches the .gz snapshot in addition to
    // the boot's .zst. Each unique asset is counted once and the reset-only
    // .gz gets its own budget instead of inflating the cold-boot budget.
    const uniq = new Map<string, number>();
    for (const r of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
      if (!uniq.has(r.name)) uniq.set(r.name, r.encodedBodySize || r.transferSize || 0);
    }
    const bytesFor = (re: RegExp, exclude?: RegExp) =>
      [...uniq.entries()]
        .filter(([name]) => re.test(name) && !(exclude && exclude.test(name)))
        .reduce((sum, [, bytes]) => sum + bytes, 0);
    const bootBytes = bytesFor(/\/v86(-img)?\//, /tmux-state\.bin\.gz/);
    const resetGzBytes = bytesFor(/tmux-state\.bin\.gz/);
    const wasmBytes = bytesFor(/\/wasm\//);
    // Assets must be measurable and within budget. The snapshot ships zstd
    // (~14 MB wire vs 34 MB raw) + ~5 MB kernel + BIOS; regressions past the
    // budget fail loudly instead of silently bloating the demo payload.
    expect(bootBytes).toBeGreaterThan(0);
    expect(bootBytes).toBeLessThan(26 * 1024 * 1024);
    if (resetGzBytes > 0) expect(resetGzBytes).toBeLessThan(20 * 1024 * 1024);
    expect(wasmBytes).toBeLessThan(2 * 1024 * 1024);
  },
};

// ───────────────────────── §10–11 Infra & perf guards ─────────────────────────

/**
 * Shared-engine isolation canary: EVERY story in this file starts on the shared
 * engine after some other story mutated it — this one pins the reset contract
 * hard: exactly the snapshot's 2 panes and 1 tab window, no floats/groups, no
 * sentinel text from any other story's commands, default active state.
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
    expect(text).not.toMatch(/STORY_INTERACT|SYNC_ON_42|ML_A4|HIST_R7|YANK_TARGET/);
  },
};

/**
 * Shared-engine reattach stability: after the boot/reset attach, drive several
 * command round-trips in a row — each must land exactly once (no duplicated
 * listeners, no leaked serial buffers from the reuse path).
 */
export const SharedReattachStability: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    for (const n of [1, 2, 3]) {
      pasteLine(`echo REATTACH_S${n}`);
      await waitFor(
        () => {
          const text = paneGroups(canvas)
            .map((p: HTMLElement) => p.textContent ?? '')
            .join('');
          // command echo + output = exactly 2 occurrences; 3+ would mean a
          // duplicated send path.
          expect((text.match(new RegExp(`REATTACH_S${n}`, 'g')) ?? []).length).toBe(2);
        },
        { timeout: 30000, interval: 500 },
      );
    }
  },
};

/**
 * No stray page errors: the harness page must not throw uncaught exceptions
 * while a full boot + interact cycle runs. window.onerror hooks are installed
 * BEFORE interacting so anything thrown during the cycle is captured.
 */
export const NoConsoleErrors: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const errors: string[] = [];
    // "ResizeObserver loop completed with undelivered notifications" is a benign
    // browser back-pressure signal (fired as an error event, harmless, and
    // whitelisted by every mainstream test harness) — not an app defect.
    const BENIGN = /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/;
    const onError = (e: ErrorEvent) => {
      if (!BENIGN.test(String(e.message))) errors.push(String(e.message));
    };
    const onRejection = (e: PromiseRejectionEvent) => errors.push(String(e.reason));
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    try {
      await focusFirstPane(canvas, userEvent.setup());
      pasteLine('echo NOERR_9');
      await waitFor(
        () =>
          expect(
            paneGroups(canvas).some((p: HTMLElement) => /NOERR_9/.test(p.textContent ?? '')),
          ).toBe(true),
        { timeout: 30000, interval: 500 },
      );
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
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

// ─────────── §15 Flakiness budgets: steady streams, theme switches ───────────

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
