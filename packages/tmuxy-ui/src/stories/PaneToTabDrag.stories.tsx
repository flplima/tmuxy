/**
 * Dragging a pane onto the tab strip (demo engine).
 *
 * A pane header drag normally swaps panes inside the tab. Carried up to the
 * strip it means something else: the pane leaves this tab. Over another tab's
 * button it joins that tab; over the empty space after the last button it
 * becomes a tab of its own.
 *
 * The gesture belongs to the drag machine, which takes the pointer for the
 * whole drag, so the strip never sees an event — it only reads where the drop
 * would land and marks it. These stories drive the real mouse sequence
 * (a press, a move past the threshold, a move onto the strip, a release) and
 * check both halves: what the strip shows mid-drag, and what tmux ends up
 * holding after the release.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, fireEvent } from 'storybook/test';
import { AppHarness } from './StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Pane To Tab Drag',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Dropping a dragged pane on the tab strip: the tab under the pointer highlights and takes the pane, and the empty space past the last tab offers a new tab instead.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

interface Snap {
  context: {
    activeWindowId: string | null;
    windows: Array<{ id: string; windowType: string | null }>;
    panes: Array<{ tmuxId: string; windowId: string }>;
  };
}

function app(): Snap {
  const a = (window as unknown as { app?: { getSnapshot(): Snap } }).app;
  if (!a) throw new Error('window.app actor is not available — AppHarness not mounted?');
  return a.getSnapshot();
}

/** How many panes each tab holds, keyed by window id. */
function panesByWindow(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of app().context.panes) counts[p.windowId] = (counts[p.windowId] ?? 0) + 1;
  return counts;
}

function centreOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * The header of the pane that was split off, i.e. the last one in THIS tab.
 *
 * Every tab's panes are in the document, only one tab's are on screen, so
 * "the last header" would happily pick one belonging to the tab being dragged
 * to — and dropping a pane on the tab it already lives in does nothing.
 */
function lastPaneHeader(canvasElement: HTMLElement): HTMLElement {
  const here = new Set(
    app()
      .context.panes.filter((p) => p.windowId === app().context.activeWindowId)
      .map((p) => p.tmuxId),
  );
  const headers = [...canvasElement.querySelectorAll<HTMLElement>('.pane-layout-item')]
    .filter((item) =>
      here.has(item.querySelector<HTMLElement>('[data-pane-id]')?.dataset.paneId ?? ''),
    )
    .map((item) => item.querySelector<HTMLElement>('.pane-header'))
    .filter((h): h is HTMLElement => h !== null);
  if (headers.length < 2)
    throw new Error(`expected two panes in this tab, found ${headers.length}`);
  return headers[headers.length - 1];
}

/**
 * Press on the header and travel to (x, y), crossing the few pixels that turn
 * a press into a drag on the way — the same shape a hand makes.
 *
 * Each move is dispatched at whatever is under that point, the way the browser
 * does it, and reaches the document- and window-level listeners by bubbling.
 * Firing at the document instead would hand the handlers a target that is not
 * an element, which no real pointer ever does.
 */
function moveTo(x: number, y: number): void {
  const target = document.elementFromPoint(x, y) ?? document.body;
  fireEvent.mouseMove(target, { clientX: x, clientY: y });
}

