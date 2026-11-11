/**
 * The command palette over states recorded from real tmux: the keys that
 * open it, what typing finds, and what Enter does with the row it is on.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { FixtureApp } from '../../stories/FixtureHarness';
import { adapterHolder, asFixture } from '../../stories/fixtures/FixtureAdapter';
import panes from '../../stories/fixtures/gen/panes.json';
import tabs from '../../stories/fixtures/gen/tabs.json';
import { openAppMenu, paneGroups, tabWindows } from '../../stories/appStoryHelpers';
import { appContext } from '../../stories/storyApp';

const held = adapterHolder();
const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/CommandPalette',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
  args: { onAdapterReady: held.keep },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

const PALETTE = '[data-testid="command-palette"]';
type User = ReturnType<typeof userEvent.setup>;

/** The palette, once it is on screen with a readable box and the keyboard in its field. */
async function waitForPalette(doc: Document): Promise<HTMLElement> {
  return waitFor(
    () => {
      const panel = doc.querySelector(`${PALETTE} [role="dialog"]`) as HTMLElement | null;
      if (!panel) throw new Error('the palette is not open');
      const box = panel.getBoundingClientRect();
      if (box.width < 200 || box.height < 40) throw new Error('the palette has no readable box');
      expect(doc.activeElement).toBe(within(panel).getByRole('combobox'));
      return panel;
    },
    { timeout: 8000, interval: 100 },
  );
}

const paletteClosed = (doc: Document) =>
  waitFor(() => expect(doc.querySelector(PALETTE)).toBeNull(), { timeout: 5000 });

/** The rows on screen, top to bottom: what each says and the key it shows. */
function rows(panel: HTMLElement) {
  const list = panel.querySelector('[role="listbox"]')!.getBoundingClientRect();
  return [...panel.querySelectorAll<HTMLElement>('[role="option"]')]
    .filter((row) => {
      const box = row.getBoundingClientRect();
      return box.height > 0 && box.bottom <= list.bottom + 1 && box.top >= list.top - 1;
    })
    .map((row) => ({
      el: row,
      label: row.querySelector('.command-palette-label')?.textContent ?? '',
      key: row.querySelector('.command-palette-key')?.textContent ?? '',
      kind: row.dataset.entryKind ?? '',
      selected: row.getAttribute('aria-selected') === 'true',
    }));
}

async function appReady(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThan(0), { timeout: 10000 });
  await waitFor(() => expect(appContext().keybindings).not.toBeNull(), { timeout: 10000 });
  return canvas;
}

const openPalette = (user: User) => user.keyboard('{Control>}{Shift>}P{/Shift}{/Control}');

export const TypingSplitOffersBothSplits: Story = {
  args: {
    fixture: asFixture(panes),
    start: 'one',
    transitions: [{ match: /^split-window\b/, to: 'side-by-side' }],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Ctrl+Shift+P opens the palette with the keyboard in its box. Typing "split" narrows the list to the two splits, each with the key that does the same, and Enter runs the one highlighted: the pane is split and the palette is gone.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup({ delay: 5 });
    const doc = canvasElement.ownerDocument;
    const canvas = await appReady(canvasElement);
    expect(paneGroups(canvas)).toHaveLength(1);

    await openPalette(user);
    const panel = await waitForPalette(doc);
    // Untyped, it lists the actions under their heading.
    expect(panel.textContent).toContain('Actions');

    await user.keyboard('split');
    await waitFor(() => expect(rows(panel)[0]?.label).toBe('Split Pane Below'));
    const found = rows(panel);
    expect(found.slice(0, 2).map((row) => [row.label, row.key])).toEqual([
      ['Split Pane Below', 'ctrl+a "'],
      ['Split Pane Right', 'ctrl+a %'],
    ]);
    expect(found[0].selected).toBe(true);
    // The letters typed are the ones marked.
    expect(found[0].el.querySelector('mark')?.textContent).toBe('Split');

    // Down moves the highlight to the second split; Enter runs that one.
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(rows(panel)[1].selected).toBe(true));
    const sentBefore = held.adapter!.commands.length;
    await user.keyboard('{Enter}');

    await paletteClosed(doc);
    await waitFor(() => expect(paneGroups(canvas)).toHaveLength(2), { timeout: 10000 });
    expect(held.adapter!.commands.slice(sentBefore)).toContain('split-window -h');
    // Nothing of what was typed reached the pane.
    expect(held.adapter!.commands.some((c) => c.startsWith('send-keys'))).toBe(false);
  },
};

