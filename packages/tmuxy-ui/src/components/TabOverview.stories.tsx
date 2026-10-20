/**
 * Tab Overview stories, over recordings of real tmux.
 *
 * ctrl+0 zooms the current tab out into a grid of every tab; a slot click
 * zooms that tab back in, the trailing "+" creates a tab and a slot's ✕
 * closes one. Opening, clicking, "+", ✕ and dragging a slot are
 * tests/2-layout-navigation-overview.test.js, end to end; these are the
 * layout of the grid and the motion out of a card.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { FixtureApp } from '../stories/FixtureHarness';
import { asFixture } from '../stories/fixtures/FixtureAdapter';
import tabsFixture from '../stories/fixtures/gen/tabs.json';
import manyTabs from '../stories/fixtures/gen/many-tabs.json';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Tab Overview',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

interface AppSnap {
  context: {
    activeWindowId: string | null;
    tabOverviewOpen: boolean;
    windows: Array<{ id: string; index: number; name: string; windowType: string | null }>;
  };
}
const actor = () =>
  (window as unknown as { app: { getSnapshot(): AppSnap; send(event: unknown): void } }).app;
const app = () => actor().getSnapshot();
const tabs = () =>
  app()
    .context.windows.filter((w) => w.windowType === 'tab')
    .sort((a, b) => a.index - b.index);

async function waitForOverview(open: boolean): Promise<HTMLElement | null> {
  return waitFor(
    () => {
      const el = document.querySelector<HTMLElement>('[data-testid="tab-overview"]');
      if (Boolean(el) !== open) throw new Error(`overview ${open ? 'not open' : 'still open'}`);
      return el;
    },
    { timeout: 8000 },
  );
}

const APPEARANCE = {
  opacity: 0.7,
  activePaneOpacity: 1,
  inactivePaneOpacity: 0.7,
  activeTextOpacity: 1,
  inactiveTextOpacity: 0.7,
  blur: false,
  animations: true,
  cursorBlink: true,
  tabOverviewCols: 3,
};

const cards = (grid: HTMLElement) => [...grid.querySelectorAll<HTMLElement>('.tab-overview-slot')];

/** How many cards share the first card's row. */
function firstRowCount(grid: HTMLElement): number {
  const all = cards(grid);
  const top = all[0].getBoundingClientRect().top;
  return all.filter((c) => Math.abs(c.getBoundingClientRect().top - top) < 2).length;
}

/** Whether a card is inside the grid's visible box (not clipped by its scroll). */
function onScreen(card: HTMLElement, grid: HTMLElement): boolean {
  const c = card.getBoundingClientRect();
  const g = grid.getBoundingClientRect();
  return c.top >= g.top - 1 && c.bottom <= g.bottom + 1;
}

