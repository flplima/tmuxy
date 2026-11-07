/**
 * The recording holds one session, `demo`. A dozen sessions, scrolling and
 * filtering among them, is the E2E suite's
 * (`tests/4-session-connectivity-multi.test.js`).
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { appContext, storyApp } from '../stories/storyApp';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { FixtureApp } from '../stories/FixtureHarness';
import { asFixture, adapterHolder } from '../stories/fixtures/FixtureAdapter';
import tree from '../stories/fixtures/gen/tree.json';

const held = adapterHolder();
const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/SessionMenu',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
  args: {
    fixture: asFixture(tree),
    start: 'closed',
    onAdapterReady: held.keep,
    // The toggle opens the column; tmux's answer is the tree beside the panes.
    transitions: [{ match: /^split-window\b.*tmuxy-widget-tree'/, to: 'open' }],
  },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

const SWITCHER = '[data-testid="session-switcher"]';
type User = ReturnType<typeof userEvent.setup>;

/** The switcher, once it is on screen with a real box (it portals to the body). */
async function waitForSwitcher(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = document.querySelector(SWITCHER) as HTMLElement | null;
      if (!el) throw new Error('the session switcher is not open');
      const box = el.getBoundingClientRect();
      if (box.width < 40 || box.height < 20) throw new Error('the switcher has no readable box');
      return el;
    },
    { timeout: 8000, interval: 100 },
  );
}

const switcherClosed = () =>
  waitFor(() => {
    expect(document.querySelector(SWITCHER)).toBeNull();
  });

/**
 * Open the tree column — its title, and the chevron on it, are there only
 * while it is — and return the chevron.
 */
async function findChevron(canvasElement: HTMLElement, user: User): Promise<HTMLElement> {
  const canvas = within(canvasElement);
  await user.click(
    await canvas.findByRole('button', { name: /toggle tree sidebar/i }, { timeout: 8000 }),
  );
  return canvas.findByRole('button', { name: /switch session/i }, { timeout: 8000 });
}

const currentSession = () => appContext().sessionName;

export const TheSwitcherIsADropdown: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Clicking the chevron beside the session name opens the switcher as a dropdown hanging off that button — no float, no tmux window, nothing dimmed behind it. The session the client is attached to is marked, and picking it again simply closes the dropdown.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup({ delay: 5 });
    const switcher = await findChevron(canvasElement, user);
    expect(switcher.getAttribute('aria-expanded')).toBe('false');
    await user.click(switcher);

    const menu = await waitForSwitcher();
    expect(switcher.getAttribute('aria-expanded')).toBe('true');

    const button = switcher.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    expect(Math.abs(box.left - button.left)).toBeLessThan(40);
    expect(box.top).toBeGreaterThanOrEqual(button.top - 2);

    const sessionName = currentSession();
    const row = menu.querySelector(`[data-session-name="${sessionName}"]`) as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain(sessionName);
    expect(row.getAttribute('data-current')).toBe('true');

    await user.click(row);
    await switcherClosed();
  },
};

export const TypingFiltersTheList: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'The switcher opens with the keyboard in its filter box. Typing narrows the list to the sessions whose names contain the text, a filter that matches nothing says so, and Escape puts the switcher away. Enter picks the highlighted row, which starts on the session you are on.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup({ delay: 5 });
    await user.click(await findChevron(canvasElement, user));
    const menu = await waitForSwitcher();
    const sentBefore = held.adapter!.commands.length;
    const filter = within(menu).getByRole('combobox', { name: /filter sessions/i });
    await waitFor(() => expect(document.activeElement).toBe(filter));

    const sessionName = currentSession();
    const row = () => menu.querySelector(`[data-session-name="${sessionName}"]`);
    const visible = (el: Element | null) => {
      if (!el) return false;
      const box = el.getBoundingClientRect();
      return box.width > 20 && box.height > 8;
    };
    expect(visible(row())).toBe(true);
    expect(row()?.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('zzqx');
    await waitFor(() => expect(row()).toBeNull());
    expect(visible(within(menu).getByText(/No session matches “zzqx”/))).toBe(true);

    await user.clear(filter);
    await user.keyboard(sessionName.slice(0, 2).toUpperCase());
    await waitFor(() => expect(visible(row())).toBe(true));
    expect(row()?.getAttribute('aria-selected')).toBe('true');
    expect(filter.getAttribute('aria-activedescendant')).toBe(row()?.id);

    // Keys typed into the box never reach the terminal.
    expect(
      held.adapter!.commands.slice(sentBefore).filter((c) => c.startsWith('send-keys')),
    ).toEqual([]);

    await user.keyboard('{Enter}');
    await switcherClosed();

    await user.click(await within(canvasElement).findByRole('button', { name: /switch session/i }));
    await waitForSwitcher();
    await user.keyboard('{Escape}');
    await switcherClosed();
  },
};

export const LeftOpenWithAFilter: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'The switcher left open with a filter typed, so the accessibility pass that runs after every story reads the filter box, the list it controls and the highlighted row.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup({ delay: 5 });
    await user.click(await findChevron(canvasElement, user));
    const menu = await waitForSwitcher();
    await user.keyboard(currentSession().slice(0, 1));
    const row = menu.querySelector(`[data-session-name="${currentSession()}"]`);
    expect(row?.getAttribute('aria-selected')).toBe('true');

    // A minimum-size pin that grew the box would chase itself across the screen.
    const before = menu.getBoundingClientRect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = menu.getBoundingClientRect();
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    expect(after.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(after.right).toBeLessThanOrEqual(window.innerWidth);
    expect(after.height).toBeLessThan(window.innerHeight / 2);
  },
};

export const ConnectingOverSshIsDesktopOnly: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Reaching another machine retargets the backend at a new tmux socket, which is a Tauri command — a web client is served by a server pinned to one socket at launch, so the item is simply not there. On the desktop it is, and it opens the connect flow in a pane: it asks where to connect, and a question needs somewhere to type.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup({ delay: 5 });
    const switcher = await findChevron(canvasElement, user);

    await user.click(switcher);
    let menu = await waitForSwitcher();
    expect(menu.querySelector('[data-testid="session-menu-connect"]')).toBeNull();
    // Close it the way the first story does — on a session row, which is the
    // gesture that has a handler of its own.
    await user.click(menu.querySelector('[data-current="true"]') as HTMLElement);
    await switcherClosed();

    // What `isTauri()` reads (infra/platform.ts). The harness builds its own
    // fixture adapter, so flipping this after mount changes only what the
    // switcher decides to draw.
    const tauriWindow = window as unknown as Record<string, unknown>;
    tauriWindow.__TAURI_INTERNALS__ = {};
    try {
      const raised: string[] = [];
      const app = storyApp();
      const realSend = app.send.bind(app);
      app.send = (event) => {
        raised.push(event.type);
        realSend(event);
      };

      await user.click(switcher);
      menu = await waitForSwitcher();
      const connect = menu.querySelector('[data-testid="session-menu-connect"]') as HTMLElement;
      expect(connect).not.toBeNull();
      expect(connect.getBoundingClientRect().height).toBeGreaterThan(0);

      await user.click(connect);
      await switcherClosed();
      expect(raised).toContain('OPEN_CONNECT_FLOAT');
      app.send = realSend;
    } finally {
      delete tauriWindow.__TAURI_INTERNALS__;
    }
  },
};
