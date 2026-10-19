import { expect, within, waitFor, userEvent } from 'storybook/test';
import { ResizeGlitchRecorder } from './resizeGlitch';

/**
 * Enter a command line by pasting it — a first-class real-user path (pasting a
 * command into a terminal is ubiquitous) that the keyboardActor handles via its
 * `paste` listener. Crucially, paste captures the send target (active pane) ONCE
 * and emits one `set-buffer` + `paste-buffer -p` pair, so the still-settling
 * v86 boot can't flap the target between characters. Per-keystroke send-keys
 * races that instability and drops/misroutes chars; paste is deterministic
 * while still driving the full real chain (keyboardActor → send-keys →
 * emulated tmux → bash → %output → WASM core → render).
 *
 * The line is then run with Enter, as a user runs a pasted one: the guest's
 * bash asks for bracketed paste, and a newline inside a bracketed paste is
 * text in the line, not a Return.
 */
export function pasteLine(text: string): void {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  window.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
  );
  const enter = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true };
  const target = document.activeElement ?? window;
  target.dispatchEvent(new KeyboardEvent('keydown', enter));
  target.dispatchEvent(new KeyboardEvent('keyup', enter));
}

export const activePaneId = () =>
  (
    window as unknown as { app: { getSnapshot(): { context: { activePaneId: string } } } }
  ).app.getSnapshot().context.activePaneId;

/** Measured terminal cell width in px (set by the sizeActor after font load). */
export const charWidthPx = () =>
  (
    window as unknown as { app: { getSnapshot(): { context: { charWidth: number } } } }
  ).app.getSnapshot().context.charWidth;

export type Canvas = ReturnType<typeof within>;
export const paneGroups = (canvas: Canvas) => canvas.getAllByRole('group', { name: /^Pane %/i });

/**
 * Progress-aware wait for a streamed output burst. Throughput stories guard
 * INTEGRITY (no dropped/corrupted bytes), not latency: on a loaded CI runner
 * the shared emulator streams arbitrarily slowly, and a fixed deadline flakes
 * exactly when the machine is busiest. Keeps waiting while the pane content
 * still makes progress; throws only when the stream stalls short of the
 * expected tail, or at a hard cap.
 */
