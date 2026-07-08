import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { armPaintProbe, addsElement } from './immediacy';
import { enableRenderLog, renderLogMark, renderCountSince } from '../utils/renderLog';
import { GlitchRecorder } from './glitchRecorder';
import { LayoutMutationRecorder } from './animationObservers';
import { ContentMutationRecorder } from './contentMutation';

/**
 * Full-application stories driven by REAL tmux.
 *
 * The harness mounts the production `TmuxyApp` against `V86TmuxAdapter`: real
 * tmux 3.7a runs inside a v86 x86 emulator, and its `tmux -CC` control-mode
 * stream is parsed by tmuxy-core compiled to WASM — the exact code the native
 * server runs. Splits, new windows, and send-keys flow through
 * `invoke('run_tmux_command')` → the emulated tmux → back through the Rust core.
 * There is no lifo.sh shell simulation and no client-side VT emulator.
 *
 * These boot a real machine (~4s from a state snapshot) and are inherently
 * non-deterministic, so they are `v86`-tagged and excluded from the CI story
 * probe; each carries a `play` function for manual review and the dedicated
 * real-tmux e2e check.
 */

/**
 * Enter a command line by pasting it — a first-class real-user path (pasting a
 * command into a terminal is ubiquitous) that the keyboardActor handles via its
 * `paste` listener. Crucially, paste captures the send target (active pane) ONCE
 * and emits a single atomic `send-keys -l <line>` + `send-keys Enter`, so the
 * still-settling v86 boot can't flap the target between characters. Per-keystroke
 * send-keys races that instability and drops/misroutes chars; paste is
 * deterministic while still driving the full real chain (keyboardActor →
 * send-keys → emulated tmux → bash → %output → WASM core → render).
 */
function pasteLine(text: string): void {
  const data = new DataTransfer();
  data.setData('text/plain', `${text}\n`);
  window.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
  );
}

const activePaneId = () =>
  (
    window as unknown as { app: { getSnapshot(): { context: { activePaneId: string } } } }
  ).app.getSnapshot().context.activePaneId;

/** Measured terminal cell width in px (set by the sizeActor after font load). */
const charWidthPx = () =>
  (
    window as unknown as { app: { getSnapshot(): { context: { charWidth: number } } } }
  ).app.getSnapshot().context.charWidth;

type Canvas = ReturnType<typeof within>;
const paneGroups = (canvas: Canvas) => canvas.getAllByRole('group', { name: /^Pane %/i });

/**
 * Progress-aware wait for a streamed output burst. Throughput stories guard
 * INTEGRITY (no dropped/corrupted bytes), not latency: on a loaded CI runner
 * the shared emulator streams arbitrarily slowly, and a fixed deadline flakes
 * exactly when the machine is busiest. Keeps waiting while the pane content
 * still makes progress; throws only when the stream stalls short of the
 * expected tail, or at a hard cap.
 */
async function waitForBurstTail(
  canvas: Canvas,
  sawTail: (text: string) => boolean,
  { capMs = 180000, stallMs = 45000 }: { capMs?: number; stallMs?: number } = {},
): Promise<void> {
  const burstText = () =>
    paneGroups(canvas)
      .map((p: HTMLElement) => p.textContent ?? '')
      .join('\n');
  const deadline = performance.now() + capMs;
  let last = '';
  let lastProgress = performance.now();
  while (performance.now() < deadline && !sawTail(burstText())) {
    const cur = burstText();
    if (cur !== last) {
      last = cur;
      lastProgress = performance.now();
    } else if (performance.now() - lastProgress > stallMs) {
      break; // stream stalled without reaching the expected tail
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(sawTail(burstText())).toBe(true);
}

/**
 * Wait for the booted 2-pane session, focus the first pane, and — crucially —
 * wait for the select-pane round-trip so the active-pane send target is stable
 * before we drive input. The still-settling v86 boot (initial list-panes/
 * list-windows sync) transiently flaps the active pane; without this wait, input
 * would split across panes. Mirrors a real user: click, see the pane activate,
 * then act.
 */
async function focusFirstPane(
  canvas: Canvas,
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(2), {
    timeout: 45000,
    interval: 500,
  });
  // Wait for the boot's initial active-pane sync to settle BEFORE clicking —
  // clicking mid-sync races the select-pane against in-flight active-pane
  // updates and the click can be permanently overridden. A real user clicks
  // after seeing the active highlight appear.
  await waitFor(() => expect(activePaneId()).toMatch(/^%\d+$/), { timeout: 20000, interval: 200 });
  // Also wait for the client resize round-trip to settle: each story mounts
  // at its own viewport, and interacting while set_client_size is still in
  // flight lets the mid-story re-layout (intermediate tmux layouts + the
  // status-row shuffle) land inside the story's glitch window — that, not
  // op prediction, was the source of the phantom kill/split size jumps.
  await waitFor(
    () => {
      const c = (
        window as unknown as {
          app: {
            getSnapshot(): {
              context: {
                targetCols: number;
                targetRows: number;
                totalWidth: number;
                totalHeight: number;
              };
            };
          };
        }
      ).app.getSnapshot().context;
      expect(c.targetCols).toBeGreaterThan(0);
      expect(c.totalWidth).toBe(c.targetCols);
      expect(c.totalHeight).toBe(c.targetRows);
    },
    { timeout: 30000, interval: 250 },
  );
  const paneId = paneGroups(canvas)[0].getAttribute('data-pane-id');
  await user.click(paneGroups(canvas)[0]);
  await waitFor(() => expect(activePaneId()).toBe(paneId), { timeout: 15000, interval: 200 });
}

/** All windows the WASM core has reconstructed, with their tmuxy type + group. */
type ReconstructedWindow = {
  id: string;
  name: string;
  index: number;
  active: boolean;
  windowType: string | null;
  groupPanes: string[] | null;
  floatDrawer: string | null;
};
const windows = (): ReconstructedWindow[] =>
  (
    window as unknown as { app: { getSnapshot(): { context: { windows: ReconstructedWindow[] } } } }
  ).app.getSnapshot().context.windows;

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application',
  component: V86AppHarness,
  tags: ['v86'],
  // Share one v86 engine across every story in this group: the first story cold-
  // boots (~5s), the rest restore the pinned snapshot (~1s) for an isolated clean
  // start. Switching stories in the Storybook UI is near-instant as a result.
  args: { shared: true },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The entire TmuxyApp rendered against real tmux (v86 + tmuxy-core WASM). Interact live; the state is reconstructed by the real Rust engine.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof V86AppHarness>;

/**
 * The restored snapshot has a live 2-pane session; the real UI renders it,
 * including the **active-pane style** (`.pane-active`) and the **terminal
 * cursor** — both driven by the active window/pane the Rust WASM core
 * reconstructs from the initial list-panes/list-windows sync.
 */
export const Live: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      () => {
        const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
        expect(panes.length).toBeGreaterThanOrEqual(2);
        for (const pane of panes) {
          const rect = pane.getBoundingClientRect();
          expect(rect.width).toBeGreaterThan(0);
          expect(rect.height).toBeGreaterThan(0);
        }
      },
      { timeout: 45000, interval: 500 },
    );
    // Exactly one pane is styled active, and its cursor is rendered.
    await waitFor(
      () => {
        expect(canvasElement.querySelectorAll('.pane-active').length).toBe(1);
        expect(canvasElement.querySelectorAll('.terminal-cursor').length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 15000, interval: 500 },
    );
  },
};

/**
 * Mouse: clicking an inactive pane selects it — the active-pane style and cursor
 * move to the clicked pane (a `select-pane` round-trip through real tmux).
 */
export const MouseSelectPane: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const getActive = () =>
      (
        window as unknown as { app: { getSnapshot(): { context: { activePaneId: string } } } }
      ).app.getSnapshot().context.activePaneId;
    await waitFor(
      () =>
        expect(canvas.getAllByRole('group', { name: /^Pane %/i }).length).toBeGreaterThanOrEqual(2),
      { timeout: 45000, interval: 500 },
    );
    await waitFor(() => expect(getActive()).toBeTruthy(), { timeout: 10000 });
    const initial = getActive();
    const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
    // Click the pane that isn't currently active.
    const target =
      panes.find((p: HTMLElement) => p.getAttribute('data-pane-id') !== initial) ?? panes[0];
    await userEvent.click(target);
    await waitFor(() => expect(getActive()).not.toBe(initial), { timeout: 10000, interval: 300 });
  },
};

/**
 * Keyboard with the tmuxy default keybindings (C-a prefix): pressing the prefix
 * then `c` (new-window) runs the mapped command through real tmux and a new
 * window tab appears.
 */
export const PrefixKeybinding: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const prefixActive = () =>
      (
        window as unknown as { app: { getSnapshot(): { context: { prefixActive?: boolean } } } }
      ).app.getSnapshot().context.prefixActive === true;
    await waitFor(
      () =>
        expect(canvas.getAllByRole('group', { name: /^Pane %/i }).length).toBeGreaterThanOrEqual(2),
      { timeout: 45000, interval: 500 },
    );
    await user.click(canvas.getAllByRole('group', { name: /^Pane %/i })[0]);
    // C-a (the tmuxy prefix) must arm prefix mode…
    await user.keyboard('{Control>}a{/Control}');
    await waitFor(() => expect(prefixActive()).toBe(true), { timeout: 5000, interval: 200 });
    // …and the next mapped key (c = new-window) consumes it.
    await user.keyboard('c');
    await waitFor(() => expect(prefixActive()).toBe(false), { timeout: 5000, interval: 200 });
  },
};

/** Real `split-window` commands issued at startup produce real extra panes. */
export const Splits: Story = {
  args: { height: 600, initCommands: ['split-window -v'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      () => {
        const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
        expect(panes.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 45000, interval: 500 },
    );
  },
};

/**
 * Keyboard split (regression): pressing the prefix then `-` runs the mapped
 * `split-window -v` through real tmux and a third pane appears. The keyboardActor
 * pins the command to the active pane with a `select-pane -t %N \; split-window`
 * compound; the adapter must translate the shell-escaped `\;` separator to the
 * bare `;` control-mode wants — otherwise the split silently errors and the
 * app's optimistic placeholder pane never reconciles, freezing the UI. This
 * asserts the split completes and the active pane is a real pane (not a stuck
 * `__placeholder_op_*`).
 */
export const KeyboardSplit: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('-');
    await waitFor(
      () => {
        expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(3);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Interactive: click a pane and TYPE a command on the keyboard — the keystrokes
 * flow keyboardActor → `send-keys` → real tmux in v86 → bash, and the output is
 * re-rendered from the live `%output` stream via the Rust WASM core. Proves the
 * tmuxy UI is genuinely interactive client-side (not a static render).
 */
export const Interactive: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('echo STORY_INTERACT');
    // The echoed output must appear in the active pane (rendered from live
    // %output). Keystrokes route to whichever pane tmux has active, so accept a
    // match in any pane.
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /STORY_INTERACT/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 25000, interval: 500 },
    );
  },
};

/**
 * Runs real commands in real bash and drives the real **tmuxy CLI** inside the
 * guest — exactly like server-side mode, but fully client-side. We enter a
 * `tmuxy pane split` command into the focused pane's bash; the CLI runs in-guest
 * and routes the split through `tmux run-shell`, and the resulting new pane shows
 * up in the tmuxy UI (reconstructed by the Rust WASM core).
 */
export const TmuxyCli: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const before = paneGroups(canvas).length;
    pasteLine('tmuxy pane split');
    // The new pane created by the CLI must show up in the UI (reconstructed by
    // the Rust WASM core from the live control-mode stream).
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThan(before), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Float: `tmuxy pane float` breaks a pane into its own window tagged
 * `@tmuxy-window-type=float` (plus float geometry options), all in one atomic
 * tmux command list. The WASM core reconstructs that window type from the
 * list-windows metadata, and the UI renders it as a centered overlay — a real
 * `.float-container` painted above the active tab.
 */
export const Float: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('tmuxy pane float');
    // The core must reconstruct a float-typed window…
    await waitFor(() => expect(windows().some((w) => w.windowType === 'float')).toBe(true), {
      timeout: 30000,
      interval: 500,
    });
    // …and the UI must paint it as a visible overlay. The float overlay layer
    // mounts at the document root (above the story root), so query the document.
    await waitFor(
      () => {
        const overlay = canvasElement.ownerDocument.querySelector('.float-container');
        expect(overlay).not.toBeNull();
        const rect = (overlay as HTMLElement).getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.height).toBeGreaterThan(0);
      },
      { timeout: 15000, interval: 500 },
    );
  },
};

/**
 * Drawer / sidebar: `tmuxy pane float --left` creates a float in drawer mode,
 * tagging its window `@tmuxy-float-drawer=left` alongside `@tmuxy-window-type=
 * float`. The WASM core must reconstruct that drawer direction from the live
 * list-windows metadata — the client-side path that drives the UI's edge-docked
 * drawer (the same mechanism as the left sidebar).
 */
export const Drawer: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('tmuxy pane float --left');
    await waitFor(
      () =>
        expect(windows().some((w) => w.windowType === 'float' && w.floatDrawer === 'left')).toBe(
          true,
        ),
      { timeout: 40000, interval: 500 },
    );
    // Drawer floats paint as an edge-docked drawer (NOT a centered
    // .float-container modal) once the drawer metadata lands.
    await waitFor(
      () => {
        const el = canvasElement.ownerDocument.querySelector('.drawer-left') as HTMLElement | null;
        expect(el).not.toBeNull();
        expect(el!.getBoundingClientRect().width).toBeGreaterThan(0);
      },
      { timeout: 20000, interval: 500 },
    );
  },
};

/**
 * Pane group: `tmuxy pane group add` splits a pane and breaks it into a group
 * window tagged `@tmuxy-window-type=group` with `@tmuxy-group-panes` listing the
 * grouped pane ids — one atomic tmux command list. The WASM core reconstructs
 * the group membership the UI uses to render grouped panes as header tabs.
 */
export const PaneGroup: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('tmuxy pane group add');
    // A group window with ≥2 member panes must be reconstructed from the live
    // list-windows metadata by the real Rust engine.
    await waitFor(
      () =>
        expect(
          windows().some((w) => w.windowType === 'group' && (w.groupPanes?.length ?? 0) >= 2),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Widget: piping content to `tmuxy widget markdown -` prints a
 * `__TMUXY_WIDGET__:markdown` marker into the pane's output; the UI detects it
 * and swaps the terminal renderer for the real markdown **widget component**
 * (`.widget-markdown`) — all client-side, driven by the live %output stream.
 */
export const Widget: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine("echo '# HELLO_WIDGET' | tmuxy widget markdown -");
    // The widget pane must mount and show the content we piped in. (The pre-built
    // boot snapshot predates the stdin-mode raw-markdown fix in
    // bin/tmuxy/tmuxy-widget-markdown, so older snapshots wrap it in a meta block;
    // either way the widget mounts and the text is present.)
    await waitFor(
      () => {
        const widget = canvasElement.ownerDocument.querySelector('.widget-markdown');
        expect(widget).not.toBeNull();
        expect(widget?.textContent ?? '').toContain('HELLO_WIDGET');
      },
      { timeout: 40000, interval: 500 },
    );
  },
};

/** A 1×1 PNG, base64 — small enough to inline in an iTerm2 image escape. */
const INLINE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Terminal images: the guest prints a real **iTerm2 inline-image** escape
 * (`ESC ]1337;File=inline=1:<base64> BEL`). The WASM core's image parser decodes
 * the payload into the pane's image store; the Terminal renders it as an `<img>`
 * whose `src` is resolved client-side via `window.__tmuxyImageSrc` (a `data:` URL
 * straight from the Rust store — no server, no `/api/images`).
 */
export const TerminalImage: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine(`printf '\\033]1337;File=inline=1:${INLINE_PNG_B64}\\a'`);
    await waitFor(
      () =>
        expect(
          canvasElement.ownerDocument.querySelector('img[src^="data:image/png"]'),
        ).not.toBeNull(),
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * OSC 52 clipboard: the guest prints an `ESC ]52;c;<base64> BEL` escape. The
 * WASM core decodes it into a `WriteClipboard` effect, the adapter forwards it to
 * its clipboard listeners, and the appMachine mirrors it into the system
 * clipboard via `navigator.clipboard.writeText`. We stub `writeText` to capture
 * the round-trip end to end.
 */
export const ClipboardOsc52: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    // Stub the SAME global navigator the appMachine reads at event time. Do this
    // AFTER the app has connected — stubbing before connect lets app init
    // re-establish navigator.clipboard and drop the stub.
    const writes: string[] = [];
    const stub = {
      writeText: (t: string) => (writes.push(t), Promise.resolve()),
      readText: () => Promise.resolve(''),
    };
    const nav = window.navigator as unknown as {
      clipboard?: { writeText?: (t: string) => Promise<void> };
    };
    try {
      Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: stub });
    } catch {
      if (nav.clipboard) nav.clipboard.writeText = stub.writeText;
    }
    // base64('HELLO_CLIP') === 'SEVMTE9fQ0xJUA=='
    pasteLine("printf '\\033]52;c;SEVMTE9fQ0xJUA==\\a'");
    await waitFor(() => expect(writes).toContain('HELLO_CLIP'), { timeout: 40000, interval: 500 });
  },
};

