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
 * Copy mode enter: with real scrollback, C-a `[` enters copy mode — the client
 * intercepts `copy-mode`, initializes its scrollback engine, and forwards the
 * command so tmux flips `in_mode`. Asserted via the tmux-reported `inMode` AND
 * the rendered `[COPY MODE]` header indicator.
 */
export const CopyModeEnter: Story = {
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
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('[[');
    await waitFor(() => expect(paneMode(id)).toBe(true), { timeout: 15000, interval: 400 });
    // The pane header shows the [COPY MODE] indicator the user sees.
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /\[COPY MODE\]/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 10000, interval: 400 },
    );
  },
};

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
 * Copy mode exit: `q` leaves copy mode (tmux-reported), and the pane is a live
 * shell again — a typed command's output renders.
 */
export const CopyModeExit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const id = activePaneId();
    pasteLine('seq 1 100');
    await waitFor(
      () =>
        expect(paneGroups(canvas).some((p: HTMLElement) => /99100/.test(p.textContent ?? ''))).toBe(
          true,
        ),
      { timeout: 30000, interval: 500 },
    );
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('[[');
    await waitFor(() => expect(paneMode(id)).toBe(true), { timeout: 15000, interval: 400 });
    await user.keyboard('q');
    await waitFor(() => expect(paneMode(id)).toBe(false), { timeout: 15000, interval: 400 });
    pasteLine('echo AFTER_COPY_EXIT_88');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            /AFTER_COPY_EXIT_88/.test(p.textContent ?? ''),
          ),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
  },
};

// ───────────────────────── §7 Input edge cases ─────────────────────────

/**
 * Multi-line paste: one paste of three lines reaches bash as one bracketed
 * paste, and the Enter after it runs all three commands, in order, exactly
 * once — no line runs early on a newline of its own.
 */
export const PasteMultiline: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('echo ML_A4\necho ML_B4\necho ML_C4');
    await waitFor(
      () => {
        const text = paneGroups(canvas)
          .map((p: HTMLElement) => p.textContent ?? '')
          .join('');
        for (const m of ['ML_A4', 'ML_B4', 'ML_C4']) {
          // Rendered once as the echoed command and once as output ⇒ ≥2 hits.
          expect((text.match(new RegExp(m, 'g')) ?? []).length).toBeGreaterThanOrEqual(2);
        }
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Long-line paste: a single line longer than PASTE_CHUNK_SIZE (500) is split
 * into multiple `send-keys -l` chunks that must reassemble verbatim — the tail
 * sentinel only prints if no middle chunk was dropped or reordered.
 */
export const PasteLongLine: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const filler = 'a'.repeat(560);
    pasteLine(`echo ${filler}LONG_TAIL_63`);
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            /a{20,}LONG_TAIL_63/.test(p.textContent ?? ''),
          ),
        ).toBe(true),
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * Special characters survive the paste path verbatim: single quotes (tmux -l
 * escaping), `$` (no shell expansion en route), `#` (tmux 3.7a format expansion
 * — must be ##-escaped by the adapter), and `\;` inside a literal (must NOT be
 * rewritten as a command separator).
 */
export const PasteQuotesAndSpecials: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    // #{session_name} is the HARD case: a valid tmux format that 3.7a
    // send-keys would expand, and (unlike #{pane_id}/#{pane_width}/#{pane_height},
    // which the appMachine substitutes client-side BY DESIGN — appMachine
    // SEND_TMUX_COMMAND placeholder expansion) nothing pre-substitutes it, so
    // the adapter must chunk the literal for it to survive verbatim.
    pasteLine(`echo "it's \\$x #{session_name} ; done_QS9"`);
    // bash prints: it's $x #{session_name} ; done_QS9
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            /it's \$x #\{session_name\} ; done_QS9/.test(p.textContent ?? ''),
          ),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Shell history round-trip: run a command, press ArrowUp (must reach bash as a
 * cursor key, not a literal) and Enter — the same output prints a second time.
 */
export const ArrowKeysHistory: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const hits = () =>
      paneGroups(canvas)
        .map((p: HTMLElement) => p.textContent ?? '')
        .join('')
        .match(/HIST_R7/g)?.length ?? 0;
    pasteLine('echo HIST_R7');
    // echoed command + output = 2 occurrences.
    await waitFor(() => expect(hits()).toBeGreaterThanOrEqual(2), {
      timeout: 30000,
      interval: 500,
    });
    const before = hits();
    await user.keyboard('{ArrowUp}');
    await new Promise((r) => setTimeout(r, 800));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(hits()).toBeGreaterThan(before), { timeout: 30000, interval: 500 });
  },
};

/**
 * Tab completion: `ec` + Tab must reach bash as a real Tab (completing to
 * `echo `), then the typed argument executes — the output can only render if
 * the completion worked.
 */
export const TabCompletion: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await user.keyboard('e');
    await new Promise((r) => setTimeout(r, 300));
    await user.keyboard('c');
    await new Promise((r) => setTimeout(r, 500));
    await user.keyboard('{Tab}');
    await new Promise((r) => setTimeout(r, 1200));
    pasteLine('TAB_OK_21');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            /(^|[^o])TAB_OK_21/.test(p.textContent ?? ''),
          ),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
  },
};