export async function waitForBurstTail(
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
export async function focusFirstPane(
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
export type ReconstructedWindow = {
  id: string;
  name: string;
  index: number;
  active: boolean;
  windowType: string | null;
  floatDrawer: string | null;
};
export const windows = (): ReconstructedWindow[] =>
  (
    window as unknown as { app: { getSnapshot(): { context: { windows: ReconstructedWindow[] } } } }
  ).app.getSnapshot().context.windows;

/**
 * Pane groups keyed by group id (`@tmuxy-group-id`). Group membership is
 * intrinsic to panes now, not encoded in a group window, so these tests read
 * the reconstructed `paneGroups` map rather than scanning windows.
 */
export const paneGroupsState = (): Array<{ id: string; paneIds: string[] }> =>
  Object.values(
    (
      window as unknown as {
        app: {
          getSnapshot(): {
            context: { paneGroups: Record<string, { id: string; paneIds: string[] }> };
          };
        };
      }
    ).app.getSnapshot().context.paneGroups ?? {},
  );

/** A 1×1 PNG, base64 — small enough to inline in an iTerm2 image escape. */
export const INLINE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Reconstructed pane widths (in columns) from the live state. */
export const paneCols = (): number[] =>
  (window as unknown as { app: { getSnapshot(): { context: { panes: { width: number }[] } } } }).app
    .getSnapshot()
    .context.panes.map((p) => p.width);

export const sessionName = (): string =>
  (
    window as unknown as { app: { getSnapshot(): { context: { sessionName: string } } } }
  ).app.getSnapshot().context.sessionName;

/** Bounding rect of a pane by tmux id (throws if absent — assert presence first). */
export function paneRect(canvas: Canvas, id: string): DOMRect {
  const el = paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id);
  if (!el) throw new Error(`pane ${id} not rendered`);
  return el.getBoundingClientRect();
}

export const paneIds = (canvas: Canvas): string[] =>
  paneGroups(canvas).map((p: HTMLElement) => p.getAttribute('data-pane-id') ?? '');

/** Pick the horizontal (wide) or vertical (tall) `.resize-divider`. */
export function pickDivider(
  canvasElement: HTMLElement,
  kind: 'horizontal' | 'vertical',
): HTMLElement {
  const dividers = Array.from(canvasElement.querySelectorAll<HTMLElement>('.resize-divider'));
  const found = dividers.find((d) => {
    const r = d.getBoundingClientRect();
    return kind === 'horizontal' ? r.width > r.height : r.height > r.width;
  });
  if (!found) throw new Error(`no ${kind} resize divider (have ${dividers.length})`);
  return found;
}

/**
 * Wait for a divider of `kind` to exist, then return it.
 *
 * `settleGeometry` only proves the GRID has settled — it says nothing about
 * whether the story's `initCommands` have landed. Those are two different
 * waits, and a story that splits before it drags needs both: the split's
 * `%layout-change` can arrive after the geometry is already stable, leaving
 * `pickDivider` looking at the pre-split layout.
 *
 * That race used to be hidden. The harness was sized in pixels, so the app
 * always measured a grid the guest had not booted at and a resize round-trip
 * ran first — long enough for the split to land by accident. Now that the
 * harness asks for exactly the size the guest boots at (80x30), no resize
 * happens and the gap closes to nothing.
 */
export async function waitForDivider(
  canvasElement: HTMLElement,
  kind: 'horizontal' | 'vertical',
): Promise<HTMLElement> {
  let divider: HTMLElement | null = null;
  await waitFor(
    () => {
      divider = pickDivider(canvasElement, kind);
    },
    { timeout: 30000, interval: 250 },
  );
  return divider!;
}

/**
 * Drive a MONOTONIC divider drag with raw mouse events (the machine's
 * pointerTracker listens on window). Monotonic so the resulting geometry must
 * also be monotonic — any reversal the recorder catches is a real glitch.
 * Marks 'mouseup' on the recorder just before releasing.
 */
export async function dragDivider(
  divider: HTMLElement,
  recorder: ResizeGlitchRecorder,
  opts: { dx?: number; dy?: number; steps?: number },
): Promise<void> {
  const { dx = 0, dy = 0, steps = 8 } = opts;
  const doc = divider.ownerDocument;
  const r = divider.getBoundingClientRect();
  const startX = r.left + r.width / 2;
  const startY = r.top + r.height / 2;
  divider.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: startY, button: 0 }),
  );
  for (let i = 1; i <= steps; i++) {
    doc.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: startX + (dx * i) / steps,
        clientY: startY + (dy * i) / steps,
      }),
    );
    await new Promise((res) => setTimeout(res, 8));
  }
  recorder.mark('mouseup');
  doc.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, clientX: startX + dx, clientY: startY + dy }),
  );
}

/** Send a raw tmux command through the live app machine (structural ops). */
export function sendTmux(command: string): void {
  (window as unknown as { app: { send: (e: unknown) => void } }).app.send({
    type: 'SEND_TMUX_COMMAND',
    command,
  });
}

export const activeWindow = (): ReconstructedWindow | undefined => windows().find((w) => w.active);
export const tabWindows = (): ReconstructedWindow[] =>
  windows().filter((w) => w.windowType === 'tab');
// Real (tmux-confirmed) tab windows only — optimistic placeholder windows carry
// non-@ ids until reconciled and must not satisfy a "window created" assertion.
export const realTabWindows = (): ReconstructedWindow[] =>
  tabWindows().filter((w) => /^@\d+$/.test(w.id));
// WindowTabs bar entries only (pane-header tabs are also role=tab; the window
// tabs are distinguishable by their "Tab N: name" accessible name).
export const windowTabEls = (canvas: Canvas) => canvas.getAllByRole('tab', { name: /^Tab \d+:/ });

/** tmux-reported scrollback size of a pane (drives the wheel handler's gate). */
export const paneHistory = (id: string): number =>
  (
    window as unknown as {
      app: { getSnapshot(): { context: { panes: { tmuxId: string; historySize: number }[] } } };
    }
  ).app
    .getSnapshot()
    .context.panes.find((p) => p.tmuxId === id)?.historySize ?? 0;