/**
 * Themes: the client fetches the bundled theme list on connect (populating the
 * theme picker) and loads the active theme stylesheet from `/themes/<name>.css`.
 * Switching mode flips the `theme-dark`/`theme-light` class on the document root,
 * which swaps the CSS variables the whole UI is painted from. Asserts the list is
 * populated, the stylesheet is loaded, and a real theme variable changes value.
 */
export const Theme: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doc = canvasElement.ownerDocument;
    const html = doc.documentElement;
    const app = (
      window as unknown as {
        app: {
          send(e: { type: string; mode: string }): void;
          getSnapshot(): { context: { availableThemes: unknown[] } };
        };
      }
    ).app;
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(2), {
      timeout: 45000,
      interval: 500,
    });
    // The theme picker list is populated from the bundled themes…
    await waitFor(
      () => expect(app.getSnapshot().context.availableThemes.length).toBeGreaterThan(0),
      {
        timeout: 15000,
        interval: 500,
      },
    );
    // …and the active theme stylesheet is actually loaded. The app injects
    // the `#tmuxy-theme` <link> during its theme init on connect, which can
    // land a beat after the panes render — wait for it rather than assume it
    // already exists (e.g. on a fresh page load with no prior story's link).
    await waitFor(
      () =>
        expect(doc.getElementById('tmuxy-theme')?.getAttribute('href') ?? '').toMatch(
          /\/themes\/.+\.css$/,
        ),
      { timeout: 15000, interval: 300 },
    );
    const bg = () => getComputedStyle(html).getPropertyValue('--term-background').trim();
    app.send({ type: 'SET_THEME_MODE', mode: 'light' });
    await waitFor(
      () => {
        expect(html.classList.contains('theme-light')).toBe(true);
        expect(bg()).toBe('#fafafa');
      },
      { timeout: 5000, interval: 200 },
    );
    app.send({ type: 'SET_THEME_MODE', mode: 'dark' });
    await waitFor(
      () => {
        expect(html.classList.contains('theme-dark')).toBe(true);
        expect(bg()).toBe('#000000');
      },
      { timeout: 5000, interval: 200 },
    );
  },
};

/**
 * Real keybindings — Ctrl+hjkl pane navigation: the keyboardActor intercepts the
 * Ctrl+h/j/k/l root bindings client-side and issues directional `select-pane`
 * commands to real tmux (so C-h moves the active pane left, NOT a literal
 * backspace into the shell). Drives real Ctrl-key presses and asserts the active
 * pane moves.
 */
export const PaneNavKeys: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, userEvent.setup());
    // Start on the right pane, then Ctrl+h must move the active pane left.
    const right = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') !== activePaneId(),
    );
    const rightId = right?.getAttribute('data-pane-id');
    await user.click(right ?? paneGroups(canvas)[0]);
    await waitFor(() => expect(activePaneId()).toBe(rightId), { timeout: 15000, interval: 200 });
    await user.keyboard('{Control>}h{/Control}');
    await waitFor(() => expect(activePaneId()).not.toBe(rightId), {
      timeout: 15000,
      interval: 300,
    });
    const leftId = activePaneId();
    // Ctrl+l moves back to the right.
    await user.keyboard('{Control>}l{/Control}');
    await waitFor(() => expect(activePaneId()).not.toBe(leftId), { timeout: 15000, interval: 300 });
  },
};

/** Reconstructed pane widths (in columns) from the live state. */
const paneCols = (): number[] =>
  (window as unknown as { app: { getSnapshot(): { context: { panes: { width: number }[] } } } }).app
    .getSnapshot()
    .context.panes.map((p) => p.width);

const sessionName = (): string =>
  (
    window as unknown as { app: { getSnapshot(): { context: { sessionName: string } } } }
  ).app.getSnapshot().context.sessionName;

/**
 * Resize: shrinking the client container fires the app's ResizeObserver, which
 * issues `refresh-client -C <cols>x<rows>` to real tmux. tmux re-lays out and
 * reports narrower panes over the control stream, and the WASM core reconstructs
 * the reduced column counts — a full client→tmux→client resize round-trip.
 */
export const Resize: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(2), {
      timeout: 45000,
      interval: 500,
    });
    // Let the initial size settle, then record the widest pane.
    await waitFor(() => expect(Math.max(...paneCols())).toBeGreaterThan(40), {
      timeout: 15000,
      interval: 500,
    });
    const before = Math.max(...paneCols());
    const harness = canvasElement.firstElementChild as HTMLElement;
    harness.style.width = '480px';
    await waitFor(() => expect(Math.max(...paneCols())).toBeLessThan(before), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Reconnect / fatal: when the control channel drops, the adapter signals a
 * reconnection and the app surfaces the `.connection-status-reconnecting`
 * indicator; when it recovers, the indicator clears. We drive the same
 * reconnection lifecycle events the adapter emits (`TMUX_RECONNECTING` →
 * `TMUX_RECONNECTED`) on the live client and assert the UI reflects each phase.
 */
export const Reconnect: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doc = canvasElement.ownerDocument;
    const app = (
      window as unknown as { app: { send(e: { type: string; attempt?: number }): void } }
    ).app;
    // Connected first: panes render and no reconnecting indicator is shown.
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(2), {
      timeout: 45000,
      interval: 500,
    });
    expect(doc.querySelector('.connection-status-reconnecting')).toBeNull();
    // Channel drops → reconnecting indicator appears.
    app.send({ type: 'TMUX_RECONNECTING', attempt: 1 });
    await waitFor(
      () => expect(doc.querySelector('.connection-status-reconnecting')).not.toBeNull(),
      {
        timeout: 10000,
        interval: 200,
      },
    );
    // Channel recovers → indicator clears.
    app.send({ type: 'TMUX_RECONNECTED' });
    await waitFor(() => expect(doc.querySelector('.connection-status-reconnecting')).toBeNull(), {
      timeout: 10000,
      interval: 200,
    });
  },
};

/**
 * Sessions: create a second tmux session in the guest, then switch the attached
 * control client to it (`SWITCH_SESSION` → real `switch-client -t` + a fresh
 * list-panes/list-windows sync). The WASM core reconstructs the new session and
 * the app's `sessionName` reflects the switch.
 */
export const Sessions: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const original = sessionName();
    // Create a detached second session inside the guest.
    pasteLine('tmux new-session -d -s work');
    await new Promise((r) => setTimeout(r, 2000));
    // Switch the control client to it through the real app machine.
    (
      window as unknown as { app: { send(e: { type: string; sessionName: string }): void } }
    ).app.send({
      type: 'SWITCH_SESSION',
      sessionName: 'work',
    });
    await waitFor(() => expect(sessionName()).toBe('work'), { timeout: 30000, interval: 500 });
    expect(sessionName()).not.toBe(original);
  },
};

/**
 * Throughput: a burst of terminal output (`seq 1 200`) streams through the
 * byte-paced serial writer and the WASM core's %output handling without dropping
 * or corrupting bytes — the last line of the burst must render intact. Guards the
 * high-rate path the earlier per-byte serial fix addressed.
 */
export const Throughput: Story = {
  args: { height: 600 },
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
  args: { height: 600 },
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

// ───────────────────────── §2 Pane operations ─────────────────────────

/** Bounding rect of a pane by tmux id (throws if absent — assert presence first). */
function paneRect(canvas: Canvas, id: string): DOMRect {
  const el = paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id);
  if (!el) throw new Error(`pane ${id} not rendered`);
  return el.getBoundingClientRect();
}

const paneIds = (canvas: Canvas): string[] =>
  paneGroups(canvas).map((p: HTMLElement) => p.getAttribute('data-pane-id') ?? '');

/**
 * Horizontal split: C-a `|` runs the mapped `split-window -h` through real tmux.
 * The two children of the split must share a row — same top, different left —
 * per the geometry tmux reports in `%layout-change` (we assert rendered rects,
 * not client-computed values).
 */
export const KeyboardSplitHorizontal: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const target = activePaneId();
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('|');
    await waitFor(
      () => {
        expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(3);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
    // The split pane and the new pane share a row: same top, different left.
    const a = paneRect(canvas, target);
    const b = paneRect(canvas, activePaneId());
    expect(Math.abs(a.top - b.top)).toBeLessThan(4);
    expect(a.left).not.toBe(b.left);
  },
};

/**
 * Kill pane via keyboard: C-a `x` kills the active pane in real tmux. Asserts the
 * doomed pane id is GONE (negative guard — "count changed" alone could pass on an
 * unrelated pane appearing) and focus lands on a surviving real pane.
 */
export const KillPane: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doomed = activePaneId();
    expect(doomed).toMatch(/^%\d+$/);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('x');
    await waitFor(
      () => {
        expect(paneIds(canvas)).not.toContain(doomed);
        expect(activePaneId()).toMatch(/^%\d+$/);
        expect(activePaneId()).not.toBe(doomed);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Kill pane via the header ✕ button — pure mouse path through PaneHeader's
 * group-aware CLOSE_PANE (not raw kill-pane). The clicked pane's id must vanish.
 */
export const KillPaneViaHeaderButton: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doomed = paneIds(canvas)[0];
    const paneEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === doomed,
    )!;
    const closeBtn = paneEl.querySelector('[aria-label="Close pane"]') as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    await user.click(closeBtn!);
    await waitFor(() => expect(paneIds(canvas)).not.toContain(doomed), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Zoom: C-a `z` (resize-pane -Z). The active pane's rendered width must expand to
 * ~the full container (tmux reports the zoomed layout via %layout-change); C-a `z`
 * again restores the original width. Both directions asserted — a stuck zoom or a
 * no-op both fail.
 */
export const ZoomPane: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await settleGeometry(canvas);
    const id = activePaneId();
    const before = paneRect(canvas, id).width;
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('z');
    await waitFor(() => expect(paneRect(canvas, id).width).toBeGreaterThan(before * 1.5), {
      timeout: 30000,
      interval: 500,
    });
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('z');
    await waitFor(() => expect(Math.abs(paneRect(canvas, id).width - before)).toBeLessThan(20), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Zoom via header double-click: double-clicking a pane's header dispatches
 * ZOOM_PANE → the same real `resize-pane -Z` round-trip as `C-a z`, driven
 * purely by mouse. Both directions of the toggle asserted via layout rects.
 */
export const ZoomViaHeaderDoubleClick: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await settleGeometry(canvas);
    const id = activePaneId();
    const before = paneRect(canvas, id).width;
    const header = () =>
      paneGroups(canvas)
        .find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!
        .querySelector('.pane-header') as HTMLElement;
    await user.dblClick(header());
    await waitFor(() => expect(paneRect(canvas, id).width).toBeGreaterThan(before * 1.5), {
      timeout: 30000,
      interval: 500,
    });
    await user.dblClick(header());
    await waitFor(() => expect(Math.abs(paneRect(canvas, id).width - before)).toBeLessThan(20), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Swap: C-a `>` (swap-pane -D) exchanges the two panes' positions. We record which
 * id is leftmost before, and assert the OTHER id is leftmost after — position data
 * comes from the real re-reported layout.
 */
export const SwapPanes: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const [a, b] = paneIds(canvas);
    const leftBefore = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('>');
    await waitFor(
      () => {
        const leftNow = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
        expect(leftNow).not.toBe(leftBefore);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Drag a pane onto another to swap them: mousedown on the source header, move
 * past the drag threshold onto the target pane, release. The drag machine
 * issues a real `swap-pane -d -s <src> -t <target>` on drop, and the two panes
 * must exchange positions in the re-reported layout — the same assert as the
 * keyboard SwapPanes, driven purely by mouse drag-and-drop.
 */
export const PaneDragSwap: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const [a, b] = paneIds(canvas);
    const src = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
    const dst = src === a ? b : a;
    const header = paneGroups(canvas)
      .find((p: HTMLElement) => p.getAttribute('data-pane-id') === src)!
      .querySelector('.pane-header') as HTMLElement;
    const hRect = header.getBoundingClientRect();
    const dstRect = paneRect(canvas, dst);
    const startX = hRect.left + hRect.width / 2;
    const startY = hRect.top + hRect.height / 2;
    const endX = dstRect.left + dstRect.width / 2;
    const endY = dstRect.top + dstRect.height / 2;
    header.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: startX, clientY: startY, bubbles: true }),
    );
    // Walk the pointer to the target: the first steps cross the 5px threshold
    // (PaneHeader promotes the press to DRAG_START), later ones feed DRAG_MOVE
    // so the drag machine picks the drop target under the cursor. Events are
    // dispatched on elements (bubbling to the document/window listeners) so
    // handlers that inspect `event.target` see a real element.
    const dstEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === dst,
    )!;
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const x = startX + ((endX - startX) * i) / steps;
      const y = startY + ((endY - startY) * i) / steps;
      (i <= 2 ? header : dstEl).dispatchEvent(
        new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }),
      );
      await new Promise((r) => setTimeout(r, 120));
    }
    dstEl.dispatchEvent(new MouseEvent('mouseup', { clientX: endX, clientY: endY, bubbles: true }));
    await waitFor(
      () => {
        const leftNow = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
        expect(leftNow).not.toBe(src);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Keyboard resize: C-a `H` (resize-pane -L 5). The active pane's rendered width
 * must change by roughly 5 columns and STICK (re-checked after settling) — the new
 * geometry comes from tmux's %layout-change, not a client-side prediction.
 */
export const ResizePaneKeyboard: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await settleGeometry(canvas);
    const id = activePaneId();
    const before = paneRect(canvas, id).width;
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('{Shift>}H{/Shift}');
    await waitFor(() => expect(Math.abs(paneRect(canvas, id).width - before)).toBeGreaterThan(20), {
      timeout: 30000,
      interval: 500,
    });
    // The resize must persist (a transient optimistic wiggle that snaps back
    // fails). Let the trailing layout confirms settle first — H is a repeat
    // binding whose confirms can land a beat after the rect first moves.
    await settleGeometry(canvas);
    const resized = paneRect(canvas, id).width;
    await new Promise((r) => setTimeout(r, 1500));
    expect(Math.abs(paneRect(canvas, id).width - resized)).toBeLessThan(10);
  },
};

/**
 * Drag resize: mouse-drag the invisible `.resize-divider` between the two panes.
 * Pane widths must change and STICK after mouseup — i.e. tmux accepted the
 * resize-pane commands the drag generated (asserting only during-drag state would
 * pass on a pure client-side ghost).
 */
export const ResizePaneDrag: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    await settleGeometry(canvas);
    const [a] = paneIds(canvas);
    const before = paneRect(canvas, a).width;
    const divider = canvasElement.querySelector('.resize-divider') as HTMLElement | null;
    expect(divider).not.toBeNull();
    const r = divider!.getBoundingClientRect();
    const startX = r.left + r.width / 2;
    const startY = r.top + r.height / 2;
    const doc = canvasElement.ownerDocument;
    divider!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: startY, button: 0 }),
    );
    for (let dx = 10; dx <= 80; dx += 10) {
      doc.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: startX + dx, clientY: startY }),
      );
      await new Promise((res) => setTimeout(res, 30));
    }
    doc.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, clientX: startX + 80, clientY: startY }),
    );
    // Width changed AND persists after the tmux round-trip settles.
    await waitFor(() => expect(Math.abs(paneRect(canvas, a).width - before)).toBeGreaterThan(30), {
      timeout: 30000,
      interval: 500,
    });
    // Let the trailing per-command layout confirms land, THEN record: once
    // the geometry has settled, the layout must not move again (a late
    // confirm re-wiggling panes is the user-visible resize glitch).
    await settleGeometry(canvas);
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    const after = paneRect(canvas, a).width;
    await new Promise((res) => setTimeout(res, 2000));
    expect(Math.abs(paneRect(canvas, a).width - after)).toBeLessThan(10);
    glitches.assertNoGlitches('resize');
  },
};

/**
 * Break pane: `tmuxy pane break` (guest CLI, run in real bash) moves the pane into
 * its own window. A second window tab must appear, backed by a real `@N` id.
 */
export const BreakPane: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const tabsBefore = windows().filter((w) => w.windowType === 'tab').length;
    pasteLine('tmuxy pane break');
    await waitFor(
      () =>
        expect(windows().filter((w) => w.windowType === 'tab').length).toBeGreaterThan(tabsBefore),
      { timeout: 30000, interval: 500 },
    );
    // The tab bar renders the new window as a real tab.
    await waitFor(() => expect(canvas.getAllByRole('tab').length).toBeGreaterThan(tabsBefore), {
      timeout: 15000,
      interval: 500,
    });
  },
};

