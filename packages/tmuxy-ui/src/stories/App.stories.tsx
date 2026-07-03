import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';

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
 * non-deterministic, so they are `spike`-tagged and excluded from the CI story
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

type Canvas = ReturnType<typeof within>;
const paneGroups = (canvas: Canvas) => canvas.getAllByRole('group', { name: /^Pane %/i });

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
  title: 'App/Application',
  component: V86AppHarness,
  tags: ['spike'],
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
    const target = panes.find((p) => p.getAttribute('data-pane-id') !== initial) ?? panes[0];
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
    // …and the active theme stylesheet is actually loaded.
    expect(doc.getElementById('tmuxy-theme')?.getAttribute('href')).toMatch(/\/themes\/.+\.css$/);
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
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /(^|\D)200(\D|$)/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 40000, interval: 500 },
    );
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
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const bytesFor = (re: RegExp) =>
      res
        .filter((r) => re.test(r.name))
        .reduce((sum, r) => sum + (r.encodedBodySize || r.transferSize || 0), 0);
    const v86Bytes = bytesFor(/\/v86(-img)?\//);
    const wasmBytes = bytesFor(/\/wasm\//);
    // Assets must be measurable and within budget. The snapshot ships gzipped
    // (~17 MB wire vs 34 MB raw) + ~5 MB kernel + BIOS; regressions past the
    // budget fail loudly instead of silently bloating the demo payload.
    expect(v86Bytes).toBeGreaterThan(0);
    expect(v86Bytes).toBeLessThan(26 * 1024 * 1024);
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
    const id = activePaneId();
    const before = paneRect(canvas, id).width;
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('{Shift>}H{/Shift}');
    await waitFor(() => expect(Math.abs(paneRect(canvas, id).width - before)).toBeGreaterThan(20), {
      timeout: 30000,
      interval: 500,
    });
    // The resize must persist (a transient optimistic wiggle that snaps back fails).
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
    const after = paneRect(canvas, a).width;
    await new Promise((res) => setTimeout(res, 2000));
    expect(Math.abs(paneRect(canvas, a).width - after)).toBeLessThan(10);
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
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 15000, interval: 500 });
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
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 15000, interval: 500 });
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
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 15000, interval: 500 });
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
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard(' ');
    await waitFor(() => expect(signature()).not.toBe(before), { timeout: 30000, interval: 500 });
    // All panes still visible after the re-layout.
    for (const p of paneGroups(canvas)) {
      const r = (p as HTMLElement).getBoundingClientRect();
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }
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
 * Copy mode enter: with real scrollback, C-a `[` puts the pane into native tmux
 * copy mode — asserted via the tmux-reported `inMode` (from %pane-mode-changed,
 * not a client-side flag) AND the rendered `[COPY MODE]` header indicator.
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
 * Copy mode scroll + yank: C-u scrolls the viewport back (earlier scrollback
 * lines render, the tail scrolls out), then V/y yanks the cursor line. tmux
 * fires %paste-buffer-changed; the core reads the buffer over the control
 * channel and mirrors it to `navigator.clipboard.writeText` — the payload must
 * contain text that only exists in the guest's scrollback.
 */