/** tmux-reported copy-mode state of a pane (inMode comes from %pane-mode-changed). */
export const paneMode = (id: string): boolean =>
  (
    window as unknown as {
      app: { getSnapshot(): { context: { panes: { tmuxId: string; inMode: boolean }[] } } };
    }
  ).app
    .getSnapshot()
    .context.panes.find((p) => p.tmuxId === id)?.inMode === true;

/**
 * Client-side scrollback state of a pane — one record holding the loaded
 * history lines, the scroll offset and the selection, plus the `mode` saying
 * which view it is: the native-like `scroll` view or tmux's `copy` mode (see
 * COPY-MODE.md). Undefined when the pane is following live output.
 */
export type PaneScrollbackState = {
  mode: 'scroll' | 'copy';
  scrollTop: number;
  selectionMode: 'char' | 'line' | null;
  totalLines: number;
};

export const paneCopyState = (id: string): PaneScrollbackState | undefined =>
  (
    window as unknown as {
      app: {
        getSnapshot(): {
          context: { copyModeStates: Record<string, PaneScrollbackState> };
        };
      };
    }
  ).app.getSnapshot().context.copyModeStates[id];

/** Wait for the float overlay to render and return it. */
export async function waitForFloat(doc: Document): Promise<HTMLElement> {
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

/** Open the hamburger app menu and return a submenu-item clicker. */
/** Every role a menu item can carry, so a checkbox or radio item is findable too. */
export const MENU_ITEM_ROLES = '[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]';

/**
 * A menu item's label as a user HEARS it, not as the DOM spells it.
 *
 * A submenu item draws a `▶` and a radio item a bullet, both in `aria-hidden`
 * spans — decoration, correctly absent from the accessible name. Raw
 * `textContent` keeps them, so `/^Help$/` tested against "Help▶" and five
 * stories failed on markup no user or screen reader perceives.
 */
export function menuItemLabel(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The visible menu item whose label matches, waiting for the menu to render it. */
export async function findMenuItem(doc: Document, label: RegExp): Promise<HTMLElement> {
  let el: HTMLElement | undefined;
  await waitFor(
    () => {
      el = [...doc.querySelectorAll(MENU_ITEM_ROLES)].find((m) => label.test(menuItemLabel(m))) as
        | HTMLElement
        | undefined;
      expect(el).toBeTruthy();
    },
    { timeout: 10000, interval: 300 },
  );
  return el!;
}

export async function openAppMenu(
  canvasElement: HTMLElement,
  user: ReturnType<typeof userEvent.setup>,
) {
  const doc = canvasElement.ownerDocument;
  const btn = canvasElement.querySelector('.app-menu-button') as HTMLElement;
  expect(btn).not.toBeNull();
  await user.click(btn);
  return { item: (label: RegExp) => findMenuItem(doc, label) };
}

/** The rejection reaches the user as a snackbar entry. */
export const appError = (): string | null =>
  (
    window as unknown as {
      app: { getSnapshot(): { context: { notifications: { text: string }[] } } };
    }
  ).app.getSnapshot().context.notifications[0]?.text ?? null;

/** Sorted real (%N) pane ids currently rendered. */
export const realPaneIdsSorted = (canvas: Canvas): string[] =>
  paneIds(canvas)
    .filter((id) => /^%\d+$/.test(id))
    .sort();

/**
 * Wait for pane geometry to be at rest (two identical samples 400ms apart) —
 * the boot-time `refresh-client -C` resize can land seconds into a story and
 * invalidates any rect captured before it.
 */
export async function settleGeometry(canvas: Canvas): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const a = rectSignature(canvas);
    await new Promise((r) => setTimeout(r, 400));
    if (rectSignature(canvas) === a) return;
  }
  throw new Error('pane geometry never settled');
}

/** Stable geometry signature of every real pane, for exact-restore asserts. */
export const rectSignature = (canvas: Canvas): string =>
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
export function recordClassHistory(el: Element): {
  history: () => string[];
  disconnect: () => void;
} {
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
