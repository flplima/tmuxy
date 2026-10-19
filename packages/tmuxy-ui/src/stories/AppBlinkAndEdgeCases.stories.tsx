import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import { enableRenderLog, renderLogMark, renderCountSince } from '../utils/renderLogStore';
import { ContentMutationRecorder } from './contentMutation';
import {
  pasteLine,
  activePaneId,
  paneGroups,
  focusFirstPane,
  paneRect,
  paneIds,
  settleGeometry,
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
 * 3.3 — Prefix lifecycle: an armed prefix expires after its timeout (the next
 * keys are literal input again), and a double prefix sends a literal C-a to
 * the shell (readline beginning-of-line — proven by inserting text at the
 * start of a pre-typed line).
 */
export const PrefixTimeoutAndDoublePrefix: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const prefixActive = () =>
      (
        window as unknown as { app: { getSnapshot(): { context: { prefixActive?: boolean } } } }
      ).app.getSnapshot().context.prefixActive === true;
    await focusFirstPane(canvas, user);

    // Arm the prefix, let it expire (8s timeout), then type a command — every
    // key must reach the shell as literal input.
    await user.keyboard('{Control>}a{/Control}');
    await waitFor(() => expect(prefixActive()).toBe(true), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 8300));
    expect(prefixActive()).toBe(false);
    await user.keyboard('echo $((41+1))_PT{Enter}');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => (p.textContent ?? '').includes('42_PT')),
        ).toBe(true),
      { timeout: 20000, interval: 500 },
    );

    // Double prefix = literal C-a (readline home): pre-type the tail, jump to
    // the start, prepend `echo` — the executed line proves C-a reached bash.
    await user.keyboard(' TAIL_A9');
    await user.keyboard('{Control>}a{/Control}');
    await waitFor(() => expect(prefixActive()).toBe(true), { timeout: 5000 });
    await user.keyboard('{Control>}a{/Control}');
    await waitFor(() => expect(prefixActive()).toBe(false), { timeout: 5000 });
    await user.keyboard('echo{Enter}');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /TAIL_A9/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 20000, interval: 500 },
    );
  },
};

/**
 * 3.5 — IME composition: composed CJK text is suppressed during composition
 * and sent as ONE literal on compositionend — rendered back from the real
 * `%output` stream (send-keys -l → tmux → bash echo → renderer).
 */
export const IMEComposition: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    window.dispatchEvent(new CompositionEvent('compositionend', { data: '日本語', bubbles: true }));
    // Wide CJK glyphs render with continuation-cell spacing — compare with
    // whitespace stripped.
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            (p.textContent ?? '').replace(/\s+/g, '').includes('日本語'),
          ),
        ).toBe(true),
      { timeout: 20000, interval: 500 },
    );
  },
};

/**
 * 3.6 — Escape semantics: with a float focused, Escape CLOSES the float; with
 * plain panes, Escape is SENT to the application (proven by `od` printing
 * byte 27). The same key, two meanings, resolved by focus context.
 */
export const EscapeSemanticsMatrix: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doc = canvasElement.ownerDocument;

    // Float focused → Escape closes it.
    pasteLine('tmuxy pane float');
    await waitFor(
      () => expect(doc.querySelector('.float-container'), 'float appeared').not.toBeNull(),
      { timeout: 30000, interval: 500 },
    );
    await user.keyboard('{Escape}');
    await waitFor(
      () => expect(doc.querySelector('.float-container'), 'float closed by Escape').toBeNull(),
      { timeout: 20000, interval: 500 },
    );

    // Plain pane → Escape is SENT to the app. Re-focus a grid pane by
    // clicking it (clears any lingering float focus), start a raw-mode
    // single-byte read, and prove the ESC byte (27) arrived.
    await waitFor(() => expect(activePaneId()).toMatch(/^%\d+$/), { timeout: 10000 });
    await user.click(paneGroups(canvas)[0]);
    await waitFor(() => expect(activePaneId()).toMatch(/^%\d+$/), { timeout: 10000 });
    pasteLine('read -rsn1 k; printf "GOT_%d_END\\n" "\'$k"');
    await new Promise((r) => setTimeout(r, 2500));
    const sawEsc = () =>
      paneGroups(canvas).some((p: HTMLElement) => /GOT_27_END/.test(p.textContent ?? ''));
    for (let i = 0; i < 3 && !sawEsc(); i++) {
      await user.keyboard('{Escape}');
      await new Promise((r) => setTimeout(r, 2500));
    }
    await waitFor(() => expect(sawEsc(), 'read got byte 27').toBe(true), {
      timeout: 15000,
      interval: 500,
    });
  },
};

