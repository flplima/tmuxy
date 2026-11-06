/**
 * The phone's key row and its bottom view's tab bar, at a 390 × 844 phone's
 * width: six keys by two, edge to edge, with no menu among them; the app
 * menu is the first of the three tabs under the bottom view
 * (components/PhoneBottomView.tsx), listed as a phone app lists one, a
 * submenu a page of its own (components/PhoneMenu.tsx).
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';
import { TmuxyApp } from '../lib';
import { FixtureApp, FixtureProvider } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import phoneTwoTabs from './fixtures/gen/phone-two-tabs.json';
import { box, ctx } from './phoneStoryHelpers';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Phone Menu',
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

export const AppMenuFromTheMenuTab: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 844 },
      description: {
        story:
          'The key row is six by two, edge to edge with no gap between the keys, and holds no menu: the app menu is the first of the three tabs along the bottom — Menu, Tree, Side pane — the tree in front to begin with. The Menu tab lists the menu as a phone app does; a submenu is a page of its own, with the way back at the top.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        expect(ctx().phoneLayout).toBe(true);
        expect(canvasElement.querySelector('.phone-tabs')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    // Six by two, in order, and no menu among them.
    const keys = [...canvasElement.querySelectorAll<HTMLElement>('.key-row > button')];
    expect(keys.map((k) => k.dataset.keyRow)).toEqual([
      ...['esc', 'tab', 'ctrl', 'alt', 'prefix', '⌨'],
      ...['←', '↑', '↓', '→', '⏎', 'zoom'],
    ]);
    expect(canvasElement.querySelector('.key-row .app-menu-button')).toBeNull();
    const boxes = keys.map(box);
    const row = box(canvasElement.querySelector('.key-row'));
    for (const [r, start] of [
      [0, 0],
      [1, 6],
    ]) {
      const line = boxes.slice(start, start + 6);
      expect(line.every((k) => Math.abs(k.top - line[0].top) < 1)).toBe(true);
      // Edge to edge: each key starts where the one before it ends.
      for (let k = 1; k < 6; k++) expect(line[k].left).toBeCloseTo(line[k - 1].right, 0);
      expect(line[0].left).toBeLessThanOrEqual(row.left + 1);
      expect(line[5].right).toBeGreaterThanOrEqual(row.right - 1);
      expect(r === 0 ? line[0].bottom : line[0].top).toBeCloseTo(boxes[6].top, 0);
    }

    // The three tabs, an icon over a name each, side by side; the tree's lit.
    const tabs = [...canvasElement.querySelectorAll<HTMLElement>('.phone-tabs [role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Menu', 'Tree', 'Side pane']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    for (const t of tabs) {
      const icon = box(t.querySelector('svg'));
      const name = box(t.querySelector('.phone-tab-label'));
      expect(icon.width).toBeGreaterThan(0);
      expect(name.top).toBeGreaterThanOrEqual(icon.bottom - 1);
    }
    expect(box(tabs[0]).right).toBeLessThanOrEqual(box(tabs[1]).left + 1);

    // The Menu tab: the menu's top page, its submenus as rows a thumb tall.
    await userEvent.click(tabs[0]);
    const pageRows = () => [
      ...canvasElement.querySelectorAll<HTMLElement>('.phone-menu-page .phone-menu-row'),
    ];
    await waitFor(
      () => {
        expect(
          canvasElement.querySelector('[data-testid="phone-bottom"]')!.getAttribute('data-view'),
        ).toBe('menu');
        expect(canvasElement.querySelector('.phone-menu-title')!.textContent).toBe('Menu');
        expect(pageRows().map((r) => r.textContent)).toEqual(
          expect.arrayContaining(['Pane', 'Tab', 'Session', 'View']),
        );
      },
      { timeout: 4000 },
    );
    const first = box(pageRows()[0]);
    expect(first.height).toBeGreaterThanOrEqual(44);
    expect(first.width).toBeCloseTo(box(canvasElement.querySelector('.phone-menu')).width, 0);

    // A submenu is a page of its own, and the way back returns to the top.
    await userEvent.click(pageRows().find((r) => r.textContent === 'View')!);
    await waitFor(
      () => {
        expect(canvasElement.querySelector('.phone-menu-title')!.textContent).toBe('View');
        expect(canvasElement.querySelector('.phone-menu-back')).not.toBeNull();
        expect(pageRows().map((r) => r.textContent)).not.toContain('Session');
      },
      { timeout: 4000 },
    );
    await userEvent.click(canvasElement.querySelector('.phone-menu-back') as HTMLElement);
    await waitFor(
      () => {
        expect(canvasElement.querySelector('.phone-menu-title')!.textContent).toBe('Menu');
        expect(canvasElement.querySelector('.phone-menu-back')).toBeNull();
      },
      { timeout: 4000 },
    );
  },
};
