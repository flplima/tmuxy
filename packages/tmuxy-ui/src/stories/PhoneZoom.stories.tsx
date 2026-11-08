/**
 * The phone's zoom with the keyboard up and down, upright and sideways.
 * Upright, the bar under the keys moves down with the zoom. No headless
 * browser draws a keyboard, so the stories bring up a mock one
 * (keyboardMock.ts): the screen loses its height and a keyboard is drawn there.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { TmuxyApp } from '../lib';
import { FixtureApp, FixtureProvider } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import phoneTwoTabs from './fixtures/gen/phone-two-tabs.json';
import { box, ctx, doubleTapTerminal } from './phoneStoryHelpers';
import { mockKeyboard } from './keyboardMock';
import { PHONE_STATUS_HEIGHT } from '../infra/dom/phoneLayout';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Phone Zoom',
  component: FixtureApp,
  args: {
    fixture: asFixture(phoneTwoTabs),
    start: 'main-active',
    config: { phoneLayout: true },
  },
  render: ({ fixture, start, config }) => (
    <FixtureProvider fixture={fixture} start={start} config={config} width={390} height={844}>
      <TmuxyApp />
    </FixtureProvider>
  ),
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

const KEYBOARD_UPRIGHT = 300;
const KEYBOARD_SIDEWAYS = 170;

const rows = (root: Element) => [
  ...root.querySelectorAll('.phone-pty .pane-active .terminal-line'),
];

async function expectCursorInView(root: Element) {
  await waitFor(
    () => {
      const term = box(root.querySelector('.phone-pty'));
      const cursor = box(root.querySelector('.phone-pty .pane-active .terminal-cursor'));
      expect(cursor.height).toBeGreaterThan(0);
      expect(cursor.top).toBeGreaterThanOrEqual(term.top - 0.5);
      expect(cursor.bottom).toBeLessThanOrEqual(term.bottom + 0.5);
      const keyboard = box(document.querySelector('[data-testid="mock-keyboard"]'));
      expect(cursor.bottom).toBeLessThanOrEqual(keyboard.top + 0.5);
    },
    { timeout: 5000 },
  );
}

export const ZoomShowsEveryRow: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 844 },
      description: {
        story:
          'A double tap zooms the terminal to twice its size, its status line with it, and the bar under the keys moves down to match: the bottom view gives up the room, so every row is on screen at once and the view scrolls sideways only; the key row stays under it. A keyboard coming up cuts the terminal short and it scrolls to keep the cursor’s row in view above the keyboard.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        expect(ctx().phoneLayout).toBe(true);
        expect(canvasElement.querySelector('.phone-pty .terminal-cursor')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    const before = box(canvasElement.querySelector('.phone-pty .pane-container'));
    const barBefore = box(canvasElement.querySelector('[data-testid="phone-divider"]'));
    doubleTapTerminal(canvasElement);

    await waitFor(() => {
      expect(canvasElement.querySelector('.phone-pty.is-zoomed')).not.toBeNull();
      expect(ctx().phoneZoom).toBe(2);
    });
    await waitFor(() => {
      const bar = box(canvasElement.querySelector('[data-testid="phone-divider"]'));
      expect(bar.top).toBeGreaterThan(barBefore.top + before.height * 0.9);
      // The status line is part of the picture: twice its size too.
      const line = box(canvasElement.querySelector('.phone-pty .tmux-status-bar'));
      expect(line.height).toBeCloseTo(2 * PHONE_STATUS_HEIGHT, 0);
    });
    const viewport = canvasElement.querySelector('.phone-zoom-viewport') as HTMLElement;
    const term = canvasElement.querySelector('.phone-pty') as HTMLElement;
    await waitFor(() => {
      // The window's 24 rows, less the pane's header.
      const lines = rows(canvasElement);
      expect(lines.length).toBeGreaterThanOrEqual(23);
      const first = box(lines[0]);
      const last = box(lines[lines.length - 1]);
      expect(last.height).toBeCloseTo(first.height, 0);
      expect(first.height).toBeGreaterThan(before.height / 24 + 2);
      expect(first.top).toBeGreaterThanOrEqual(box(viewport).top - 0.5);
      expect(last.bottom).toBeLessThanOrEqual(box(viewport).bottom + 0.5);
      expect(last.bottom).toBeLessThanOrEqual(box(canvasElement.querySelector('.key-row')).top);
    });
    expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth + 10);
    expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 1);
    expect(term.scrollHeight).toBeLessThanOrEqual(term.clientHeight + 1);
    expect(box(canvasElement.querySelector('.key-row')).top).toBeGreaterThanOrEqual(
      box(term).bottom - 0.5,
    );

    const putAway = mockKeyboard(canvasElement.querySelector('.app-container')!, KEYBOARD_UPRIGHT);
    try {
      await waitFor(() => expect(term.scrollHeight).toBeGreaterThan(term.clientHeight + 10), {
        timeout: 5000,
      });
      await expectCursorInView(canvasElement);
      expect(box(canvasElement.querySelector('.key-row')).bottom).toBeLessThanOrEqual(
        box(document.querySelector('[data-testid="mock-keyboard"]')).top + 0.5,
      );
    } finally {
      putAway();
    }

    // A double tap again: back to the grid's own size, and the bar with it.
    doubleTapTerminal(canvasElement);
    await waitFor(() => {
      expect(canvasElement.querySelector('.phone-pty.is-zoomed')).toBeNull();
      expect(box(canvasElement.querySelector('[data-testid="phone-divider"]')).top).toBeCloseTo(
        barBefore.top,
        0,
      );
    });
  },
};

export const ZoomSidewaysWithTheKeyboard: Story = {
  render: ({ fixture, start, config }) => (
    <FixtureProvider fixture={fixture} start={start} config={config} width={844} height={390}>
      <TmuxyApp />
    </FixtureProvider>
  ),
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 390 },
      description: {
        story:
          'Held sideways and zoomed, the doubled terminal is taller than the screen, so it scrolls up and down as well as sideways; the tree and the side pane keep their columns beside it and the keys their row. A keyboard coming up cuts it shorter still, and it scrolls to keep the cursor’s row in view.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        expect(ctx().phoneLandscape).toBe(true);
        expect(canvasElement.querySelector('.phone-pty .terminal-cursor')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    doubleTapTerminal(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('.phone-pty.is-zoomed')).not.toBeNull());
    const term = canvasElement.querySelector('.phone-pty') as HTMLElement;
    const viewport = canvasElement.querySelector('.phone-zoom-viewport') as HTMLElement;
    await waitFor(() => {
      expect(term.scrollHeight).toBeGreaterThan(term.clientHeight + 10);
      expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth + 10);
    });
    // Sideways the tree and the side pane keep their columns.
    expect(box(canvasElement.querySelector('.phone-side-left .phone-tree')).width).toBeGreaterThan(
      0,
    );
    expect(box(canvasElement.querySelector('.phone-side-right')).width).toBeGreaterThan(0);

    const putAway = mockKeyboard(canvasElement.querySelector('.app-container')!, KEYBOARD_SIDEWAYS);
    try {
      await waitFor(
        () => expect(box(term).height).toBeLessThanOrEqual(390 - KEYBOARD_SIDEWAYS + 0.5),
        {
          timeout: 5000,
        },
      );
      await expectCursorInView(canvasElement);
    } finally {
      putAway();
    }
  },
};