/**
 * Pane context menu: right-click a pane's header tab → the context menu opens;
 * clicking "Split Pane Below" runs the real split. Drives the actual menu item,
 * not the underlying event, and asserts a real new pane id.
 */
export const PaneContextMenuSplit: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const before = paneGroups(canvas).length;
    const headerTab = canvasElement.querySelector('.pane-tab') as HTMLElement | null;
    expect(headerTab).not.toBeNull();
    const hr = headerTab!.getBoundingClientRect();
    headerTab!.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: hr.left + 5,
        clientY: hr.top + 5,
      }),
    );
    const doc = canvasElement.ownerDocument;
    let item: HTMLElement | undefined;
    await waitFor(
      () => {
        item = [...doc.querySelectorAll('[role=menuitem]')].find((m) =>
          /Split Pane Below/i.test(m.textContent ?? ''),
        ) as HTMLElement | undefined;
        expect(item).toBeTruthy();
      },
      { timeout: 10000, interval: 300 },
    );
    await user.click(item!);
    await waitFor(
      () => {
        expect(paneGroups(canvas).length).toBeGreaterThan(before);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Special keys: Ctrl+C must reach the guest process as SIGINT. We start a
 * `sleep 100`, interrupt it, and run another command — the second command's output
 * can only render if the interrupt actually killed the sleep.
 */
export const SendSpecialKeys: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('sleep 100');
    await new Promise((r) => setTimeout(r, 1500));
    await user.keyboard('{Control>}c{/Control}');
    await new Promise((r) => setTimeout(r, 800));
    pasteLine('echo AFTER_INT_77');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /AFTER_INT_77/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Sync panes: C-a `S` toggles `synchronize-panes` in real tmux — typed input then
 * mirrors into every pane of the window. We paste a sentinel with sync ON (must
 * render in BOTH panes) and another after toggling OFF (must render in exactly
 * one) — the negative half guards against a stuck toggle.
 */
export const SyncPanes: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const inPanes = (re: RegExp) =>
      paneGroups(canvas).filter((p: HTMLElement) => re.test(p.textContent ?? '')).length;
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('{Shift>}S{/Shift}');
    await new Promise((r) => setTimeout(r, 1200));
    pasteLine('echo SYNC_ON_42');
    await waitFor(() => expect(inPanes(/SYNC_ON_42/)).toBe(2), { timeout: 30000, interval: 500 });
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('{Shift>}S{/Shift}');
    await new Promise((r) => setTimeout(r, 1200));
    pasteLine('echo SYNC_OFF_42');
    await waitFor(() => expect(inPanes(/SYNC_OFF_42/)).toBe(1), { timeout: 30000, interval: 500 });
    // Give the mirror a beat, then confirm it STAYED in one pane (not just raced).
    await new Promise((r) => setTimeout(r, 1500));
    expect(inPanes(/SYNC_OFF_42/)).toBe(1);
  },
};

// ───────────────────────── §3 Window / tab lifecycle ─────────────────────────

const activeWindow = (): ReconstructedWindow | undefined => windows().find((w) => w.active);
const tabWindows = (): ReconstructedWindow[] => windows().filter((w) => w.windowType === 'tab');
// Real (tmux-confirmed) tab windows only — optimistic placeholder windows carry
// non-@ ids until reconciled and must not satisfy a "window created" assertion.
const realTabWindows = (): ReconstructedWindow[] => tabWindows().filter((w) => /^@\d+$/.test(w.id));
// WindowTabs bar entries only (pane-header tabs are also role=tab; the window
// tabs are distinguishable by their "Tab N: name" accessible name).
const windowTabEls = (canvas: Canvas) => canvas.getAllByRole('tab', { name: /^Tab \d+:/ });

/**
 * New window via keyboard: C-a `c` (new-window) — real tmux creates a new `@N`
 * window, the tab bar renders it, and it becomes the active window with a real
 * focused pane.
 */
export const TabCreateKeyboard: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const beforeIds = realTabWindows().map((w) => w.id);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('c');
    await waitFor(
      () => {
        const tabs = realTabWindows();
        expect(tabs.length).toBe(beforeIds.length + 1);
        const created = tabs.find((w) => !beforeIds.includes(w.id))!;
        expect(created.active).toBe(true);
        expect(activePaneId()).toMatch(/^%\d+$/);
        // Rendered in the tab bar too.
        expect(windowTabEls(canvas).length).toBe(tabs.length);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * New window via the tab bar `+` button — pure mouse path through WindowTabs'
 * handleNewWindow. Same round-trip assertions as the keyboard variant.
 */
export const TabCreateViaPlusButton: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const before = realTabWindows().length;
    await user.click(canvas.getByLabelText('Create new tab'));
    await waitFor(
      () => {
        expect(realTabWindows().length).toBe(before + 1);
        expect(activeWindow()?.id).toMatch(/^@\d+$/);
        expect(windowTabEls(canvas).length).toBe(before + 1);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Tab selection: with two windows, clicking a tab header selects that window
 * (mouse path), and Ctrl+digit selects by index (root-binding path). The active
 * window AND the rendered pane set must swap each time — asserting the pane swap
 * proves the full re-render, not just a highlight change.
 */
export const TabSelect: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy tab create');
    await waitFor(() => expect(tabWindows().length).toBe(2), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 30000, interval: 500 });
    const panesOnW2 = paneIds(canvas).join(',');
    // Mouse: click the first WINDOW tab header (not a pane-header tab).
    await user.click(windowTabEls(canvas)[0]);
    await waitFor(
      () => {
        expect(activeWindow()?.index).toBe(1);
        expect(paneIds(canvas).join(',')).not.toBe(panesOnW2);
      },
      { timeout: 20000, interval: 500 },
    );
    // Keyboard: Ctrl+2 selects window index 2 again.
    await user.keyboard('{Control>}2{/Control}');
    await waitFor(
      () => {
        expect(activeWindow()?.index).toBe(2);
        expect(paneIds(canvas).join(',')).toBe(panesOnW2);
      },
      { timeout: 20000, interval: 500 },
    );
  },
};

/**
 * Tab cycling: S-Right (next-window) and S-Left (previous-window) root bindings.
 * With two windows each press flips the active window, including the wrap.
 */
export const TabNextPrev: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy tab create');
    await waitFor(() => expect(tabWindows().length).toBe(2), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 30000, interval: 500 });
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await waitFor(() => expect(activeWindow()?.index).toBe(1), { timeout: 20000, interval: 500 });
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 20000, interval: 500 });
  },
};

/**
 * Tab rename: `tmuxy tab rename` in guest bash → tmux emits %window-renamed → the
 * tab label updates. Asserting via the rendered tab (accessible name) proves the
 * name came back from real tmux, not local state.
 */
export const TabRename: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('tmuxy tab rename STORY_TAB9');
    await waitFor(() => expect(canvas.getByRole('tab', { name: /STORY_TAB9/ })).toBeTruthy(), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Kill window: create a second tab, then C-a `&` (kill-window) removes it — that
 * `@N` must be GONE (negative guard) and focus must land on the surviving tab.
 */
export const TabKill: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy tab create');
    await waitFor(() => expect(tabWindows().length).toBe(2), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 30000, interval: 500 });
    const doomed = activeWindow()!.id;
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('{Shift>}&{/Shift}');
    await waitFor(
      () => {
        expect(tabWindows().map((w) => w.id)).not.toContain(doomed);
        expect(activeWindow()?.id).toMatch(/^@\d+$/);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Layout cycle: with 3 panes, C-a Space (next-layout) rearranges them — the rect
 * signature (id→x,y,w) must actually change, and the geometry comes from tmux's
 * %layout-change, not a client-side shuffle.
 */
export const LayoutCycle: Story = {
  args: { height: 600, initCommands: ['split-window -v'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(3), {
      timeout: 45000,
      interval: 500,
    });
    await focusFirstPane(canvas, user);
    const signature = () =>
      paneGroups(canvas)
        .map((p: HTMLElement) => {
          const r = p.getBoundingClientRect();
          return `${p.getAttribute('data-pane-id')}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}`;
        })
        .sort()
        .join('|');
    const before = signature();
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard(' ');
    await waitFor(() => expect(signature()).not.toBe(before), { timeout: 30000, interval: 500 });
    // All panes still visible after the re-layout.
    for (const p of paneGroups(canvas)) {
      const r = (p as HTMLElement).getBoundingClientRect();
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }
    glitches.assertNoGlitches('layoutCycle');
  },
};

/**
 * Tab overflow: create several windows via the guest CLI; every tab renders in
 * the tab bar and the LAST one is still clickable (selects its window).
 */
export const WindowTabsOverflow: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('for i in 1 2 3 4 5; do tmuxy tab create >/dev/null; done; echo TABS_DONE_5');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /TABS_DONE_5/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 60000, interval: 700 },
    );
    await waitFor(() => expect(realTabWindows().length).toBe(6), { timeout: 30000, interval: 500 });
    expect(windowTabEls(canvas).length).toBe(6);
    // The last tab is reachable and clickable.
    const tabs = windowTabEls(canvas);
    await user.click(tabs[tabs.length - 1]);
    await waitFor(() => expect(activeWindow()?.index).toBe(6), { timeout: 20000, interval: 500 });
  },
};

// ───────────────────────── §4 Copy mode & scrollback ─────────────────────────

/** tmux-reported scrollback size of a pane (drives the wheel handler's gate). */
const paneHistory = (id: string): number =>
  (
    window as unknown as {
      app: { getSnapshot(): { context: { panes: { tmuxId: string; historySize: number }[] } } };
    }
  ).app
    .getSnapshot()
    .context.panes.find((p) => p.tmuxId === id)?.historySize ?? 0;

/** tmux-reported copy-mode state of a pane (inMode comes from %pane-mode-changed). */
const paneMode = (id: string): boolean =>
  (
    window as unknown as {
      app: { getSnapshot(): { context: { panes: { tmuxId: string; inMode: boolean }[] } } };
    }
  ).app
    .getSnapshot()
    .context.panes.find((p) => p.tmuxId === id)?.inMode === true;

/**
 * Client-side copy-mode state of a pane — the restored scrollback engine keeps
 * loaded history lines, the scroll offset, and the selection in
 * `copyModeStates[paneId]` (see COPY-MODE.md). Undefined when not in copy mode.
 */
const paneCopyState = (
  id: string,
): { scrollTop: number; selectionMode: 'char' | 'line' | null; totalLines: number } | undefined =>
  (
    window as unknown as {
      app: {
        getSnapshot(): {
          context: {
            copyModeStates: Record<
              string,
              { scrollTop: number; selectionMode: 'char' | 'line' | null; totalLines: number }
            >;
          };
        };
      };
    }
  ).app.getSnapshot().context.copyModeStates[id];

/**
 * Copy mode enter: with real scrollback, C-a `[` enters copy mode — the client
 * intercepts `copy-mode`, initializes its scrollback engine, and forwards the
 * command so tmux flips `in_mode`. Asserted via the tmux-reported `inMode` AND
 * the rendered `[COPY MODE]` header indicator.
 */
export const CopyModeEnter: Story = {
  args: { height: 600 },
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
 * Copy mode scroll: entering copy mode renders scrollback in a natively-scrolling
 * container (the restored client-side engine — see COPY-MODE.md). Wheeling up
 * fetches history from tmux via `get_scrollback_cells` and scrolls the client
 * viewport back: earlier scrollback lines render, the client `scrollTop` moves
 * toward the top, and wheeling back to the bottom exits copy mode.
 */
export const CopyModeScrollAndYank: Story = {
  args: { height: 600 },
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
    // Wheel up: enters client copy mode and scrolls the ScrollbackTerminal back.
    await wheel(-120, 6, 250);
    await waitFor(() => expect(paneCopyState(id), 'client copy mode active').toBeTruthy(), {
      timeout: 15000,
      interval: 400,
    });
    // The rendered viewport shows earlier scrollback lines (100s, not the 199200 tail).
    await waitFor(() => expect(paneEl().textContent ?? '').toMatch(/1[0-9]\d(?!9200)/), {
      timeout: 15000,
      interval: 500,
    });
    // The client scroll offset moved off the bottom of history.
    const cs = paneCopyState(id);
    expect(cs && cs.scrollTop < cs.totalLines - 1).toBe(true);
    // Wheel back down to the bottom → copy mode exits.
    await wheel(120, 40, 100);
    await waitFor(() => expect(paneCopyState(id), 'copy mode exited at bottom').toBeFalsy(), {
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
  args: { height: 600 },
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

/**
 * Wheel scroll: real wheel events over a pane with scrollback enter copy mode
 * (the client raises ENTER_COPY_MODE and forwards `copy-mode`, so tmux reports
 * `inMode`) and scroll the client viewport to earlier lines; wheeling back down
 * to the bottom exits copy mode. All driven by WheelEvents on the pane, as a
 * real mouse would.
 */
export const WheelScrollEntersCopyMode: Story = {
  args: { height: 600 },
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
    // The wheel handler ignores scroll-up until the client knows the pane HAS
    // scrollback (historySize from list-panes) — wait for that, like a real user
    // who scrolls after seeing output settle.
    await waitFor(() => expect(paneHistory(id)).toBeGreaterThan(0), {
      timeout: 15000,
      interval: 400,
    });
    // Re-query the pane element fresh for every dispatch — React may replace the
    // node between renders, and a detached element's listeners never fire.
    const wheel = async (dy: number, times: number, gapMs: number) => {
      for (let i = 0; i < times; i++) {
        const el = paneGroups(canvas).find(
          (p: HTMLElement) => p.getAttribute('data-pane-id') === id,
        )!;
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, gapMs));
      }
    };
    await wheel(-120, 4, 250);
    await waitFor(() => expect(paneMode(id), 'copy mode entered by wheel-up').toBe(true), {
      timeout: 15000,
      interval: 400,
    });
    // Viewport scrolled back: an earlier region renders instead of the tail.
    await waitFor(
      () => {
        const el = paneGroups(canvas).find(
          (p: HTMLElement) => p.getAttribute('data-pane-id') === id,
        )!;
        expect(el.textContent ?? '').toMatch(/1[6-9]\d/);
      },
      { timeout: 15000, interval: 500 },
    );
    // Wheel back down to the bottom → copy mode exits.
    await wheel(120, 30, 100);
    await waitFor(() => expect(paneMode(id), 'copy mode exited at bottom').toBe(false), {
      timeout: 15000,
      interval: 500,
    });
  },
};

/**
 * Mouse drag selection: press-and-drag across pane content drives the restored
 * CLIENT-SIDE copy mode — the drag enters copy mode and builds a char selection
 * in `copyModeStates[paneId]` (rendered as `.terminal-selected` spans), without
 * a tmux round-trip: the drag enters copy mode and builds a char selection in
 * `copyModeStates[paneId]` (the text is then copyable via the right-click
 * selection menu — that clipboard path is covered by the OSC-52 story and the
 * `extractSelectedText` unit tests).
 */
export const CopyModeDragSelection: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const id = activePaneId();
    pasteLine('seq 1 50');
    await waitFor(
      () =>
        expect(paneGroups(canvas).some((p: HTMLElement) => /4950/.test(p.textContent ?? ''))).toBe(
          true,
        ),
      { timeout: 30000, interval: 500 },
    );
    const paneEl = () =>
      paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!;
    const rect = paneEl().getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const x0 = rect.left + 10;
    paneEl().dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: x0, clientY: y, bubbles: true }),
    );
    for (let i = 1; i <= 5; i++) {
      paneEl().dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: x0 + i * 30,
          clientY: y,
          buttons: 1,
          bubbles: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 150));
    }
    paneEl().dispatchEvent(
      new MouseEvent('mouseup', { button: 0, clientX: x0 + 150, clientY: y, bubbles: true }),
    );
    // The drag entered client-side copy mode and started a char selection —
    // no tmux round-trip; both live in copyModeStates[paneId].
    await waitFor(
      () => {
        expect(paneCopyState(id), 'drag entered client copy mode').toBeTruthy();
        expect(paneCopyState(id)?.selectionMode, 'drag started a char selection').toBe('char');
      },
      { timeout: 20000, interval: 400 },
    );
  },
};

// ─────────────── §5 Floats, groups, sidebar (deeper scenarios) ───────────────

/** Wait for the float overlay to render and return it. */
async function waitForFloat(doc: Document): Promise<HTMLElement> {
  let overlay: HTMLElement | null = null;
  await waitFor(
    () => {
      overlay = doc.querySelector('.float-container');
      expect(overlay).not.toBeNull();
      expect((overlay as HTMLElement).getBoundingClientRect().width).toBeGreaterThan(0);
    },
    { timeout: 30000, interval: 500 },
  );
  return overlay!;
}