async function dragHeaderTo(header: HTMLElement, x: number, y: number): Promise<void> {
  const from = centreOf(header);
  fireEvent.mouseDown(header, { clientX: from.x, clientY: from.y, button: 0, bubbles: true });
  for (const t of [0.05, 0.3, 0.6, 1]) {
    moveTo(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function waitForPanes(count: number, canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  await waitFor(
    () => expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(count),
    {
      timeout: 8000,
    },
  );
}

// ---------------------------------------------------------------------------
// Onto another tab — that tab lights up and takes the pane
// ---------------------------------------------------------------------------

export const DropsOnAnotherTab: Story = {
  args: {
    height: 500,
    initCommands: ['split-window -h', 'new-window', 'select-window -t @0'],
  },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 500 },
      description: {
        story:
          'The tab under the pointer is outlined while the drag is over it, so a drop that rearranges two tabs is never a surprise. Releasing runs `join-pane`, and the pane count moves from one tab to the other.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitForPanes(2, canvasElement);
    const source = app().context.activeWindowId!;
    const target = app()
      .context.windows.filter((w) => w.windowType === 'tab')
      .map((w) => w.id)
      .find((id) => id !== source)!;
    expect(panesByWindow()[source]).toBe(2);
    expect(panesByWindow()[target]).toBe(1);

    const tab = canvasElement.querySelector<HTMLElement>(`.tab-name[data-window-id="${target}"]`)!;
    const to = centreOf(tab);
    await dragHeaderTo(lastPaneHeader(canvasElement), to.x, to.y);

    // Marked, and the mark is drawn: an outline the tab does not otherwise have.
    await waitFor(() => {
      expect(tab.classList.contains('is-pane-drop-target')).toBe(true);
      expect(parseFloat(getComputedStyle(tab).outlineWidth)).toBeGreaterThan(0);
    });
    // Only that one, and no new-tab placeholder while the pointer is on a tab.
    expect(canvasElement.querySelectorAll('.tab-name.is-pane-drop-target').length).toBe(1);
    expect(canvasElement.querySelector('.tab-new-drop')).toBeNull();

    fireEvent.mouseUp(document.elementFromPoint(to.x, to.y) ?? document.body, {
      clientX: to.x,
      clientY: to.y,
    });

    await waitFor(() => {
      expect(panesByWindow()[target]).toBe(2);
      expect(panesByWindow()[source] ?? 0).toBe(1);
    });
    expect(canvasElement.querySelector('.tab-name.is-pane-drop-target')).toBeNull();
  },
};

// ---------------------------------------------------------------------------
// Onto the empty strip — a dashed placeholder, then a tab of its own
// ---------------------------------------------------------------------------

export const DropsIntoANewTab: Story = {
  args: {
    height: 500,
    initCommands: ['split-window -h'],
  },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 500 },
      description: {
        story:
          'Past the last tab there is no button to highlight, so a dashed "New Tab" placeholder stands in for the one that would be created. Releasing runs `break-pane` and the strip gains a tab holding the dragged pane.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitForPanes(2, canvasElement);
    const source = app().context.activeWindowId!;
    expect(panesByWindow()[source]).toBe(2);
    expect(app().context.windows.filter((w) => w.windowType === 'tab').length).toBe(1);

    const list = canvasElement.querySelector<HTMLElement>('.tab-list')!;
    const tabs = list.querySelectorAll<HTMLElement>('.tab-name[data-window-id]');
    const last = tabs[tabs.length - 1].getBoundingClientRect();
    const strip = list.getBoundingClientRect();
    const to = {
      x: Math.min(last.right + 160, strip.right - 20),
      y: strip.top + strip.height / 2,
    };

    await dragHeaderTo(lastPaneHeader(canvasElement), to.x, to.y);

    // The placeholder says what it does and is actually drawn — dashed, and
    // wide enough to read rather than a zero-size node in the DOM.
    await waitFor(() => {
      const el = canvasElement.querySelector<HTMLElement>('.tab-new-drop');
      expect(el).not.toBeNull();
      const box = el!.getBoundingClientRect();
      const style = getComputedStyle(el!);
      expect(el!.textContent?.trim()).toBe('New Tab');
      expect(box.width).toBeGreaterThan(30);
      expect(box.height).toBeGreaterThan(8);
      expect(style.borderStyle).toBe('dashed');
      expect(parseFloat(style.borderWidth)).toBeGreaterThan(0);
    });
    expect(canvasElement.querySelector('.tab-name.is-pane-drop-target')).toBeNull();

    fireEvent.mouseUp(document.elementFromPoint(to.x, to.y) ?? document.body, {
      clientX: to.x,
      clientY: to.y,
    });

    await waitFor(() => {
      const counts = panesByWindow();
      expect(app().context.windows.filter((w) => w.windowType === 'tab').length).toBe(2);
      expect(counts[source]).toBe(1);
      expect(Object.values(counts).every((n) => n === 1)).toBe(true);
    });
    expect(canvasElement.querySelector('.tab-new-drop')).toBeNull();
  },
};