export const ColumnsFromConfigAndScrolling: Story = {
  tags: ['nightly'],
  args: { fixture: asFixture(manyTabs), start: 'last-active' },
  parameters: {
    docs: {
      description: {
        story:
          'Each row of the overview holds `@tmuxy-tab-overview-cols` cards: 3 when the config says nothing, and whatever `set -g @tmuxy-tab-overview-cols N` pushes with the appearance. Twelve tabs in rows of three are taller than the view, so the grid scrolls vertically: it opens scrolled to the current tab, the arrow keys scroll it to keep the cursor’s card on screen, and the live pane grid stays on its card through every scroll and reflow.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane/i }, { timeout: 8000 });
    await waitFor(() => expect(tabs()).toHaveLength(12), { timeout: 8000 });
    const user = userEvent.setup({ delay: 5 });

    await user.keyboard('{Control>}0{/Control}');
    const overview = (await waitForOverview(true)) as HTMLElement;
    const grid = overview.querySelector('.tab-overview-grid') as HTMLElement;

    // No appearance has been pushed yet, so this is the default.
    await waitFor(() => expect(firstRowCount(grid)).toBe(3));

    // 13 cards (12 tabs and "+") in rows of three overflow the view,
    // and the view opened on the current tab, which is the last one.
    expect(getComputedStyle(grid).overflowY).toBe('auto');
    expect(grid.scrollHeight).toBeGreaterThan(grid.clientHeight + 100);
    const current = overview.querySelector('.tab-overview-slot.is-active') as HTMLElement;
    expect(current.dataset.windowId).toBe(tabs()[11].id);
    const first = cards(grid)[0];
    await waitFor(() => {
      expect(grid.scrollTop).toBeGreaterThan(0);
      expect(onScreen(current, grid)).toBe(true);
    });
    expect(onScreen(first, grid)).toBe(false);

    // The live pane grid is drawn over the current tab's card wherever the
    // cards have scrolled to.
    const layout = document.querySelector('.pane-container > .pane-layout') as HTMLElement;
    const frame = current.querySelector('.tab-overview-frame') as HTMLElement;
    const followsCard = () =>
      waitFor(() => {
        const f = frame.getBoundingClientRect();
        const l = layout.getBoundingClientRect();
        expect(Math.abs(l.top - f.top)).toBeLessThan(2);
        expect(Math.abs(l.left - f.left)).toBeLessThan(2);
        expect(Math.abs(l.width - f.width)).toBeLessThan(2);
      });
    await followsCard();

    // Walking the cursor up three rows scrolls the grid back to the top.
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    await waitFor(() => {
      expect(grid.scrollTop).toBeLessThan(2);
      expect(onScreen(first, grid)).toBe(true);
    });
    expect(cards(grid)[2].classList.contains('is-selected')).toBe(true);
    expect(onScreen(current, grid)).toBe(false);
    await followsCard();

    // More or fewer cards a row, straight from the config push.
    for (const cols of [5, 2]) {
      actor().send({
        type: 'THEME_SETTINGS_RECEIVED',
        theme: 'default',
        mode: 'dark',
        appearance: { ...APPEARANCE, tabOverviewCols: cols },
      });
      await waitFor(() => expect(firstRowCount(grid)).toBe(cols));
      await followsCard();
    }

    await user.keyboard('{Escape}');
    await waitForOverview(false);
  },
};

export const OpensOutOfTheSlotYouClicked: Story = {
  tags: ['nightly'],
  args: {
    fixture: asFixture(tabsFixture),
    start: 'logs-active',
    transitions: [{ match: /^select-window -t @0$/, to: 'main-active' }],
  },
  parameters: {
    docs: {
      description: {
        story:
          'The live grid is scaled into a card while the overview is open, and clicking a card grows it back out. It has to grow out of the card you CLICKED: the target used to follow the tab that was current, so opening another tab expanded the grid from the wrong side of the screen, which reads as a jump rather than as that card opening. Sampled per paint — the grid starts at the clicked card’s box, is drawn at sizes in between, and ends filling the container.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane/i }, { timeout: 8000 });
    const user = userEvent.setup({ delay: 5 });

    await user.keyboard('{Control>}0{/Control}');
    const overview = (await waitForOverview(true)) as HTMLElement;
    const layout = document.querySelector('.pane-container > .pane-layout') as HTMLElement;

    // Let the zoom-out settle, so the grid is parked in the CURRENT tab's card.
    const current = app().context.activeWindowId;
    const currentCard = overview.querySelector(
      `[data-testid="tab-overview-slot-${current}"] .tab-overview-frame`,
    ) as HTMLElement;
    await waitFor(() => {
      const f = currentCard.getBoundingClientRect();
      const l = layout.getBoundingClientRect();
      expect(Math.abs(l.left - f.left)).toBeLessThan(2);
    });

    // The other tab's card, which is the one being clicked.
    const other = tabs().find((w) => w.id !== current)!;
    const otherCard = overview.querySelector(
      `[data-testid="tab-overview-slot-${other.id}"] .tab-overview-frame`,
    ) as HTMLElement;
    const otherBox = otherCard.getBoundingClientRect();
    // The two cards really are in different places, or this proves nothing.
    expect(Math.abs(otherBox.left - currentCard.getBoundingClientRect().left)).toBeGreaterThan(20);

    const boxes: DOMRect[] = [];
    let sampling = true;
    const frame = () => {
      boxes.push(layout.getBoundingClientRect());
      if (sampling) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    await user.click(
      overview.querySelector(`[data-testid="tab-overview-slot-${other.id}"]`) as HTMLElement,
    );
    await waitForOverview(false);
    await waitFor(() => expect(app().context.activeWindowId).toBe(other.id));
    await waitFor(() => expect(getComputedStyle(layout).transform).toBe('none'));
    sampling = false;

    // The grow starts at the frame before the width first climbs; that frame
    // is where it grew OUT of, and it has to be the card that was clicked
    // rather than the one being left. Both cards are the same size, so only
    // the position tells them apart.
    const growthAt = boxes.findIndex((b) => b.width > otherBox.width + 8);
    expect(growthAt, 'the grid never grew').toBeGreaterThan(0);
    const origin = boxes[growthAt - 1];
    expect(
      Math.abs(origin.left - otherBox.left),
      `grew from x=${Math.round(origin.left)}, clicked card is at x=${Math.round(otherBox.left)}`,
    ).toBeLessThan(6);

    // ...and it grew rather than jumping: drawn at sizes in between on the way.
    const full = boxes[boxes.length - 1].width;
    expect(full).toBeGreaterThan(otherBox.width * 2);
    const between = boxes.filter((b) => b.width > otherBox.width + 8 && b.width < full - 8);
    expect(between.length).toBeGreaterThan(0);
  },
};