/**
 * Float with options: `--width 40 --height 8 --hide-header` must produce a float
 * whose window metadata carries the option (`@tmuxy-float-noheader`), rendered as
 * a narrow overlay with NO header bar. The rendered size is measured, not
 * trusted from the CLI arguments.
 */
export const FloatWithOptions: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const harnessWidth = (canvasElement.firstElementChild as HTMLElement).getBoundingClientRect()
      .width;
    pasteLine('tmuxy pane float --width 40 --height 8 --hide-header');
    await waitFor(() => expect(windows().some((w) => w.windowType === 'float')).toBe(true), {
      timeout: 30000,
      interval: 500,
    });
    const overlay = await waitForFloat(canvasElement.ownerDocument);
    expect(overlay.getBoundingClientRect().width).toBeLessThan(harnessWidth + 1);
    // The size/header options round-trip as window metadata reconstructed by the
    // core; it rides the next list-windows sync — poll for it.
    await waitFor(
      () => {
        const fw = windows().find((w) => w.windowType === 'float') as
          | (ReconstructedWindow & { floatNoheader?: boolean })
          | undefined;
        expect(fw?.floatNoheader).toBe(true);
      },
      { timeout: 15000, interval: 500 },
    );
    // @tmuxy-float-width is authoritative for the RENDERED float: the overlay
    // must paint at the requested 40 columns even though the guest's
    // single-pane float window can't be shrunk by resize-pane. The re-render
    // follows the same metadata sync, so poll.
    await waitFor(
      () => {
        const expected = 40 * charWidthPx();
        expect(Math.abs(overlay.getBoundingClientRect().width - expected)).toBeLessThanOrEqual(
          charWidthPx(),
        );
      },
      { timeout: 15000, interval: 500 },
    );
    // --hide-header: the modal header must NOT render inside the float.
    expect(
      overlay.closest('.modal-overlay, .float-modal')?.querySelector('.modal-header') ?? null,
    ).toBeNull();
  },
};

/**
 * Float close by keyboard: click the float (focusing its pane — keyboard input
 * then routes to the FLOAT's shell, not the tab pane) and type `exit`. The shell
 * terminates, tmux drops the float window, and the overlay disappears. (`C-a x`
 * can't target an out-of-window pane: bare `kill-pane` acts on the current
 * window — a tmux semantic, not a tmuxy bug.)
 */
export const FloatCloseByKey: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy pane float');
    const doc = canvasElement.ownerDocument;
    await waitForFloat(doc);
    // Wait for the float pane's window mapping to settle (the periodic re-sync
    // corrects the post-break-pane race) so the click focuses the FLOAT's pane.
    const floatPaneId = (): string | null => {
      const ctx = (
        window as unknown as {
          app: {
            getSnapshot(): {
              context: {
                windows: { id: string; windowType: string | null }[];
                panes: { tmuxId: string; windowId: string }[];
              };
            };
          };
        }
      ).app.getSnapshot().context;
      const fw = ctx.windows.find((w) => w.windowType === 'float');
      if (!fw) return null;
      const members = ctx.panes.filter((pn) => pn.windowId === fw.id).map((pn) => pn.tmuxId);
      return members.length === 1 && !paneIds(canvas).includes(members[0]) ? members[0] : null;
    };
    await waitFor(() => expect(floatPaneId()).toMatch(/^%\d+$/), { timeout: 20000, interval: 500 });
    const target = floatPaneId()!;
    const overlay = await waitForFloat(doc);
    await user.click(overlay.querySelector('.float-content') ?? overlay);
    const focusedFloat = () =>
      (
        window as unknown as {
          app: { getSnapshot(): { context: { focusedFloatPaneId: string | null } } };
        }
      ).app.getSnapshot().context.focusedFloatPaneId;
    await waitFor(() => expect(focusedFloat()).toBe(target), { timeout: 15000, interval: 400 });
    // Typing now routes to the float's shell; `exit` terminates it and tmux
    // drops the float window.
    pasteLine('exit');
    await waitFor(
      () => {
        expect(doc.querySelector('.float-container')).toBeNull();
        expect(windows().some((w) => w.windowType === 'float')).toBe(false);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Drawers on every edge: `tmuxy pane float --left/--right/--top/--bottom` tags
 * the float window with the drawer direction; the WASM core reconstructs it and
 * an overlay renders. Each drawer is closed (click + C-a x) before the next.
 */
export const DrawerAllEdges: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doc = canvasElement.ownerDocument;
    for (const dir of ['left', 'right', 'top', 'bottom']) {
      pasteLine(`tmuxy pane float --${dir}`);
      await waitFor(
        () =>
          expect(windows().some((w) => w.windowType === 'float' && w.floatDrawer === dir)).toBe(
            true,
          ),
        { timeout: 30000, interval: 500 },
      );
      // The drawer must PAINT as an edge-docked drawer, not a centered modal —
      // the metadata can arrive after the window-type tag, so poll. (Drawers
      // render the `drawer drawer-<edge>` modal, NOT `.float-container`.)
      let overlay: HTMLElement | null = null;
      await waitFor(
        () => {
          overlay = doc.querySelector(`.drawer-${dir}`) as HTMLElement | null;
          expect(overlay).not.toBeNull();
          expect(overlay!.getBoundingClientRect().width).toBeGreaterThan(0);
        },
        { timeout: 20000, interval: 500 },
      );
      await user.click(overlay!.querySelector('.float-content') ?? overlay!);
      // Wait until keyboard focus reaches the drawer's pane, then exit its shell.
      await waitFor(
        () =>
          expect(
            (
              window as unknown as {
                app: { getSnapshot(): { context: { focusedFloatPaneId: string | null } } };
              }
            ).app.getSnapshot().context.focusedFloatPaneId,
          ).toMatch(/^%\d+$/),
        { timeout: 15000, interval: 400 },
      );
      pasteLine('exit');
      await waitFor(() => expect(windows().some((w) => w.windowType === 'float')).toBe(false), {
        timeout: 30000,
        interval: 500,
      });
    }
  },
};

/**
 * Pane-group member switching through three distinct real user paths:
 * keyboard `C-a =` (the mapped `tmuxy-pane-group-add` binding) groups the
 * active pane with a new member, CLI `tmuxy pane group next` swaps the
 * original back into the visible slot, and clicking the parked member's tab
 * in the PaneHeader (SELECT_PANE_GROUP_TAB) swaps once more. The rendered
 * pane id occupying the layout must toggle between the two members — real
 * swap-pane round-trips, not client-side relabeling.
 */
export const GroupSwitchNextPrev: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const original = activePaneId();
    // Keyboard path: prefix `=` runs the guest's tmuxy-pane-group-add alias.
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('=');
    let members: string[] = [];
    await waitFor(
      () => {
        const g = windows().find((w) => w.windowType === 'group');
        expect(g?.groupPanes?.length ?? 0).toBe(2);
        members = g!.groupPanes!;
      },
      { timeout: 30000, interval: 500 },
    );
    const other = members.find((m) => m !== original)!;
    // The new member takes the slot: it renders, the original is parked.
    await waitFor(() => expect(paneIds(canvas)).toContain(other), {
      timeout: 15000,
      interval: 500,
    });
    expect(paneIds(canvas)).not.toContain(original);
    // CLI path: group next → the original member swaps back into the slot.
    pasteLine('tmuxy pane group next');
    await waitFor(
      () => {
        expect(paneIds(canvas)).toContain(original);
        expect(paneIds(canvas)).not.toContain(other);
      },
      { timeout: 30000, interval: 500 },
    );
    // Mouse path: the PaneHeader lists both members as tabs — clicking the
    // parked member's tab swaps it back in, with zero flicker/churn (the
    // dim-override window must fully hide the swap turbulence).
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    await user.click(canvas.getByRole('tab', { name: `Pane ${other}` }));
    await waitFor(
      () => {
        expect(paneIds(canvas)).toContain(other);
        expect(paneIds(canvas)).not.toContain(original);
      },
      { timeout: 30000, interval: 500 },
    );
    await new Promise((r) => setTimeout(r, 800));
    glitches.assertNoGlitches('groupSwitch');
  },
};

/**
 * Pane-group member close: `tmuxy pane group close` removes the visible member;
 * with only one member left the group dissolves (no group-typed window remains)
 * and the closed pane id is gone everywhere.
 */
export const GroupCloseMember: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const original = activePaneId();
    pasteLine('tmuxy pane group add');
    let members: string[] = [];
    await waitFor(
      () => {
        const g = windows().find((w) => w.windowType === 'group');
        expect(g?.groupPanes?.length ?? 0).toBe(2);
        members = g!.groupPanes!;
      },
      { timeout: 30000, interval: 500 },
    );
    const added = members.find((m) => m !== original)!;
    await waitFor(() => expect(paneIds(canvas)).toContain(added), {
      timeout: 15000,
      interval: 500,
    });
    // Close the visible member from inside its own shell.
    pasteLine('tmuxy pane group close');
    await waitFor(
      () => {
        expect(windows().some((w) => w.windowType === 'group')).toBe(false);
        expect(paneIds(canvas)).not.toContain(added);
        expect(paneIds(canvas)).toContain(original);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Sidebar tree (real tmux via v86). The sidebar is a native React tab/pane tree
 * derived from the live session state — no `tmuxy tree` TUI, no sidebar window.
 * The drawer opens, lists every tab and its panes, clicking a pane activates it
 * (real `select-pane` round-trip), and toggling again hides the drawer.
 */
export const SidebarToggle: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doc = canvasElement.ownerDocument;
    const first = activePaneId();
    const second = paneIds(canvas).find((p) => p !== first)!;

    const toggle = canvasElement.querySelector('.sidebar-toggle') as HTMLElement;
    expect(toggle).not.toBeNull();
    await user.click(toggle);

    // The drawer opens with the React tree — NOT a tmux window (no sidebar pane).
    const tree = await waitFor(
      () => {
        const el = doc.querySelector('.sidebar-tree') as HTMLElement | null;
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 30000, interval: 500 },
    );
    expect(windows().some((w) => w.windowType === 'sidebar')).toBe(false);
    // Both panes of the current tab appear as tree nodes.
    await waitFor(
      () => {
        expect(tree.querySelector(`[data-testid="tree-pane-${first}"]`)).not.toBeNull();
        expect(tree.querySelector(`[data-testid="tree-pane-${second}"]`)).not.toBeNull();
      },
      { timeout: 15000, interval: 400 },
    );

    // Clicking the OTHER pane's node activates it (real select-pane round-trip).
    await user.click(tree.querySelector(`[data-testid="tree-pane-${second}"]`) as HTMLElement);
    await waitFor(() => expect(activePaneId()).toBe(second), { timeout: 20000, interval: 500 });

    // Toggle off → the drawer hides.
    await user.click(toggle);
    await waitFor(() => expect(doc.querySelector('.sidebar-tree')).toBeNull(), {
      timeout: 15000,
      interval: 500,
    });
  },
};

/**
 * Sidebar drag-a-pane-between-tabs (real tmux via v86). With two tabs, dragging
 * a pane node from the active tab onto another tab's node issues a real
 * `join-pane`, moving the pane into that tab — verified by the pane's reported
 * window id changing after the drop.
 */