export const EscapeAndTheChordCloseIt: Story = {
  args: { fixture: asFixture(panes), start: 'one' },
  parameters: {
    docs: {
      description: {
        story:
          'Escape closes the palette, and so does the chord that opened it. A query that matches nothing says so instead of showing an empty box, and Ctrl+N / Ctrl+P walk the list like the arrows.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup({ delay: 5 });
    const doc = canvasElement.ownerDocument;
    await appReady(canvasElement);

    await openPalette(user);
    let panel = await waitForPalette(doc);
    await user.keyboard('zzqqxx');
    await waitFor(() => expect(panel.textContent).toContain('Nothing matches “zzqqxx”'));
    await user.keyboard('{Escape}');
    await paletteClosed(doc);

    await openPalette(user);
    panel = await waitForPalette(doc);
    await user.keyboard('tab');
    await waitFor(() => expect(rows(panel).length).toBeGreaterThan(2));
    expect(rows(panel)[0].selected).toBe(true);
    await user.keyboard('{Control>}n{/Control}');
    await waitFor(() => expect(rows(panel)[1].selected).toBe(true));
    await user.keyboard('{Control>}p{/Control}');
    await waitFor(() => expect(rows(panel)[0].selected).toBe(true));

    await openPalette(user);
    await paletteClosed(doc);
    expect(held.adapter!.commands.some((c) => c.startsWith('send-keys'))).toBe(false);
  },
};

export const GoToListsPlacesOnly: Story = {
  args: {
    fixture: asFixture(tabs),
    start: 'logs-active',
    transitions: [{ match: /^select-window -t @0\b/, to: 'main-active' }],
  },
  parameters: {
    docs: {
      description: {
        story:
          "View ▸ Go to Session, Tab or Pane… opens the palette on the places alone: the tabs and panes, no actions. Typing \">\" first brings the actions back; typing a tab's name and Enter goes to it. (The recording's config binds `prefix g` to something of its own, so the key that would open this is the config's here, as it should be.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup({ delay: 5 });
    const doc = canvasElement.ownerDocument;
    await appReady(canvasElement);
    const activeTab = () => tabWindows().find((w) => w.active)?.name;
    await waitFor(() => expect(activeTab()).toBe('logs'));

    // The recorded bindings have `g` on the prefix, and a bound key is the
    // config's: the prefix and g must not open the palette here.
    await user.keyboard('{Control>}a{/Control}g');
    await user.keyboard('{Escape}');
    expect(doc.querySelector(PALETTE)).toBeNull();

    const menu = await openAppMenu(canvasElement, user);
    await user.click(await menu.item(/^View$/));
    await user.click(await menu.item(/^Go to Session, Tab or Pane/));
    const panel = await waitForPalette(doc);
    expect(doc.querySelector(PALETTE)?.getAttribute('data-mode')).toBe('go');
    const listed = rows(panel);
    expect(listed.map((row) => row.kind)).not.toContain('action');
    expect(listed.filter((row) => row.kind === 'tab').map((row) => row.label)).toEqual([
      'main',
      'logs',
    ]);

    // `>` is the way from the places to everything.
    await user.keyboard('>split');
    await waitFor(() => expect(rows(panel)[0]?.label).toBe('Split Pane Below'));
    await user.keyboard('{Backspace>6/}');

    await user.keyboard('main');
    await waitFor(() => {
      const first = rows(panel)[0];
      expect([first?.kind, first?.label]).toEqual(['tab', 'main']);
    });
    // A name no session has is offered as a new session, after what matched.
    const offered = rows(panel);
    expect(offered[offered.length - 1]?.label).toBe('New Session “main”');
    await user.keyboard('{Enter}');
    await paletteClosed(doc);
    await waitFor(() => expect(activeTab()).toBe('main'), { timeout: 10000 });
  },
};
