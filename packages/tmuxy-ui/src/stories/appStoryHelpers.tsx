// v86 helpers: shared by the stories over real tmux, held to their blind-wait ceiling.
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { ResizeGlitchRecorder } from './resizeGlitch';
import { inputPause, tmuxCaughtUp, transitionsDone } from './tmuxBarrier';

/**
 * Enter a command line by pasting it, then run it with Enter. A paste reads
 * the send target once (one `set-buffer` + `paste-buffer -p`), so the
 * still-settling v86 boot cannot flap the active pane between characters the
 * way per-keystroke send-keys does. Enter is separate because the guest's bash
 * asks for bracketed paste, where a newline is text in the line, not a Return.
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
 * Waits while the pane content still makes progress; fails only on a stall
 * short of the tail, or at the cap. Throughput stories guard integrity, not
 * latency: on a loaded CI runner the emulator streams arbitrarily slowly, and
 * a fixed deadline flakes exactly when the machine is busiest.
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
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(sawTail(burstText())).toBe(true);
}

/**
 * Focus the first pane of the booted 2-pane session and wait for the
 * select-pane round trip. The still-settling v86 boot (its initial
 * list-panes/list-windows sync) flaps the active pane; without this wait,
 * input splits across panes.
 */
export async function focusFirstPane(
  canvas: Canvas,
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(2), {
    timeout: 45000,
    interval: 500,
  });
  // A click mid-sync races the select-pane against in-flight active-pane
  // updates and can be overridden for good.
  await waitFor(() => expect(activePaneId()).toMatch(/^%\d+$/), { timeout: 20000, interval: 200 });
  // Each story mounts at its own viewport: input while set_client_size is in
  // flight lets the re-layout land inside the story's glitch window, read as
  // phantom kill/split size jumps.
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

/** Pane groups keyed by group id (`@tmuxy-group-id`). */
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

/** Bounding rect of a pane by tmux id (throws if absent — assert presence first). */
export function paneRect(canvas: Canvas, id: string): DOMRect {
  const el = paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id);
  if (!el) throw new Error(`pane ${id} not rendered`);
  return el.getBoundingClientRect();
}

export const paneIds = (canvas: Canvas): string[] =>
  paneGroups(canvas).map((p: HTMLElement) => p.getAttribute('data-pane-id') ?? '');

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
 * `settleGeometry` does not prove the story's `initCommands` have landed: a
 * split's `%layout-change` can arrive after the geometry is already stable, so
 * a story that splits before it drags waits for the divider too.
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
 * A monotonic divider drag, so the geometry must be monotonic too: any
 * reversal the recorder catches is a real glitch.
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
    await inputPause(8);
  }
  recorder.mark('mouseup');
  doc.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, clientX: startX + dx, clientY: startY + dy }),
  );
}

export function sendTmux(command: string): void {
  (window as unknown as { app: { send: (e: unknown) => void } }).app.send({
    type: 'SEND_TMUX_COMMAND',
    command,
  });
}

export const activeWindow = (): ReconstructedWindow | undefined => windows().find((w) => w.active);
export const tabWindows = (): ReconstructedWindow[] =>
  windows().filter((w) => w.windowType === 'tab');
// Optimistic placeholder windows carry non-@ ids until reconciled and must not
// satisfy a "window created" assertion.
export const realTabWindows = (): ReconstructedWindow[] =>
  tabWindows().filter((w) => /^@\d+$/.test(w.id));
// Pane-header tabs are role=tab too; the window tabs are named "Tab N: name".
export const windowTabEls = (canvas: Canvas) => canvas.getAllByRole('tab', { name: /^Tab \d+:/ });

export const paneHistory = (id: string): number =>
  (
    window as unknown as {
      app: { getSnapshot(): { context: { panes: { tmuxId: string; historySize: number }[] } } };
    }
  ).app
    .getSnapshot()
    .context.panes.find((p) => p.tmuxId === id)?.historySize ?? 0;

/** inMode comes from tmux's %pane-mode-changed. */
export const paneMode = (id: string): boolean =>
  (
    window as unknown as {
      app: { getSnapshot(): { context: { panes: { tmuxId: string; inMode: boolean }[] } } };
    }
  ).app
    .getSnapshot()
    .context.panes.find((p) => p.tmuxId === id)?.inMode === true;

/** Undefined when the pane is following live output (docs/COPY-MODE.md). */
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

export const MENU_ITEM_ROLES = '[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]';

/**
 * A menu item's label as a screen reader hears it: the submenu `▶` and the
 * radio bullet are `aria-hidden` decoration that raw `textContent` keeps.
 */
export function menuItemLabel(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

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

export const realPaneIdsSorted = (canvas: Canvas): string[] =>
  paneIds(canvas)
    .filter((id) => /^%\d+$/.test(id))
    .sort();

/**
 * At rest means one more round trip changes nothing: the boot-time
 * `refresh-client -C` resize can land seconds into a story, and a fixed delay
 * lets a slow runner read "at rest" before it has even arrived.
 */
export async function settleGeometry(canvas: Canvas): Promise<void> {
  const layout = document.querySelector('.pane-layout');
  const atRest = async () => {
    await tmuxCaughtUp();
    if (layout) await transitionsDone(layout);
    return rectSignature(canvas);
  };
  let before = await atRest();
  for (;;) {
    const after = await atRest();
    if (after === before) return;
    before = after;
  }
}

export const rectSignature = (canvas: Canvas): string =>
  realPaneIdsSorted(canvas)
    .map((id: string) => {
      const r = paneRect(canvas, id);
      return `${id}:${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    })
    .join('|');

/**
 * Every value an element's `class` passes through: polling would miss a
 * single-frame revert of an optimistic highlight, the mutation log cannot.
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