// ─────────── §16 Render budget canary (real adapter) ───────────

/**
 * 5.6 — The typing-isolation contract against the REAL stack: keystrokes into
 * the focused pane must not re-render the other pane or the tab strip. The
 * budget is relaxed vs the mock twin (Mocked App/RenderBudgets) — the v86
 * notify cadence includes capture refreshes — but a "typing repaints the
 * world" regression still fails loudly.
 */
export const RenderBudgetCanary: Story = {
  render: (args) => {
    enableRenderLog();
    return <V86AppHarness {...args} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    expect(renderCountSince(0, 'Pane:')).toBeGreaterThan(0);
    const active = activePaneId();
    const other = paneIds(canvas).find((id) => /^%\d+$/.test(id) && id !== active)!;
    await settleGeometry(canvas);

    // Let periodic sync traffic quiesce for the other pane.
    await waitFor(
      async () => {
        const m = renderLogMark();
        await new Promise((r) => setTimeout(r, 700));
        expect(renderCountSince(m, `Pane:${other}`)).toBe(0);
      },
      { timeout: 30000, interval: 100 },
    );

    const mark = renderLogMark();
    await user.keyboard('echo canary');
    await waitFor(() => expect(renderCountSince(mark, `Pane:${active}`)).toBeGreaterThan(0), {
      timeout: 10000,
    });
    await new Promise((r) => setTimeout(r, 800));
    const otherRenders = renderCountSince(mark, `Pane:${other}`);
    const tabRenders = renderCountSince(mark, 'WindowTabs');
    expect(otherRenders, `inactive pane renders: ${otherRenders}`).toBeLessThanOrEqual(2);
    expect(tabRenders, `WindowTabs renders: ${tabRenders}`).toBeLessThanOrEqual(2);
  },
};

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

/**
 * Content-blink guard against REAL tmux (the "x86 client-side" path): navigating
 * between panes, splitting, and resizing must never tear down and remount a
 * surviving pane's terminal content — the DOM-churn blink a text sampler can't
 * see. A `ContentMutationRecorder` (MutationObserver over `.pane-layout`) watches
 * the whole run; the only content it may see removed is `.terminal-line`s as a
 * pane's height changes and the cursor span following focus — never a
 * `.pane-content` / `.terminal-container` container for a pane that persists.
 *
 * The demo-tier `Mocked App/Content Stability` stories assert the same on the
 * deterministic engine and gate CI; this proves it survives real tmux re-tiling.
 */
export const ContentBlinkFreeOnPaneOps: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const cmd = (c: string) =>
      (window as unknown as { app: { send: (e: unknown) => void } }).app.send({
        type: 'SEND_TMUX_COMMAND',
        command: c,
      });

    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(2), {
      timeout: 45000,
      interval: 500,
    });
    await sleep(1000);

    const layout = canvasElement.querySelector('.pane-layout') as HTMLElement;
    const rec = new ContentMutationRecorder(layout);

    // Navigate: focus each pane in turn.
    for (const id of paneIds(canvas)) {
      cmd(`select-pane -t ${id}`);
      await sleep(300);
    }
    // Split: a new pane appears; the survivors must not remount.
    cmd('split-window -h');
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(3), {
      timeout: 30000,
      interval: 400,
    });
    await sleep(800);
    // Resize: shrink the active pane both ways.
    const active = activePaneId();
    for (let i = 0; i < 3; i++) {
      cmd(`resize-pane -t ${active} -L 4`);
      await sleep(300);
    }
    for (let i = 0; i < 3; i++) {
      cmd(`resize-pane -t ${active} -R 4`);
      await sleep(300);
    }
    await sleep(500);

    // The observer must have seen real churn (else the assertion is vacuous)…
    expect(rec.observedRemovals).toBeGreaterThan(0);
    // …and none of it may be a surviving pane's content container being remounted.
    rec.assertNoBlink('navigate/split/resize (real tmux)');
  },
};