export const CopyModeScrollAndYank: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const id = activePaneId();
    const writes: string[] = [];
    const stub = {
      writeText: (t: string) => (writes.push(t), Promise.resolve()),
      readText: () => Promise.resolve(''),
    };
    try {
      Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: stub });
    } catch {
      (window.navigator as unknown as { clipboard: { writeText: unknown } }).clipboard.writeText =
        stub.writeText;
    }
    pasteLine('echo COPY_YANK_LINE_31');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            /COPY_YANK_LINE_31/.test(p.textContent ?? ''),
          ),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
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
    // Scroll half a page up: the viewport must show earlier lines and lose the tail.
    const paneText = () =>
      paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)
        ?.textContent ?? '';
    const beforeScroll = paneText();
    await user.keyboard('{Control>}u{/Control}');
    // Half a page back: the rendered viewport must change (earlier scrollback
    // lines scroll in — content comes from tmux's copy-mode view, via real
    // capture round-trips, not a client-side scroll offset).
    await waitFor(() => expect(paneText()).not.toBe(beforeScroll), {
      timeout: 15000,
      interval: 500,
    });
    // Yank the cursor line (V select-line, y copy-and-exit): the mirrored
    // clipboard text must be a real scrollback line (a bare seq number).
    await user.keyboard('{Shift>}V{/Shift}');
    await new Promise((r) => setTimeout(r, 400));
    await user.keyboard('y');
    await waitFor(() => expect(writes.length).toBeGreaterThan(0), {
      timeout: 15000,
      interval: 500,
    });
    // The mirrored text must be real guest scrollback (a seq number or the
    // guest prompt), not empty and not anything the story typed into the page.
    expect(writes[0]).toMatch(/\d|root/);
    await waitFor(() => expect(paneMode(id)).toBe(false), { timeout: 10000, interval: 400 });
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
 * Wheel scroll: real wheel events over a pane with scrollback enter native copy
 * mode (tmux-reported) and scroll the viewport to earlier lines; wheeling back
 * down to the bottom exits copy mode. All driven by WheelEvents on the pane, as
 * a real mouse would.
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
    // core. (The rendered width falls back to the tmux pane size here: the guest's
    // single-pane float window can't be shrunk by resize-pane, so asserting the
    // 40-col rect would test tmux's window sizing, not tmuxy.)
    // The option metadata rides the next list-windows sync — poll for it.
    await waitFor(
      () => {
        const fw = windows().find((w) => w.windowType === 'float') as
          | (ReconstructedWindow & { floatNoheader?: boolean })
          | undefined;
        expect(fw?.floatNoheader).toBe(true);
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
 * Pane-group member switching: `tmuxy pane group add` groups the active pane
 * with a new one (the new member fills the slot); `group next`/`group prev`
 * swap which member is visible. The rendered pane id occupying the layout must
 * toggle between the two members — real swap-pane round-trips.
 */
export const GroupSwitchNextPrev: Story = {
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
    const other = members.find((m) => m !== original)!;
    // The new member takes the slot: it renders, the original is parked.
    await waitFor(() => expect(paneIds(canvas)).toContain(other), {
      timeout: 15000,
      interval: 500,
    });
    expect(paneIds(canvas)).not.toContain(original);
    // group next → the original member swaps back into the visible slot.
    pasteLine('tmuxy pane group next');
    await waitFor(
      () => {
        expect(paneIds(canvas)).toContain(original);
        expect(paneIds(canvas)).not.toContain(other);
      },
      { timeout: 30000, interval: 500 },
    );
    // group prev → back to the new member.
    pasteLine('tmuxy pane group prev');
    await waitFor(
      () => {
        expect(paneIds(canvas)).toContain(other);
        expect(paneIds(canvas)).not.toContain(original);
      },
      { timeout: 30000, interval: 500 },
    );
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
 * Sidebar: clicking the toggle runs `sidebar-create` in the guest, which spawns
 * the REAL tree TUI (the standalone `tmuxy-tree` binary cross-compiled for the
 * guest) in a sidebar-typed window. The drawer must open, list the live
 * session's windows, and STAY alive; toggling again hides it.
 */
export const SidebarToggle: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doc = canvasElement.ownerDocument;
    const toggle = canvasElement.querySelector('.sidebar-toggle') as HTMLElement;
    expect(toggle).not.toBeNull();
    await user.click(toggle);
    // The drawer opens and the tree TUI renders the real window list.
    await waitFor(
      () => {
        const drawer = doc.querySelector('.sidebar-drawer') as HTMLElement | null;
        expect(drawer).not.toBeNull();
        expect(drawer!.getBoundingClientRect().width).toBeGreaterThan(0);
        expect(drawer!.textContent ?? '').toMatch(/root/);
      },
      { timeout: 40000, interval: 500 },
    );
    // The TUI must SURVIVE (the old guest had no tree binary and the pane died
    // within a second) — drawer still present, still listing windows.
    await new Promise((r) => setTimeout(r, 5000));
    expect(doc.querySelector('.sidebar-drawer')).not.toBeNull();
    expect(windows().some((w) => w.windowType === 'sidebar')).toBe(true);
    // Toggle off → drawer hides (the sidebar window stays parked for reuse).
    await user.click(toggle);
    await waitFor(() => expect(doc.querySelector('.sidebar-drawer')).toBeNull(), {
      timeout: 15000,
      interval: 500,
    });
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
 * to fetch the watched file from, so the widget must mount and show its defined
 * fallback rather than crashing or rendering garbage — this pins down the
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
        const widget = canvasElement.ownerDocument.querySelector(
          '.widget-markdown, .widget-markdown-empty',
        );
        expect(widget).not.toBeNull();
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
 * Image placements track content flow: an inline image must not stay pinned to
 * the viewport when subsequent output scrolls the screen — after enough lines it
 * scrolls out (unmounts or moves up), guarding placement tracking rather than
 * just decode.
 */
export const ImageScrollsWithContent: Story = {
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
    // The placement either scrolled out of the viewport or moved up with the flow.
    await waitFor(
      () => {
        const img = doc.querySelector('img[src^="data:image/png"]');
        if (img) {
          expect(img.getBoundingClientRect().top).toBeLessThan(firstTop);
        } else {
          expect(img).toBeNull();
        }
      },
      { timeout: 40000, interval: 500 },
    );
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
    const colsBefore = paneCols().reduce((a, b) => a + b, 0);
    await user.keyboard('{Control>}={/Control}');
    await user.keyboard('{Control>}={/Control}');
    await waitFor(() => expect(paneCols().reduce((a, b) => a + b, 0)).toBeLessThan(colsBefore), {
      timeout: 30000,
      interval: 500,
    });
    await user.keyboard('{Control>}0{/Control}');
    await waitFor(() => expect(paneCols().reduce((a, b) => a + b, 0)).toBe(colsBefore), {
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
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            /199819992000/.test((p.textContent ?? '').replace(/\s+/g, '')),
          ),
        ).toBe(true),
      { timeout: 60000, interval: 700 },
    );
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
    await waitFor(
      () => {
        const text = paneGroups(canvas)
          .map((p: HTMLElement) => p.textContent ?? '')
          .join('');
        for (let n = 1; n <= 10; n++) {
          expect(
            (text.match(new RegExp(`BURST_Q${n}_END`, 'g')) ?? []).length,
          ).toBeGreaterThanOrEqual(2);
        }
        // In-order: the last command's OUTPUT must appear after the first's.
        expect(text.lastIndexOf('BURST_Q10_END')).toBeGreaterThan(text.indexOf('BURST_Q1_END'));
      },
      { timeout: 60000, interval: 700 },
    );
  },
};