export const SidebarDragPaneToTab: Story = {
  args: { height: 600, initCommands: ['split-window -h', 'new-window'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doc = canvasElement.ownerDocument;
    const snap = () =>
      (
        window as unknown as {
          app: {
            getSnapshot(): {
              context: {
                activeWindowId: string | null;
                windows: Array<{ id: string; windowType: string | null }>;
                panes: Array<{ tmuxId: string; windowId: string }>;
              };
            };
          };
        }
      ).app.getSnapshot().context;

    const toggle = canvasElement.querySelector('.sidebar-toggle') as HTMLElement;
    await user.click(toggle);
    const tree = await waitFor(
      () => {
        const el = doc.querySelector('.sidebar-tree') as HTMLElement | null;
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 30000, interval: 500 },
    );

    // Derive the drag source/target from the RENDERED tree (a window with an
    // empty name is filtered out of the visible tabs, so only trust nodes that
    // actually exist).
    const { paneEl, dstTabEl, paneId, dstWindowId } = await waitFor(
      () => {
        const tabNodes = [...tree.querySelectorAll('[data-testid^="tree-tab-"]')] as HTMLElement[];
        const paneNodes = [
          ...tree.querySelectorAll('[data-testid^="tree-pane-"]'),
        ] as HTMLElement[];
        expect(tabNodes.length).toBeGreaterThanOrEqual(2);
        expect(paneNodes.length).toBeGreaterThanOrEqual(1);
        const pEl = paneNodes[0];
        const pid = pEl.getAttribute('data-pane-id')!;
        const srcWin = snap().panes.find((p) => p.tmuxId === pid)!.windowId;
        const dTab = tabNodes.find((t) => t.getAttribute('data-window-id') !== srcWin);
        expect(dTab).toBeTruthy();
        return {
          paneEl: pEl,
          dstTabEl: dTab!,
          paneId: pid,
          dstWindowId: dTab!.getAttribute('data-window-id')!,
        };
      },
      { timeout: 20000, interval: 500 },
    );
    const dt = new DataTransfer();
    paneEl.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    dstTabEl.dispatchEvent(
      new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    dstTabEl.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    paneEl.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));

    // The pane now reports the destination tab's window (real join-pane landed).
    await waitFor(
      () => {
        const moved = snap().panes.find((p) => p.tmuxId === paneId);
        expect(moved?.windowId).toBe(dstWindowId);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

// ───────────────────────── §6 Widgets & rich rendering ─────────────────────────

/**
 * Image widget: piping a data URI through the real `tmuxy-widget image` script
 * prints the widget marker + content; the UI swaps the terminal for the image
 * widget and renders a real `<img>` from the URI.
 */
export const WidgetImage: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    // Keep the pipe open (like the markdown wrapper does): tmuxy-widget's EXIT
    // trap clears the widget the moment stdin closes.
    pasteLine(
      `{ echo 'data:image/png;base64,${INLINE_PNG_B64}'; sleep 3600; } | $HOME/.config/tmuxy/bin/tmuxy/tmuxy-widget image`,
    );
    await waitFor(
      () => {
        const img = canvasElement.ownerDocument.querySelector(
          '[role=group][aria-label^="Widget pane"] img[src^="data:image/png"]',
        ) as HTMLImageElement | null;
        expect(img).not.toBeNull();
        expect(img!.getBoundingClientRect().width).toBeGreaterThan(0);
      },
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * Markdown widget from a guest FILE: client-side there is no `/api/file` server
 * to fetch the watched file from (the request 404s), so the widget must mount
 * and surface that fetch error in its defined fallback — not crash, not render
 * garbage, and not silently pretend the file loaded. This pins down the
 * client-side contract for file-mode widgets.
 */
export const WidgetMarkdownFile: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine("printf '# FILE_WIDGET_7\\n' > /tmp/w7.md; tmuxy widget markdown /tmp/w7.md");
    await waitFor(
      () => {
        const widget = canvasElement.ownerDocument.querySelector('.widget-markdown-empty');
        expect(widget).not.toBeNull();
        // The /api/file fetch fails client-side; the widget reports it.
        expect(widget!.textContent ?? '').toMatch(/404/);
      },
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * Widget exit: Ctrl+C in a widget pane kills the widget process (SIGINT through
 * the real WidgetPane capture-phase handler → send-keys C-c), the terminal
 * returns, and the shell is usable again.
 */
export const WidgetExitRestoresShell: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doc = canvasElement.ownerDocument;
    pasteLine("echo '# WIDGET_EXIT_5' | tmuxy widget markdown -");
    await waitFor(() => expect(doc.querySelector('.widget-markdown')).not.toBeNull(), {
      timeout: 40000,
      interval: 500,
    });
    await user.keyboard('{Control>}c{/Control}');
    await waitFor(() => expect(doc.querySelector('.widget-markdown')).toBeNull(), {
      timeout: 20000,
      interval: 500,
    });
    pasteLine('echo AFTER_WIDGET_5');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /AFTER_WIDGET_5/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Kitty graphics protocol: the guest emits a Kitty APC transmit+display escape
 * with a PNG payload; the WASM core's Kitty parser decodes it into the pane's
 * image store and the Terminal renders an `<img>` — a different protocol path
 * than the iTerm2 story.
 */
export const KittyImage: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine(`printf '\\033_Gf=100,a=T;${INLINE_PNG_B64}\\033\\\\'`);
    await waitFor(
      () =>
        expect(
          canvasElement.ownerDocument.querySelector('img[src^="data:image/png"]'),
        ).not.toBeNull(),
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * Sixel: the guest emits a DCS sixel sequence; the core transcodes it to PNG
 * (icy_sixel) and the Terminal renders it — covering the third image protocol.
 */
export const SixelImage: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine(`printf '\\033Pq#0;2;100;0;0#0!30~-#0!30~\\033\\\\'`);
    await waitFor(
      () =>
        expect(
          canvasElement.ownerDocument.querySelector('img[src^="data:image/png"]'),
        ).not.toBeNull(),
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * OSC 8 hyperlinks: wrapped text renders as a real anchor with the target href —
 * asserting the href (not the text) proves the escape was parsed, not echoed.
 */
export const Osc8Hyperlink: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine(`printf '\\033]8;;https://example.com/x8\\033\\\\LINK_TEXT_8\\033]8;;\\033\\\\\\n'`);
    await waitFor(
      () => {
        const link = canvasElement.ownerDocument.querySelector(
          'a.terminal-hyperlink',
        ) as HTMLAnchorElement | null;
        expect(link).not.toBeNull();
        expect(link!.href).toContain('example.com/x8');
      },
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * Image placements are CELL-ANCHORED, not content-tracked (see
 * docs/RICH-RENDERING.md "Placement geometry"): the core's vt100 keeps no
 * scrollback (limit 0), so a placement pins to its decode-time viewport cell
 * and later output scrolling the screen does NOT move it. This story guards
 * that documented behavior — the placement survives a 60-line burst without
 * unmounting or drifting. (Its predecessor, ImageScrollsWithContent,
 * asserted iTerm2-style scroll-tracking the renderer never implemented and
 * passed only via a transient-null escape hatch during capture refreshes.
 * Content-tracked placements would need a scroll counter in the vt100 layer.)
 */
export const ImageAnchoredDuringScroll: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const doc = canvasElement.ownerDocument;
    pasteLine(`printf '\\033]1337;File=inline=1:${INLINE_PNG_B64}\\a\\n'`);
    let firstTop = 0;
    await waitFor(
      () => {
        const img = doc.querySelector('img[src^="data:image/png"]');
        expect(img).not.toBeNull();
        firstTop = img!.getBoundingClientRect().top;
      },
      { timeout: 40000, interval: 500 },
    );
    pasteLine('seq 1 60');
    // Wait for the burst to actually render before judging the placement.
    await waitForBurstTail(canvas, (text) => /585960(\D|$)/.test(text.replace(/\s+/g, '')));
    // Anchored: same element, same cell → same rendered position.
    const img = doc.querySelector('img[src^="data:image/png"]');
    expect(img).not.toBeNull();
    expect(img!.getBoundingClientRect().top).toBe(firstTop);
  },
};

// ───────────────────────── §7 Input edge cases ─────────────────────────

/**
 * Multi-line paste: one paste of three lines becomes per-line `send-keys -l` +
 * Enter chunks — bash must run all three commands, in order, exactly once.
 */
export const PasteMultiline: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const data = new DataTransfer();
    data.setData('text/plain', 'echo ML_A4\necho ML_B4\necho ML_C4\n');
    window.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
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
  args: { height: 600 },
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
  args: { height: 600 },
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
 * Font-size shortcuts: Ctrl+= grows the measured character cell, and the app
 * re-sizes the tmux client to fit — the same container then holds FEWER columns
 * (tmux reports the new layout). Ctrl+0 resets.
 */
export const FontSizeShortcuts: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await waitFor(() => expect(Math.max(...paneCols())).toBeGreaterThan(30), {
      timeout: 15000,
      interval: 500,
    });
    // The boot-time client resize (refresh-client -C to container size) keeps
    // growing the column count for a beat — settle it before capturing the
    // baseline, or the natural growth is mistaken for the shortcut's effect.
    const colSum = () => paneCols().reduce((a, b) => a + b, 0);
    for (let i = 0; i < 20; i++) {
      const a = colSum();
      await new Promise((r) => setTimeout(r, 400));
      if (colSum() === a) break;
    }
    const colsBefore = colSum();
    await user.keyboard('{Control>}={/Control}');
    await user.keyboard('{Control>}={/Control}');
    await waitFor(() => expect(colSum()).toBeLessThan(colsBefore), {
      timeout: 30000,
      interval: 500,
    });
    await user.keyboard('{Control>}0{/Control}');
    await waitFor(() => expect(colSum()).toBe(colsBefore), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Shell history round-trip: run a command, press ArrowUp (must reach bash as a
 * cursor key, not a literal) and Enter — the same output prints a second time.
 */
export const ArrowKeysHistory: Story = {
  args: { height: 600 },
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
  args: { height: 600 },
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

// ───────────────────────── §8 Themes, status bar, menus ─────────────────────────

/** Open the hamburger app menu and return a submenu-item clicker. */
async function openAppMenu(canvasElement: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  const doc = canvasElement.ownerDocument;
  const btn = canvasElement.querySelector('.app-menu-button') as HTMLElement;
  expect(btn).not.toBeNull();
  await user.click(btn);
  const item = async (label: RegExp): Promise<HTMLElement> => {
    let el: HTMLElement | undefined;
    await waitFor(
      () => {
        el = [...doc.querySelectorAll('[role=menuitem]')].find((m) =>
          label.test(m.textContent ?? ''),
        ) as HTMLElement | undefined;
        expect(el).toBeTruthy();
      },
      { timeout: 10000, interval: 300 },
    );
    return el!;
  };
  return { item };
}

/**
 * Theme picker via the menu — entirely by mouse: hamburger → Theme → Dracula,
 * then Light Mode. The stylesheet link must switch to dracula.css and the
 * documentElement mode class must flip — the same real path a user takes.
 */
export const ThemePickerViaMenu: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    // The picker list is populated on connect.
    await waitFor(
      () =>
        expect(
          (
            window as unknown as {
              app: { getSnapshot(): { context: { availableThemes: unknown[] } } };
            }
          ).app.getSnapshot().context.availableThemes.length,
        ).toBeGreaterThan(0),
      { timeout: 15000, interval: 500 },
    );
    const doc = canvasElement.ownerDocument;
    const menu = await openAppMenu(canvasElement, user);
    await user.click(await menu.item(/^Theme$/));
    await user.click(await menu.item(/Dracula/));
    await waitFor(
      () =>
        expect(doc.getElementById('tmuxy-theme')?.getAttribute('href')).toBe('/themes/dracula.css'),
      { timeout: 10000, interval: 300 },
    );
    const menu2 = await openAppMenu(canvasElement, user);
    await user.click(await menu2.item(/^Theme$/));
    await user.click(await menu2.item(/Light Mode/));
    await waitFor(() => expect(doc.documentElement.classList.contains('theme-light')).toBe(true), {
      timeout: 10000,
      interval: 300,
    });
    // Restore defaults so the persisted localStorage doesn't bleed.
    (
      window as unknown as {
        app: { send(e: { type: string; name?: string; mode?: string }): void };
      }
    ).app.send({
      type: 'SET_THEME',
      name: 'default',
    });
    (window as unknown as { app: { send(e: { type: string; mode: string }): void } }).app.send({
      type: 'SET_THEME_MODE',
      mode: 'dark',
    });
  },
};

/**
 * Status bar content: shows the live session's hostname/prompt block and the
 * keybinding hints; after a rename via the guest CLI the (windowless) status
 * line still reflects the real tmux status — asserted from the rendered bar.
 */
export const StatusBarContent: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const bar = () =>
      canvasElement.querySelector('.status-bar, [class*="status-bar"], .tmux-status-bar');
    await waitFor(
      () => {
        expect(bar()).not.toBeNull();
        // Keybinding hints + host block are rendered for the live session.
        expect((bar()?.textContent ?? '').length).toBeGreaterThan(3);
      },
      { timeout: 15000, interval: 500 },
    );
    // The window tab strip shows the real window name from tmux.
    expect(canvas.getByRole('tab', { name: /root/ })).toBeTruthy();
  },
};

/**
 * Menu-driven pane ops: hamburger → Pane → "Split Pane Below" — a mouse-only
 * split through menuActions → run_tmux_command → real tmux. A real new `%N`
 * pane must render.
 */
export const MenuPaneOps: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const before = paneGroups(canvas).length;
    const menu = await openAppMenu(canvasElement, user);
    await user.click(await menu.item(/^Pane$/));
    await user.click(await menu.item(/Split Pane Below/));
    await waitFor(
      () => {
        expect(paneGroups(canvas).length).toBeGreaterThan(before);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Help menu: hamburger → Help lists the real help entry (Tmuxy on GitHub with
 * the external-link marker). We assert the item renders; clicking would
 * navigate away, so the assertion stops at the rendered affordance.
 */
export const HelpMenu: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const menu = await openAppMenu(canvasElement, user);
    await user.click(await menu.item(/^Help$/));
    const gh = await menu.item(/Tmuxy on GitHub/);
    expect(gh.querySelector('.menu-external')).not.toBeNull();
  },
};

// ───────────────────────── §9 Sessions & connection lifecycle ─────────────────────────

/**
 * Session create via menu + switch: hamburger → Session → "New Session" runs a
 * real `new-session -d`; switching the control client to it swaps the rendered
 * pane set (reconstructed for the new session), and back restores the original.
 */
export const SessionMenuNewAndSwitch: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const panesOnM = paneIds(canvas).join(',');
    const menu = await openAppMenu(canvasElement, user);
    await user.click(await menu.item(/^Session$/));
    await user.click(await menu.item(/New Session/));
    // tmux names the detached session with its next free index (guest-dependent)
    // — discover the real name from the guest, like a user running `tmux ls`.
    await new Promise((r) => setTimeout(r, 2000));
    // Wrap the name in markers — the terminal renderer concatenates lines, so an
    // unterminated match would swallow the following prompt text.
    pasteLine(`tmux ls -F '#S' | grep -v '^m$' | head -1 | sed 's/^/SNAME:/;s/$/:ENDS/'`);
    let created = '';
    await waitFor(
      () => {
        const m = paneGroups(canvas)
          .map((p: HTMLElement) => p.textContent ?? '')
          .join('')
          .match(/SNAME:(\w+):ENDS/);
        expect(m).toBeTruthy();
        created = m![1];
      },
      { timeout: 30000, interval: 500 },
    );
    const app = (
      window as unknown as { app: { send(e: { type: string; sessionName: string }): void } }
    ).app;
    app.send({ type: 'SWITCH_SESSION', sessionName: created });
    await waitFor(
      () => {
        expect(sessionName()).toBe(created);
        expect(paneIds(canvas).join(',')).not.toBe(panesOnM);
      },
      { timeout: 30000, interval: 500 },
    );
    app.send({ type: 'SWITCH_SESSION', sessionName: 'm' });
    await waitFor(
      () => {
        expect(sessionName()).toBe('m');
        expect(paneIds(canvas).join(',')).toBe(panesOnM);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Session round-trip state: split inside a second session, hop back and forth —
 * each session keeps its own pane set and the client reconstructs both
 * faithfully after every switch.
 */
export const SessionRoundTrip: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const app = (
      window as unknown as { app: { send(e: { type: string; sessionName: string }): void } }
    ).app;
    const panesOnM = paneIds(canvas).length;
    pasteLine('tmux new-session -d -s rt');
    await new Promise((r) => setTimeout(r, 2500));
    app.send({ type: 'SWITCH_SESSION', sessionName: 'rt' });
    await waitFor(() => expect(sessionName()).toBe('rt'), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(paneGroups(canvas).length).toBe(1), {
      timeout: 20000,
      interval: 500,
    });
    // Split inside rt (via the guest CLI in rt's own pane).
    await focusFirstPane(canvas, user).catch(() => {});
    pasteLine('tmuxy pane split');
    await waitFor(() => expect(paneGroups(canvas).length).toBe(2), {
      timeout: 30000,
      interval: 500,
    });
    // Back to m: original pane count intact.
    app.send({ type: 'SWITCH_SESSION', sessionName: 'm' });
    await waitFor(
      () => {
        expect(sessionName()).toBe('m');
        expect(paneGroups(canvas).length).toBe(panesOnM);
      },
      { timeout: 30000, interval: 500 },
    );
    // And rt still has its split.
    app.send({ type: 'SWITCH_SESSION', sessionName: 'rt' });
    await waitFor(
      () => {
        expect(sessionName()).toBe('rt');
        expect(paneGroups(canvas).length).toBe(2);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Failed session switch: switching to a nonexistent session must NOT strand the
 * app in the cleared-optimistic-state limbo. The tracked control channel sees
 * tmux's %error, the adapter resyncs the current session, the machine re-adopts
 * its state, and the failure surfaces as a real error — panes render again and
 * the app stays interactive.
 */
export const SwitchSessionFailure: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const original = sessionName();
    (
      window as unknown as { app: { send(e: { type: string; sessionName: string }): void } }
    ).app.send({
      type: 'SWITCH_SESSION',
      sessionName: 'no_such_session_zz9',
    });
    // The error surfaces through the real TMUX_ERROR path…
    await waitFor(
      () =>
        expect(
          (
            window as unknown as { app: { getSnapshot(): { context: { error: string | null } } } }
          ).app.getSnapshot().context.error,
        ).toBeTruthy(),
      { timeout: 30000, interval: 500 },
    );
    // …and the app recovers: original session state flows back in.
    await waitFor(
      () => {
        expect(sessionName()).toBe(original);
        expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 30000, interval: 500 },
    );
    pasteLine('echo AFTER_BAD_SWITCH_6');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            /AFTER_BAD_SWITCH_6/.test(p.textContent ?? ''),
          ),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Fatal: killing the tmux server in the guest ends the control stream (`%exit`);
 * the engine surfaces it as a fatal and the app must show its non-recoverable
 * status screen — not a blank or frozen UI. Reached by actually killing the
 * server, not by synthesizing the event.
 */
export const FatalScreen: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('tmuxy run kill-server');
    await waitFor(
      () =>
        expect(
          canvasElement.ownerDocument.querySelector('[data-testid="fatal-display"]'),
        ).not.toBeNull(),
      { timeout: 40000, interval: 500 },
    );
  },
};

/**
 * Last pane exits: `exit` in every pane closes the last window, tmux's server
 * exits, the control stream ends — the app must land on the fatal status screen
 * (a defined terminal state), never a blank/frozen UI.
 */
export const LastPaneExit: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const start = paneGroups(canvas).length;
    pasteLine('exit');
    await waitFor(() => expect(paneGroups(canvas).length).toBeLessThan(start), {
      timeout: 30000,
      interval: 500,
    });
    // Focus the survivor and exit it too — the last window closes and the
    // server goes down.
    await focusFirstPane(canvas, user).catch(() => {});
    pasteLine('exit');
    await waitFor(
      () =>
        expect(
          canvasElement.ownerDocument.querySelector('[data-testid="fatal-display"]'),
        ).not.toBeNull(),
      { timeout: 40000, interval: 500 },
    );
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
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    expect(paneIds(canvas).sort()).toEqual(['%0', '%1']);
    expect(tabWindows().length).toBe(1);
    expect(windows().some((w) => w.windowType === 'float' || w.windowType === 'group')).toBe(false);
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
  args: { height: 600 },
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
  args: { height: 600 },
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
  args: { height: 600 },
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
  args: { height: 600 },
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

// ─────────── §12 Optimistic timeline (predict → paint → reconcile / rollback) ───────────
//
// The Resilience stories prove the optimistic loop against the DemoAdapter;
// these prove it against REAL tmux — the marker-tracked command FIFO, the
// byte-paced serial transport, and the WASM reconcile are all in the loop.
// A placeholder id (`__placeholder_*`) can ONLY come from the client-side
// predictor — the server never emits one — so a painted placeholder IS the
// proof the UI didn't wait for the round-trip.

const appError = (): string | null =>
  (
    window as unknown as { app: { getSnapshot(): { context: { error: string | null } } } }
  ).app.getSnapshot().context.error;

/** Sorted real (%N) pane ids currently rendered. */
const realPaneIdsSorted = (canvas: Canvas): string[] =>
  paneIds(canvas)
    .filter((id) => /^%\d+$/.test(id))
    .sort();

/**
 * Wait for pane geometry to be at rest (two identical samples 400ms apart) —
 * the boot-time `refresh-client -C` resize can land seconds into a story and
 * invalidates any rect captured before it.
 */
async function settleGeometry(canvas: Canvas): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const a = rectSignature(canvas);
    await new Promise((r) => setTimeout(r, 400));
    if (rectSignature(canvas) === a) return;
  }
  throw new Error('pane geometry never settled');
}

/** Stable geometry signature of every real pane, for exact-restore asserts. */
const rectSignature = (canvas: Canvas): string =>
  realPaneIdsSorted(canvas)
    .map((id: string) => {
      const r = paneRect(canvas, id);
      return `${id}:${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    })
    .join('|');

/**
 * Watch an element's `class` attribute and record every value it passes
 * through (via oldValue chaining + the final live value). Used to prove an
 * optimistic highlight never flapped during the server reconcile — polling
 * would miss a single-frame revert; the mutation log cannot.
 */
function recordClassHistory(el: Element): { history: () => string[]; disconnect: () => void } {
  const oldValues: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const rec of records) oldValues.push(rec.oldValue ?? '');
  });
  observer.observe(el, { attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
  return {
    history: () => [...oldValues, el.className],
    disconnect: () => observer.disconnect(),
  };
}

/**
 * 1.1 — Split, the full optimistic timeline: C-a `-` paints a placeholder pane
 * within a few frames of the keypress (≤5 frames ≈ 83ms absorbs userEvent
 * dispatch overhead and is far below the serial round-trip), and when real
 * tmux confirms, the placeholder morphs into the real `%N` by an attribute
 * swap on the SAME DOM node — zero pane-node removals during reconcile
 * (the paneKeyOverrides anti-flicker contract).
 */
export const SplitOptimisticTimeline: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;
    expect(layoutRoot).not.toBeNull();
    const before = paneGroups(canvas).length;

    await user.keyboard('{Control>}a{/Control}');
    // Arm AFTER the prefix press so the frame budget measures the mapped key.
    const recorder = new LayoutMutationRecorder(layoutRoot);
    const glitches = new GlitchRecorder(layoutRoot);
    const probe = armPaintProbe(layoutRoot, addsElement('[data-pane-id^="__placeholder_"]'));
    await user.keyboard('-');
    const frames = await probe.wait(5, 5000);
    expect(frames).toBeLessThanOrEqual(5);

    // The optimistic pane is genuinely visible, not just in the DOM.
    const placeholderEl = layoutRoot.querySelector('[data-pane-id^="__placeholder_"]')!;
    expect(placeholderEl).not.toBeNull();
    const rect = placeholderEl.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(50);
    expect(rect.height).toBeGreaterThan(20);

    // Real tmux confirms: placeholder id swaps to %N, same node count.
    await waitFor(
      () => {
        expect(paneGroups(canvas).length).toBe(before + 1);
        expect(layoutRoot.querySelector('[data-pane-id^="__placeholder_"]')).toBeNull();
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
    recorder.disconnect();
    // No pane node was removed while the optimistic pane became real — the
    // element survived the id swap (a remount here is the flicker users see).
    expect([...recorder.removedPaneIds]).toEqual([]);
    glitches.assertNoGlitches('split');
  },
};

/**
 * 1.2 — Real-tmux rejection rolls the optimistic split back: keep splitting
 * until tmux runs out of vertical space. The failing attempt must still paint
 * its placeholder first (prediction has no min-size model — by design: the
 * server is authoritative), then roll back to the EXACT pre-attempt pane set
 * and geometry, leave a real active pane and no placeholder, and surface the
 * tmux error to the app (context.error → status-line message).
 */
export const SplitRejectedRollback: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;

    // Geometry must be at rest before we snapshot it — the previous attempt's
    // CSS transition / layout refresh may still be settling.
    const stableSig = async (): Promise<string> => {
      for (let i = 0; i < 20; i++) {
        const a = rectSignature(canvas);
        await new Promise((r) => setTimeout(r, 350));
        if (rectSignature(canvas) === a) return a;
      }
      throw new Error('pane geometry never settled');
    };

    let sawRollback = false;
    for (let attempt = 0; attempt < 8 && !sawRollback; attempt++) {
      const beforeSig = await stableSig();
      const beforeIds = realPaneIdsSorted(canvas).join(',');
      await user.keyboard('{Control>}a{/Control}');
      const probe = armPaintProbe(layoutRoot, addsElement('[data-pane-id^="__placeholder_"]'));
      await user.keyboard('-');
      // Success or failure, the placeholder paints first.
      await probe.wait(5, 5000);
      // Settle: no placeholder left either way (confirmed real, or rolled back).
      await waitFor(
        () => {
          expect(paneIds(canvas).filter((id) => id.startsWith('__placeholder_')).length).toBe(0);
          expect(activePaneId()).toMatch(/^%\d+$/);
        },
        { timeout: 20000, interval: 250 },
      );
      if (realPaneIdsSorted(canvas).join(',') === beforeIds) {
        // tmux rejected this split: geometry must be restored exactly. The
        // window is generous — a lingering acked op from a previous attempt
        // can hold its patch for several seconds before the restore settles.
        await waitFor(() => expect(rectSignature(canvas)).toBe(beforeSig), {
          timeout: 15000,
          interval: 400,
        });
        // And the rejection reached the app's error surface.
        expect(appError()).toBeTruthy();
        sawRollback = true;
      }
    }
    expect(sawRollback).toBe(true);
  },
};

/**
 * 1.3 — Optimistic new-tab timeline via the tab bar `+` (pure mouse): the tab
 * strip AND the pane grid flip to the placeholder window within a few frames
 * of the click; real tmux then confirms with a real `@N`/`%N`, morphing the
 * placeholder pane in place (no pane-node removal). The rejection twin lives
 * in Mocked App/Resilience (TabCreateRejected) — real tmux has no
 * user-reachable failure mode for a plain new-window.
 */
export const TabCreateOptimisticTimeline: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;
    const beforeTabs = windowTabEls(canvas).length;
    const beforeWindows = realTabWindows().map((w) => w.id);

    const recorder = new LayoutMutationRecorder(layoutRoot);
    const probe = armPaintProbe(layoutRoot, addsElement('[data-pane-id^="__placeholder_pane"]'));
    await user.click(canvas.getByLabelText('Create new tab'));
    await probe.wait(5, 5000);
    // The tab strip already shows the optimistic tab.
    expect(windowTabEls(canvas).length).toBe(beforeTabs + 1);

    await waitFor(
      () => {
        expect(realTabWindows().length).toBe(beforeWindows.length + 1);
        expect(activeWindow()?.id).toMatch(/^@\d+$/);
        expect(activePaneId()).toMatch(/^%\d+$/);
        expect(layoutRoot.querySelector('[data-pane-id^="__placeholder_"]')).toBeNull();
      },
      { timeout: 30000, interval: 500 },
    );
    recorder.disconnect();
    expect([...recorder.removedPaneIds]).toEqual([]);
  },
};

/**
 * 1.4a — Pane focus is optimistic and stable: clicking an inactive pane flips
 * `.pane-active` within a few frames of the click, and the highlight NEVER
 * passes through a non-active state again while real tmux confirms (the class
 * history is recorded by MutationObserver — polling would miss a one-frame
 * flap; the mutation log cannot).
 */
export const SelectPaneImmediate: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const active = activePaneId();
    const target = paneIds(canvas).find((id) => /^%\d+$/.test(id) && id !== active)!;
    const targetEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === target,
    )!;
    // `pane-active` lives on the .pane-layout-item wrapper, not the inner
    // role=group element the accessibility query returns.
    const targetWrapper = targetEl.closest('.pane-layout-item') as HTMLElement;
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;

    const probe = armPaintProbe(
      layoutRoot,
      (rec) =>
        rec.type === 'attributes' &&
        rec.attributeName === 'class' &&
        rec.target === targetWrapper &&
        targetWrapper.classList.contains('pane-active'),
    );
    await user.click(targetEl);
    const frames = await probe.wait(5, 5000);
    expect(frames).toBeLessThanOrEqual(5);

    // Record every class value the pane passes through while the real
    // select-pane round-trips; none may lack `pane-active`.
    const classes = recordClassHistory(targetWrapper);
    await new Promise((r) => setTimeout(r, 1500));
    classes.disconnect();
    expect(classes.history().filter((c) => !c.includes('pane-active'))).toEqual([]);
    expect(activePaneId()).toBe(target);
  },
};

/**
 * 1.4b — Tab switch is optimistic and stable: with two windows, clicking the
 * inactive tab flips `aria-selected` within a few frames, and the selection
 * never flaps back while the real select-window confirms (guards the
 * SELECT_TAB grace-window pinning).
 */
export const SelectTabImmediate: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy tab create');
    await waitFor(() => expect(tabWindows().length).toBe(2), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 30000, interval: 500 });

    const tabEl = windowTabEls(canvas)[0];
    const probe = armPaintProbe(
      canvasElement,
      (rec) =>
        rec.type === 'attributes' &&
        rec.attributeName === 'aria-selected' &&
        rec.target === tabEl &&
        tabEl.getAttribute('aria-selected') === 'true',
    );
    await user.click(tabEl);
    const frames = await probe.wait(5, 5000);
    expect(frames).toBeLessThanOrEqual(5);

    // The optimistic selection must hold through the server confirmation —
    // and the pane grid must swap with zero flicker/churn/jumps.
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    const flaps: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.attributeName === 'aria-selected') flaps.push(rec.oldValue ?? '');
      }
    });
    observer.observe(tabEl, { attributes: true, attributeOldValue: true });
    await new Promise((r) => setTimeout(r, 1500));
    observer.disconnect();
    expect([...flaps, tabEl.getAttribute('aria-selected')].filter((v) => v !== 'true')).toEqual([]);
    expect(activeWindow()?.index).toBe(1);
    glitches.assertNoGlitches('windowSwitch');
  },
};

/**
 * 1.5 — Directional pane navigation predicts the pane tmux will pick,
 * including the MRU tiebreak: with a full-height pane facing two stacked
 * neighbours, Ctrl+←/→ must flip focus to the most-recently-used neighbour
 * within a few frames — and the flip must be FINAL (a second flip after the
 * server reply means the client predicted a different pane than tmux chose).
 */
export const NavigateKeysImmediate: Story = {
  args: { height: 600, initCommands: ['select-layout even-horizontal', 'split-window -v'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await waitFor(() => expect(realPaneIdsSorted(canvas).length).toBeGreaterThanOrEqual(3), {
      timeout: 30000,
      interval: 500,
    });

    // Identify the geometry: one column holds two stacked panes, the other a
    // single (tallest) pane. All coordinates from live rects — no assumptions
    // about which boot pane got split.
    const ids = realPaneIdsSorted(canvas);
    const rects = new Map(ids.map((id) => [id, paneRect(canvas, id)]));
    const byLeft = new Map<number, string[]>();
    for (const [id, r] of rects) {
      const key = Math.round(r.left / 10);
      byLeft.set(key, [...(byLeft.get(key) ?? []), id]);
    }
    const stackedCol = [...byLeft.values()].find((col) => col.length >= 2);
    const singleCol = [...byLeft.values()].find((col) => col.length === 1);
    expect(stackedCol).toBeTruthy();
    expect(singleCol).toBeTruthy();
    const single = singleCol![0];
    // Bottom pane of the stacked column — the one we'll make most-recently-used.
    const stackedSorted = [...stackedCol!].sort((a, b) => rects.get(a)!.top - rects.get(b)!.top);
    const mruTarget = stackedSorted[stackedSorted.length - 1];

    const clickPane = async (id: string) => {
      const el = paneGroups(canvas).find(
        (p: HTMLElement) => p.getAttribute('data-pane-id') === id,
      )!;
      await user.click(el);
      await waitFor(() => expect(activePaneId()).toBe(id), { timeout: 15000, interval: 200 });
    };
    // MRU order: touch the bottom stacked pane, then move to the single pane.
    await clickPane(mruTarget);
    await clickPane(single);

    // Navigate from the single pane toward the stacked column.
    const towardStack =
      rects.get(single)!.left < rects.get(mruTarget)!.left
        ? '{Control>}l{/Control}'
        : '{Control>}h{/Control}';
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;
    const mruEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === mruTarget,
    )!;
    // `pane-active` lives on the .pane-layout-item wrapper.
    const mruWrapper = mruEl.closest('.pane-layout-item') as HTMLElement;
    const probe = armPaintProbe(
      layoutRoot,
      (rec) =>
        rec.type === 'attributes' &&
        rec.attributeName === 'class' &&
        rec.target === mruWrapper &&
        mruWrapper.classList.contains('pane-active'),
    );
    await user.keyboard(towardStack);
    const frames = await probe.wait(5, 5000);
    expect(frames).toBeLessThanOrEqual(5);

    // The predicted target must BE tmux's choice — no second flip.
    const classes = recordClassHistory(mruWrapper);
    await new Promise((r) => setTimeout(r, 1500));
    classes.disconnect();
    expect(classes.history().filter((c) => !c.includes('pane-active'))).toEqual([]);
    expect(activePaneId()).toBe(mruTarget);
  },
};

/**
 * 1.6 — Drag-to-swap reconciles without a visual step: after the drop, the
 * optimistic swap retargets both panes' inline geometry within a few frames,
 * and once the CSS transition settles, the real `%layout-change` from tmux
 * must land with ZERO further rect movement and no pane remounts — the user
 * sees exactly one continuous motion.
 */
export const SwapDragReconcile: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const [a, b] = paneIds(canvas);
    const src = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
    const dst = src === a ? b : a;
    const srcEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === src,
    )!;
    const dstEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === dst,
    )!;
    const header = srcEl.querySelector('.pane-header') as HTMLElement;
    const hRect = header.getBoundingClientRect();
    const dstRect = paneRect(canvas, dst);
    const startX = hRect.left + hRect.width / 2;
    const startY = hRect.top + hRect.height / 2;
    const endX = dstRect.left + dstRect.width / 2;
    const endY = dstRect.top + dstRect.height / 2;

    // The positioned elements are the .pane-layout-item wrappers; the swap
    // exchanges their inline grid targets. During the drag the SOURCE pane is
    // pinned to its original slot (the ghost/transform carries the visual), so
    // the pane that moves optimistically at hover is the TARGET.
    const srcWrapper = srcEl.closest('.pane-layout-item') as HTMLElement;
    const dstWrapper = dstEl.closest('.pane-layout-item') as HTMLElement;
    const srcSlotBefore = `${srcWrapper.style.left}|${srcWrapper.style.top}`;
    const dstSlotBefore = `${dstWrapper.style.left}|${dstWrapper.style.top}`;

    header.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: startX, clientY: startY, bubbles: true }),
    );
    // Cross the 5px drag threshold near the source header first.
    for (const i of [1, 2]) {
      header.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: startX + i * 8,
          clientY: startY + i * 2,
          bubbles: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 80));
    }

    // Hover onto the target: the drag machine fires the swap command HERE, and
    // the store's Swap prediction must slide the target pane into the source's
    // slot within a few frames — long before the tmux round-trip could land.
    const hoverProbe = armPaintProbe(
      dstWrapper,
      (rec) =>
        rec.type === 'attributes' &&
        rec.attributeName === 'style' &&
        `${dstWrapper.style.left}|${dstWrapper.style.top}` === srcSlotBefore,
    );
    dstEl.dispatchEvent(
      new MouseEvent('mousemove', { clientX: endX, clientY: endY, bubbles: true }),
    );
    const hoverFrames = await hoverProbe.wait(5, 5000);
    expect(hoverFrames).toBeLessThanOrEqual(5);

    // Drop: the source pane's pin lifts and it must take the target's slot
    // immediately (the patch is already in the derived model).
    const dropProbe = armPaintProbe(
      srcWrapper,
      (rec) =>
        rec.type === 'attributes' &&
        rec.attributeName === 'style' &&
        `${srcWrapper.style.left}|${srcWrapper.style.top}` === dstSlotBefore,
    );
    dstEl.dispatchEvent(new MouseEvent('mouseup', { clientX: endX, clientY: endY, bubbles: true }));
    const dropFrames = await dropProbe.wait(5, 5000);
    expect(dropFrames).toBeLessThanOrEqual(5);

    // Let the swap's CSS transition finish, then record across the server
    // reconcile: no size jumps, no pane remounts — the confirmation must be
    // visually invisible.
    await new Promise((r) => setTimeout(r, 600));
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    await new Promise((r) => setTimeout(r, 1800));
    glitches.assertNoGlitches('drag');

    // And the swap actually stuck (server-confirmed geometry).
    const leftNow = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
    expect(leftNow).toBe(dst);
  },
};

/**
 * 1.7 — Two splits in flight at once: press C-a `-` twice back-to-back, faster
 * than the round-trip. Both placeholders must resolve to DISTINCT real panes
 * (guards the claimedPanes reconcile sets) and no placeholder may survive.
 * Also guards the keyboardActor's placeholder-safe send targeting: the second
 * binding fires while the active pane is still `__placeholder_*`, which must
 * not be sent to tmux as a target.
 */
export const ConcurrentSplitsClaimIds: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const before = realPaneIdsSorted(canvas).length;

    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('-');
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('-');

    await waitFor(
      () => {
        const real = realPaneIdsSorted(canvas);
        expect(real.length).toBe(before + 2);
        expect(new Set(real).size).toBe(real.length);
        expect(paneIds(canvas).filter((id) => id.startsWith('__placeholder_')).length).toBe(0);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * 1.9 — Typing round-trip latency canary (NOT local echo — that's an explicit
 * non-goal): pasting a command must render its real `%output` within a budget
 * that catches serial-pacing / aggregator-debounce regressions. Generous for
 * emulator + CI variance; a 10x pacing regression still fails loudly.
 */
export const TypingRoundTripLatencyBudget: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const started = performance.now();
    pasteLine('echo STORY_LATENCY_$((6000+42))');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            (p.textContent ?? '').includes('STORY_LATENCY_6042'),
          ),
        ).toBe(true),
      { timeout: 10000, interval: 100 },
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(5000);
  },
};

// ─────────── §13 Optimistic ops: kill / zoom / rename (predict → confirm) ───────────

/**
 * 2.1 — Kill pane, optimistic end-to-end: C-a `x` routes through the KillPane
 * prediction (removal + neighbor expansion on dispatch, exit-animation grace,
 * server confirm invisible). The mock twin (Mocked App/Resilience —
 * SlowKillPane / KillPaneRejected) proves the ordering crisply under
 * controlled latency; this proves the real chain agrees: the doomed pane is
 * gone within the animation grace + margin, focus lands on a surviving real
 * pane, and the reconcile never resurrects it.
 */
export const KillPaneOptimisticTimeline: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doomed = activePaneId();
    expect(doomed).toMatch(/^%\d+$/);

    await user.keyboard('{Control>}a{/Control}');
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    const removedAt = { t: 0 };
    const observer = new MutationObserver(() => {
      if (removedAt.t === 0 && !paneIds(canvas).includes(doomed)) {
        removedAt.t = performance.now();
      }
    });
    observer.observe(canvasElement.querySelector('.pane-layout')!, {
      childList: true,
      subtree: true,
    });
    const pressed = performance.now();
    await user.keyboard('x');

    await waitFor(() => expect(paneIds(canvas)).not.toContain(doomed), {
      timeout: 5000,
      interval: 100,
    });
    observer.disconnect();
    // Removal within the 300ms exit grace + margin — the optimistic path.
    // (The pure server path adds the round-trip + capture refresh on top.)
    expect((removedAt.t || performance.now()) - pressed).toBeLessThan(700);

    // No resurrection while the server confirms; focus is a real survivor.
    await new Promise((r) => setTimeout(r, 1500));
    expect(paneIds(canvas)).not.toContain(doomed);
    expect(activePaneId()).toMatch(/^%\d+$/);
    expect(activePaneId()).not.toBe(doomed);
    glitches.assertNoGlitches('kill');
  },
};

/**
 * 2.2 — Zoom is optimistic: C-a `z` retargets the active pane's grid box to
 * ~the full container within a few frames of the keypress (ZoomToggle
 * prediction — geometry only, exactly what the server's visible_layout does).
 * Unzoom round-trips (the pre-zoom slot is unknown client-side by design) and
 * must restore both panes' rects.
 */
export const ZoomOptimisticTimeline: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const id = activePaneId();
    const el = paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!;
    const wrapper = el.closest('.pane-layout-item') as HTMLElement;
    // Let the boot-time client resize (refresh-client -C to the container
    // size) fully land before capturing reference geometry — two stable
    // samples 400ms apart.
    for (let i = 0; i < 20; i++) {
      const a = wrapper.getBoundingClientRect().width;
      await new Promise((r) => setTimeout(r, 400));
      if (wrapper.getBoundingClientRect().width === a) break;
    }
    // Compare against the PANE GRID extent (the grid is centered inside the
    // wider .pane-layout container), not the container itself.
    const wrappers = Array.from(canvasElement.querySelectorAll('.pane-layout-item'));
    const rects = wrappers.map((w) => w.getBoundingClientRect());
    const gridLeft = Math.min(...rects.map((r) => r.left));
    const gridRight = Math.max(...rects.map((r) => r.right));
    const gridTop = Math.min(...rects.map((r) => r.top));
    const gridBottom = Math.max(...rects.map((r) => r.bottom));
    const gridW = gridRight - gridLeft;
    const gridH = gridBottom - gridTop;
    const before = wrapper.getBoundingClientRect();
    expect(before.width).toBeLessThan(gridW * 0.8);

    await user.keyboard('{Control>}a{/Control}');
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    const probe = armPaintProbe(
      wrapper,
      (rec) => rec.type === 'attributes' && rec.attributeName === 'style',
    );
    await user.keyboard('z');
    const frames = await probe.wait(5, 5000);
    expect(frames).toBeLessThanOrEqual(5);

    // The zoomed pane must reach ~full container size (CSS transition may
    // still be animating — wait on the final rect).
    await waitFor(
      () => {
        const r = wrapper.getBoundingClientRect();
        expect(r.width).toBeGreaterThan(gridW * 0.9);
        expect(r.height).toBeGreaterThan(gridH * 0.85);
      },
      { timeout: 5000, interval: 200 },
    );

    // Let the zoom CONFIRM server-side before toggling back — a rapid
    // re-toggle races tmux's layout-change coalescing (that resilience is
    // covered by the store's idle-reconcile supersede, unit-tested in
    // ops.test.ts); this story verifies the clean zoom → unzoom round-trip.
    await new Promise((r) => setTimeout(r, 1500));

    // The zoom landed in a single suppressed snap — no flicker, no attribute
    // churn, no intermediate geometry frames (suppressLayoutTransition rides
    // the same commit as the zoom's rect change).
    glitches.assertNoGlitches('zoom');

    // Unzoom: server round-trip restores the original layout.
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('z');
    await waitFor(
      () => {
        const r = wrapper.getBoundingClientRect();
        expect(Math.abs(r.width - before.width)).toBeLessThan(20);
      },
      { timeout: 15000, interval: 300 },
    );
  },
};

/**
 * 2.3 — Kill window (tab), optimistic: C-a `&` removes the active tab via the
 * KillWindow prediction — the tab strip drops the tab within the exit grace,
 * an adjacent tab activates, and the server confirm never flaps it back.
 */
export const TabKillOptimistic: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy tab create');
    await waitFor(() => expect(tabWindows().length).toBe(2), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 30000, interval: 500 });
    const doomedWindow = activeWindow()!.id;

    // Focus a pane in the new tab so the keybinding targets it.
    await user.click(paneGroups(canvas)[0]);
    await waitFor(() => expect(activePaneId()).toMatch(/^%\d+$/), { timeout: 10000 });

    await user.keyboard('{Control>}a{/Control}');
    const pressed = performance.now();
    await user.keyboard('{Shift>}7{/Shift}'); // '&'

    await waitFor(() => expect(windowTabEls(canvas).length).toBe(1), {
      timeout: 5000,
      interval: 100,
    });
    const droppedAfter = performance.now() - pressed;
    expect(droppedAfter).toBeLessThan(1200);

    // Stays dropped through the server confirm; the surviving tab is active.
    await new Promise((r) => setTimeout(r, 1500));
    expect(windowTabEls(canvas).length).toBe(1);
    expect(windows().every((w) => w.id !== doomedWindow)).toBe(true);
    expect(activeWindow()?.id).toMatch(/^@\d+$/);
    expect(activePaneId()).toMatch(/^%\d+$/);
  },
};

/**
 * 2.4 — Rename tab, optimistic, all-mouse+keyboard: right-click the tab →
 * "Rename Tab" opens the client-side command prompt pre-filled with the
 * current name; submitting dispatches `rename-window` through the
 * RenameWindow prediction — the tab label flips within a few frames of
 * Enter, then the real `%window-renamed` confirms it (no flap back).
 */
export const RenameTabOptimistic: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const tabEl = windowTabEls(canvas)[0];

    tabEl.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 30 }),
    );
    const renameItem = await canvas.findByText('Rename Tab', undefined, { timeout: 5000 });
    await user.click(renameItem);

    // The client-side command prompt opens pre-filled with the current name.
    const input = (await waitFor(
      () => {
        const el = canvasElement.querySelector('.tmux-command-input') as HTMLInputElement | null;
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 10000, interval: 200 },
    )) as HTMLInputElement;

    await user.clear(input);
    await user.type(input, 'STORY_RENAMED');

    const probe = armPaintProbe(
      canvasElement,
      (rec) =>
        (rec.target instanceof Element ? rec.target : rec.target.parentElement)?.closest?.(
          '[role="tab"]',
        ) != null,
    );
    await user.keyboard('{Enter}');
    await probe.wait(5, 5000);
    expect(windowTabEls(canvas)[0].textContent).toContain('STORY_RENAMED');

    // The real %window-renamed confirms — the label must not flap back.
    await new Promise((r) => setTimeout(r, 2000));
    expect(windowTabEls(canvas)[0].textContent).toContain('STORY_RENAMED');
    expect(
      windows()[0]?.name === 'STORY_RENAMED' || tabWindows()[0]?.name === 'STORY_RENAMED',
    ).toBe(true);
  },
};

// ─────────── §14 Interaction edge cases: prefix, IME, wheel, menus ───────────

/** The active pane's full reconstructed state (for inMode/alternateOn checks). */
const activePaneState = () =>
  (
    window as unknown as {
      app: {
        getSnapshot(): {
          context: {
            activePaneId: string;
            panes: { tmuxId: string; inMode: boolean; alternateOn: boolean }[];
          };
        };
      };
    }
  ).app
    .getSnapshot()
    .context.panes.find((p) => p.tmuxId === activePaneId());

/**
 * 3.1 — Double-click selects the word under the cursor via CLIENT-side copy
 * mode (the rework moved word/line selection out of tmux): the word renders
 * highlighted (`.terminal-selected`), and `y` yanks it and leaves copy mode.
 * Triple-click selects the whole logical line the same way. The yank's
 * clipboard payload is the asserted selection text (both come from
 * extractSelectedText); the execCommand copy itself needs real user
 * activation, which synthetic story input cannot grant.
 */
export const DoubleTripleClickSelect: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const id = activePaneId();
    pasteLine('echo WORDSEL_TARGET extra words here');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            (p.textContent ?? '').includes('WORDSEL_TARGET'),
          ),
        ).toBe(true),
      { timeout: 20000, interval: 500 },
    );

    // Double-click inside the rendered OUTPUT word (2nd occurrence — the echo
    // result, not the typed command line).
    const span = Array.from(canvasElement.querySelectorAll('.terminal-line span'))
      .filter((sp) => (sp.textContent ?? '').includes('WORDSEL_TARGET'))
      .pop() as HTMLElement;
    expect(span).toBeTruthy();
    const r = span.getBoundingClientRect();
    const idx = (span.textContent ?? '').indexOf('WORDSEL_TARGET');
    const chW = r.width / Math.max(1, (span.textContent ?? '').length);
    const cx = r.left + (idx + 4) * chW;
    const cy = r.top + r.height / 2;
    span.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, detail: 2, clientX: cx, clientY: cy }),
    );

    // The word — and ONLY the word — renders highlighted.
    await waitFor(
      () => {
        const selected = Array.from(canvasElement.querySelectorAll('.terminal-selected'))
          .map((el) => el.textContent ?? '')
          .join('');
        expect(selected).toBe('WORDSEL_TARGET');
      },
      { timeout: 20000, interval: 300 },
    );

    // `y` yanks the highlighted text and exits copy mode. (The clipboard
    // write itself rides document.execCommand('copy'), which headless
    // Chromium only honours with real user activation — the payload equals
    // the `.terminal-selected` text asserted above, extracted by the same
    // extractSelectedText call the yank uses.)
    await user.keyboard('y');
    await waitFor(() => expect(paneCopyState(id)).toBeFalsy(), { timeout: 10000, interval: 300 });

    // Yank-exit starts a 2s copy-mode re-entry cooldown (guards against
    // scroll-exit bounce) — pause past it like a real user would before the
    // next gesture.
    await new Promise((r) => setTimeout(r, 2200));

    // Triple-click: the whole logical line highlights; `y` yanks it. The yank
    // remounted the terminal (scrollback view → live view), so the pre-yank
    // `span` node is detached — hit-test a FRESH element at the same point,
    // like a real pointer would.
    const target = canvasElement.ownerDocument.elementFromPoint(cx, cy)!;
    expect(target).toBeTruthy();
    target.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, detail: 3, clientX: cx, clientY: cy }),
    );
    target.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, detail: 3, clientX: cx, clientY: cy }),
    );
    await waitFor(
      () => {
        const selected = Array.from(canvasElement.querySelectorAll('.terminal-selected'))
          .map((el) => el.textContent ?? '')
          .join('');
        expect(selected).toMatch(/WORDSEL_TARGET extra words here/);
      },
      { timeout: 20000, interval: 300 },
    );
    await user.keyboard('y');

    // Copy mode exited — the pane is a live shell again.
    await waitFor(() => expect(paneCopyState(id)).toBeFalsy(), { timeout: 10000, interval: 300 });
  },
};

/**
 * 3.2 — Tab context menu, pure mouse: right-click a tab → "New Tab" creates a
 * real window; right-click the new tab → "Close Tab" kills it. Covers the
 * WindowTabs context-menu paths (menu-driven new-window and the index-targeted
 * kill-window).
 */
export const TabContextMenuOps: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const before = realTabWindows().length;

    windowTabEls(canvas)[0].dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 30 }),
    );
    await user.click(await canvas.findByText('New Tab', undefined, { timeout: 5000 }));
    await waitFor(
      () => {
        expect(realTabWindows().length).toBe(before + 1);
        expect(windowTabEls(canvas).length).toBe(before + 1);
      },
      { timeout: 30000, interval: 500 },
    );

    // Close the newly-created tab via its context menu.
    const tabs = windowTabEls(canvas);
    tabs[tabs.length - 1].dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 30 }),
    );
    await user.click(await canvas.findByText('Close Tab', undefined, { timeout: 5000 }));
    await waitFor(
      () => {
        expect(realTabWindows().length).toBe(before);
        expect(windowTabEls(canvas).length).toBe(before);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * 3.3 — Prefix lifecycle: an armed prefix expires after its timeout (the next
 * keys are literal input again), and a double prefix sends a literal C-a to
 * the shell (readline beginning-of-line — proven by inserting text at the
 * start of a pre-typed line).
 */
export const PrefixTimeoutAndDoublePrefix: Story = {
  args: { height: 600 },
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
 * 3.4 — Repeat (-r) bindings: C-a H H H fires three resizes from ONE prefix
 * arm (each repeat keeps prefix mode alive, matching tmux). The pane must
 * shrink by ~15 columns total; a broken repeat would resize once and type
 * literal "HH" into the shell.
 */
export const RepeatResizeBindings: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    // Focus the RIGHT pane so resize-pane -L moves its left divider.
    const [a, b] = paneIds(canvas);
    const rightId = paneRect(canvas, a).left > paneRect(canvas, b).left ? a : b;
    const rightEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === rightId,
    )!;
    await user.click(rightEl);
    await waitFor(() => expect(activePaneId()).toBe(rightId), { timeout: 15000, interval: 200 });
    await settleGeometry(canvas);

    const before = paneRect(canvas, rightId).width;
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('{Shift>}H{/Shift}');
    await user.keyboard('{Shift>}H{/Shift}');
    await user.keyboard('{Shift>}H{/Shift}');
    // ~15 columns wider (resize -L on the right pane grows it leftward).
    await waitFor(
      () => expect(Math.abs(paneRect(canvas, rightId).width - before)).toBeGreaterThan(100),
      { timeout: 30000, interval: 500 },
    );
    // And it sticks (server-confirmed geometry, no snap-back).
    const resized = paneRect(canvas, rightId).width;
    await new Promise((r) => setTimeout(r, 2000));
    expect(Math.abs(paneRect(canvas, rightId).width - resized)).toBeLessThan(15);
  },
};

/**
 * 3.5 — IME composition: composed CJK text is suppressed during composition
 * and sent as ONE literal on compositionend — rendered back from the real
 * `%output` stream (send-keys -l → tmux → bash echo → renderer).
 */
export const IMEComposition: Story = {
  args: { height: 600 },
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
  args: { height: 600 },
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

/**
 * 3.7 — Status bar gestures are a browser no-op (drag/maximize are
 * Tauri-only): double-clicking the empty status bar must not error, emit tmux
 * commands, or disturb the layout. Pins the guard contract.
 */
export const StatusBarNoOpGestures: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    await settleGeometry(canvas);
    const sigBefore = rectSignature(canvas);
    const bar = canvasElement.querySelector('.statusbar') as HTMLElement;
    expect(bar).not.toBeNull();
    bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
    bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    await new Promise((r) => setTimeout(r, 800));
    expect(rectSignature(canvas)).toBe(sigBefore);
    expect(activePaneId()).toMatch(/^%\d+$/);
  },
};

/**
 * 3.9 — Wheel in an alternate-screen app: with the alt screen active the
 * wheel becomes ARROW KEYS for the application (bash history recall proves
 * the Up arrows arrived) and native copy mode is NOT entered; back on the
 * main screen, the wheel scrolls into history via copy mode again. The alt
 * screen is driven by the real \\033[?1049h/l sequences (the guest's busybox
 * pager never uses it).
 */
export const WheelInAlternateScreen: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    // Unique history marker, then enter the alternate screen.
    pasteLine('echo WHEEL_HIST_MARK');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            (p.textContent ?? '').includes('WHEEL_HIST_MARK'),
          ),
          'history marker echoed',
        ).toBe(true),
      { timeout: 20000, interval: 500 },
    );
    pasteLine("printf '\\033[?1049h'");
    await waitFor(() => expect(activePaneState()?.alternateOn, 'alt screen entered').toBe(true), {
      timeout: 20000,
      interval: 400,
    });

    const paneEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === activePaneId(),
    )!;
    // Wheel UP on the alt screen → Up arrows → bash recalls the printf line.
    for (let i = 0; i < 3; i++) {
      paneEl.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -60, bubbles: true, cancelable: true }),
      );
      await new Promise((r) => setTimeout(r, 150));
    }
    await waitFor(
      () => {
        expect(activePaneState()?.inMode, 'no copy mode in alt screen').toBe(false);
        // Several Ups walk to the oldest history entry — the marker command.
        expect(
          (paneEl.textContent ?? '').includes('WHEEL_HIST_MARK'),
          'Up arrows recalled history in alt screen',
        ).toBe(true);
      },
      { timeout: 20000, interval: 500 },
    );

    // Clear the recalled line, leave the alt screen.
    await user.keyboard('{Control>}c{/Control}');
    await new Promise((r) => setTimeout(r, 800));
    pasteLine("printf '\\033[?1049l'");
    await waitFor(() => expect(activePaneState()?.alternateOn, 'alt screen exited').toBe(false), {
      timeout: 20000,
      interval: 400,
    });

    // Main screen: create scrollback (copy-mode entry requires history),
    // then wheel UP scrolls into it via native copy mode.
    pasteLine('seq 1 100');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            /99100/.test((p.textContent ?? '').replace(/\s+/g, '')),
          ),
          'seq output rendered',
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
    // The wheel→copy-mode entry requires the CLIENT to know scrollback
    // exists (history_size arrives on the next list-panes sync) — wait for
    // it like a user watching the scrollbar appear.
    await waitFor(
      () =>
        expect(
          (activePaneState() as unknown as { historySize?: number } | undefined)?.historySize ?? 0,
          'client sees scrollback',
        ).toBeGreaterThan(0),
      { timeout: 20000, interval: 400 },
    );
    for (let i = 0; i < 6; i++) {
      // Re-query per tick — the element can be replaced across the
      // alt-screen transitions, and a detached node's events go nowhere.
      const el = paneGroups(canvas).find(
        (p: HTMLElement) => p.getAttribute('data-pane-id') === activePaneId(),
      )!;
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 250));
    }
    await waitFor(
      () => expect(activePaneState()?.inMode, 'wheel-up entered copy mode').toBe(true),
      { timeout: 15000, interval: 300 },
    );
    await user.keyboard('q');
    await waitFor(() => expect(activePaneState()?.inMode, 'q exited copy mode').toBe(false), {
      timeout: 10000,
      interval: 300,
    });
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
  args: { height: 600 },
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

/**
 * 4.4 — Theme switch is one clean swap: flipping the theme via the app menu
 * rewrites one stylesheet href — the pane grid must see NO node flicker, at
 * most a bounded class churn, and zero geometry movement.
 */
export const ThemeSwitchChurn: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await waitFor(
      () =>
        expect(
          (
            window as unknown as {
              app: { getSnapshot(): { context: { availableThemes: unknown[] } } };
            }
          ).app.getSnapshot().context.availableThemes.length,
        ).toBeGreaterThan(0),
      { timeout: 15000, interval: 500 },
    );
    const doc = canvasElement.ownerDocument;
    await settleGeometry(canvas);

    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    const menu = await openAppMenu(canvasElement, user);
    await user.click(await menu.item(/^Theme$/));
    await user.click(await menu.item(/Nord/));
    await waitFor(
      () =>
        expect(doc.getElementById('tmuxy-theme')?.getAttribute('href')).toBe('/themes/nord.css'),
      { timeout: 10000, interval: 300 },
    );
    await new Promise((r) => setTimeout(r, 800));
    glitches.assertNoGlitches('theme');

    // Restore the default theme for the shared engine's next story.
    (window as unknown as { app: { send(e: { type: string; name: string }): void } }).app.send({
      type: 'SET_THEME',
      name: 'default',
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
  args: { height: 600 },
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
 * Swap keeps content in the correct lines: two panes of DIFFERENT heights are
 * each filled with a distinct run of consecutive numbers, then swapped with
 * `swap-pane`. A rAF sampler watches every painted frame THROUGH the swap and
 * asserts no pane ever renders its numbers out of order (a "wrong lines" glitch
 * would break the +1 run), and after the swap settles each pane still shows a
 * clean consecutive run ending at ITS OWN last value (so the right content
 * landed at the right rows, top-aligned in the pane) — driven by real tmux.
 */
export const SwapKeepsContentInCorrectLines: Story = {
  args: { height: 600 },
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
    const findPane = (id: string) =>
      paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!;
    const byTop = () =>
      paneIds(canvas)
        .map((id) => ({ id, top: paneRect(canvas, id).top }))
        .sort((a, b) => a.top - b.top)
        .map((x) => x.id);

    // Collapse to one pane, then build an UNEVEN vertical stack (mild resize so
    // neither pane collapses to a header-only row).
    const ids0 = paneIds(canvas);
    cmd(`kill-pane -t ${ids0[1]}`);
    await waitFor(() => expect(paneGroups(canvas).length).toBe(1), {
      timeout: 20000,
      interval: 300,
    });
    cmd('split-window -v');
    await waitFor(() => expect(paneGroups(canvas).length).toBe(2), {
      timeout: 20000,
      interval: 300,
    });
    let [top, bottom] = byTop();
    cmd(`resize-pane -t ${bottom} -U 4`);
    await sleep(800);
    [top, bottom] = byTop();

    const fill = async (id: string, from: number, to: number) => {
      await user.click(findPane(id));
      await waitFor(() => expect(activePaneId()).toBe(id), { timeout: 15000, interval: 200 });
      pasteLine(`seq ${from} ${to}`);
      await waitFor(() => expect(findPane(id).textContent ?? '').toContain(String(to)), {
        timeout: 30000,
        interval: 400,
      });
    };
    await fill(top, 100, 200);
    await fill(bottom, 500, 640);

    // Visible consecutive-number run for a pane: its rendered `.terminal-line`s
    // inside the pane content box, top-to-bottom, as an integer array.
    const numbersOf = (id: string): number[] => {
      const g = paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id);
      if (!g) return [];
      const cRect = (g.querySelector('.pane-content') as HTMLElement)?.getBoundingClientRect();
      return (Array.from(g.querySelectorAll('.terminal-line')) as HTMLElement[])
        .map((l) => ({ top: l.getBoundingClientRect().top, t: (l.textContent ?? '').trim() }))
        .filter((x) => cRect && x.top >= cRect.top - 1 && x.top <= cRect.bottom)
        .sort((a, b) => a.top - b.top)
        .map((x) => (/^\d+$/.test(x.t) ? Number(x.t) : NaN))
        .filter((v) => !Number.isNaN(v));
    };
    const breaks = (ns: number[]): number => {
      let b = 0;
      for (let i = 1; i < ns.length; i++) if (ns[i] !== ns[i - 1] + 1) b++;
      return b;
    };

    // Frame-sample the worst out-of-order break across both panes through the swap.
    let worstBreaks = 0;
    let sampling = true;
    const tick = () => {
      if (!sampling) return;
      const frameBreaks = paneIds(canvas).reduce((sum, id) => sum + breaks(numbersOf(id)), 0);
      if (frameBreaks > worstBreaks) worstBreaks = frameBreaks;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // Swap the two (differently-sized) panes.
    cmd(`swap-pane -U -t ${bottom}`);
    await sleep(2200);
    sampling = false;

    // Content must never have rendered out of order at any painted frame.
    expect(worstBreaks, 'terminal content rendered in wrong lines during swap').toBe(0);

    // After settle: each value-run is still consecutive and ends at its own max,
    // so the right content is at the right rows (100..200 and 500..640 swapped
    // positions but kept their integrity).
    const runs = paneIds(canvas).map((id) => numbersOf(id));
    for (const ns of runs) {
      expect(ns.length).toBeGreaterThan(2);
      expect(breaks(ns)).toBe(0);
    }
    const maxes = runs.map((ns) => ns[ns.length - 1]).sort((a, b) => a - b);
    expect(maxes).toEqual([200, 640]);
  },
};

/**
 * Drag-swap keeps content in the correct lines: two equal-height stacked panes,
 * each filled with a distinct consecutive-number run, are swapped by dragging
 * the top pane's header down onto the bottom pane (the drag-machine path —
 * mousedown, cross the threshold, drop). A rAF sampler watches every painted
 * frame through the drag+drop asserting no pane ever renders its numbers out of
 * order, and after settling each pane still shows a clean consecutive run ending
 * at its own last value, is top-aligned in its content box, and its outer
 * layout item carries no leftover drag transform (which would push content into
 * the wrong absolute rows). Driven by real tmux via drag-and-drop.
 */
export const DragSwapKeepsContentInCorrectLines: Story = {
  args: { height: 600 },
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
    const findPane = (id: string) =>
      paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!;
    const byTop = () =>
      paneIds(canvas)
        .map((id) => ({ id, top: paneRect(canvas, id).top }))
        .sort((a, b) => a.top - b.top)
        .map((x) => x.id);

    // Equal-height vertical stack.
    const ids0 = paneIds(canvas);
    cmd(`kill-pane -t ${ids0[1]}`);
    await waitFor(() => expect(paneGroups(canvas).length).toBe(1), {
      timeout: 20000,
      interval: 300,
    });
    cmd('split-window -v');
    await waitFor(() => expect(paneGroups(canvas).length).toBe(2), {
      timeout: 20000,
      interval: 300,
    });
    await sleep(500);
    let [top, bottom] = byTop();

    const fill = async (id: string, from: number, to: number) => {
      await user.click(findPane(id));
      await waitFor(() => expect(activePaneId()).toBe(id), { timeout: 15000, interval: 200 });
      pasteLine(`seq ${from} ${to}`);
      await waitFor(() => expect(findPane(id).textContent ?? '').toContain(String(to)), {
        timeout: 30000,
        interval: 400,
      });
    };
    await fill(top, 100, 200);
    await fill(bottom, 500, 640);
    [top, bottom] = byTop();

    const numbersOf = (id: string): number[] => {
      const g = paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id);
      if (!g) return [];
      const cRect = (g.querySelector('.pane-content') as HTMLElement)?.getBoundingClientRect();
      return (Array.from(g.querySelectorAll('.terminal-line')) as HTMLElement[])
        .map((l) => ({ top: l.getBoundingClientRect().top, t: (l.textContent ?? '').trim() }))
        .filter((x) => cRect && x.top >= cRect.top - 1 && x.top <= cRect.bottom)
        .sort((a, b) => a.top - b.top)
        .map((x) => (/^\d+$/.test(x.t) ? Number(x.t) : NaN))
        .filter((v) => !Number.isNaN(v));
    };
    const breaks = (ns: number[]): number => {
      let b = 0;
      for (let i = 1; i < ns.length; i++) if (ns[i] !== ns[i - 1] + 1) b++;
      return b;
    };

    // Frame-sample worst out-of-order breaks across both panes through the drag.
    let worstBreaks = 0;
    let sampling = true;
    const tick = () => {
      if (!sampling) return;
      const frameBreaks = paneIds(canvas).reduce((sum, id) => sum + breaks(numbersOf(id)), 0);
      if (frameBreaks > worstBreaks) worstBreaks = frameBreaks;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // Drag the TOP pane's header down onto the BOTTOM pane.
    const header = findPane(top).querySelector('.pane-header') as HTMLElement;
    const hRect = header.getBoundingClientRect();
    const dstRect = paneRect(canvas, bottom);
    const sX = hRect.left + hRect.width / 2;
    const sY = hRect.top + hRect.height / 2;
    const eX = dstRect.left + dstRect.width / 2;
    const eY = dstRect.top + dstRect.height / 2;
    const dstEl = findPane(bottom);
    header.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: sX, clientY: sY, bubbles: true }),
    );
    for (let i = 1; i <= 6; i++) {
      (i <= 2 ? header : dstEl).dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: sX + ((eX - sX) * i) / 6,
          clientY: sY + ((eY - sY) * i) / 6,
          bubbles: true,
        }),
      );
      await sleep(120);
    }
    dstEl.dispatchEvent(new MouseEvent('mouseup', { clientX: eX, clientY: eY, bubbles: true }));

    // The swap must land (positions exchanged), then content settles.
    await waitFor(() => expect(byTop()[0]).toBe(bottom), { timeout: 30000, interval: 400 });
    await sleep(1500);
    sampling = false;

    // Never rendered out of order during the whole drag.
    expect(worstBreaks, 'terminal content rendered in wrong lines during drag-swap').toBe(0);

    // After settle: each pane's run is consecutive, ends at its own max, is
    // top-aligned, and its outer layout item has no leftover drag transform.
    const runs = paneIds(canvas).map((id) => numbersOf(id));
    for (const ns of runs) {
      expect(ns.length).toBeGreaterThan(2);
      expect(breaks(ns)).toBe(0);
    }
    expect(runs.map((ns) => ns[ns.length - 1]).sort((a, b) => a - b)).toEqual([200, 640]);
    for (const id of paneIds(canvas)) {
      const item = canvasElement.querySelector(
        `.pane-layout-item[data-pane-id="${id}"]`,
      ) as HTMLElement;
      const t = getComputedStyle(item).transform;
      // Identity / none — no residual translate that would offset the content.
      const translated =
        t !== 'none' && /matrix\([^)]*\)/.test(t) && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(t);
      expect(translated, `pane ${id} has a leftover drag transform: ${t}`).toBe(false);
    }
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
  args: { height: 600 },
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
  args: { height: 600 },
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

/**
 * New-tab regression (two bugs, real tmux):
 *  1. Creating a tab must not flash a transient EXTRA tab. A `break-pane` tags
 *     the new window `@tmuxy-window-type=tab` a beat before its pane settles;
 *     the optimistic store must hide that tab-typed-but-paneless newborn (it
 *     stands the placeholder in for it) so the tab bar never shows a 3rd tab
 *     that blinks away. A MutationObserver over the tab list catches the blink.
 *  2. The new tab's pane must show its FIRST terminal row. New windows are born
 *     without `pane-border-status top` unless it's set globally, which would
 *     leave the pane at y=0 where the 24px PaneHeader steals row 0. The row must
 *     render fully below the header.
 */
export const NewTabNoBlinkFirstRowVisible: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const tabList = canvasElement.querySelector('.tab-list') as HTMLElement;
    const tabCount = () => tabList.querySelectorAll('.tab-name').length;
    const before = tabCount();

    // Bug 1: watch the tab bar for any transient tab beyond the one we create.
    let maxTabs = before;
    const obs = new MutationObserver(() => {
      maxTabs = Math.max(maxTabs, tabCount());
    });
    obs.observe(tabList, { childList: true, subtree: true, attributes: true });
    let running = true;
    const tick = () => {
      if (!running) return;
      maxTabs = Math.max(maxTabs, tabCount());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const add = await canvas.findByRole('button', { name: /create new tab/i }, { timeout: 8000 });
    await user.click(add);
    await waitFor(() => expect(tabCount()).toBe(before + 1), { timeout: 30000, interval: 100 });
    await sleep(2500); // settle
    running = false;
    obs.disconnect();

    // Bug 1: the tab bar never held more than the one new tab (no blink).
    expect(
      maxTabs,
      `tab bar flashed ${maxTabs} tabs (expected at most ${before + 1})`,
    ).toBeLessThanOrEqual(before + 1);
    expect(tabCount()).toBe(before + 1);

    // Bug 2: the new tab's pane shows its first terminal row, fully below the
    // header (not clipped behind it).
    const wrapper = canvasElement.querySelector(
      '.pane-layout-item.pane-active .pane-wrapper',
    ) as HTMLElement;
    const header = wrapper.querySelector('.pane-header') as HTMLElement;
    const firstLine = wrapper.querySelector('.pane-content .terminal-line') as HTMLElement;
    expect(header).not.toBeNull();
    expect(firstLine).not.toBeNull();
    const hb = header.getBoundingClientRect();
    const fb = firstLine.getBoundingClientRect();
    expect(
      fb.top,
      `first terminal row (top=${Math.round(fb.top)}) is hidden behind the header (bottom=${Math.round(hb.bottom)})`,
    ).toBeGreaterThanOrEqual(hb.bottom - 1);
  },
};
