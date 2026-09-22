/**
 * SessionMenu stories (demo engine).
 *
 * The switcher is a dropdown hanging off the control that opened it, not a
 * float running a widget in a real tmux pane. These drive it the way a user
 * does — click the chevron beside the session name, read the list, pick one —
 * and assert the menu is really on screen rather than merely mounted.
 *
 * The demo engine serves one session, so what is asserted here is the shape of
 * the menu and the fact that it hangs off its button. Which sessions it lists
 * comes from the `serversActor` poll, whose parsing has its own unit tests.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/SessionMenu',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

/** The menu, once it is on screen with a real box (it portals to the body). */
async function waitForMenu(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = document.querySelector('.szh-menu--state-open') as HTMLElement | null;
      if (!el) throw new Error('the session menu is not open');
      const box = el.getBoundingClientRect();
      if (box.width < 40 || box.height < 20) throw new Error('the menu has no readable box');
      return el;
    },
    { timeout: 8000, interval: 100 },
  );
}

export const TheSwitcherIsADropdown: Story = {
  args: {},
  parameters: {
    docs: {
      description: {
        story:
          'Clicking the chevron beside the session name opens the switcher as a menu hanging off that button — no float, no tmux window, nothing dimmed behind it. The session the client is attached to is marked, and picking it again simply closes the menu.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup({ delay: 5 });

    // The column has to be open for its title — and the switcher on it — to
    // be there at all.
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await user.click(toggle);

    const switcher = await canvas.findByRole(
      'button',
      { name: /switch session/i },
      { timeout: 8000 },
    );
    expect(switcher.getAttribute('aria-expanded')).toBe('false');
    await user.click(switcher);

    const menu = await waitForMenu();
    expect(switcher.getAttribute('aria-expanded')).toBe('true');

    // It hangs off the button rather than landing somewhere of its own.
    const button = switcher.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    expect(Math.abs(box.left - button.left)).toBeLessThan(40);
    expect(box.top).toBeGreaterThanOrEqual(button.top - 2);

    // The attached session is listed and marked as the current one.
    const sessionName = (
      window as unknown as { app: { getSnapshot(): { context: { sessionName: string } } } }
    ).app.getSnapshot().context.sessionName;
    const row = menu.querySelector(`[data-session-name="${sessionName}"]`) as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain(sessionName);
    expect(row.getAttribute('data-current')).toBe('true');

    // Picking the session you are already on is a no-op that closes the menu.
    await user.click(row);
    await waitFor(() => {
      expect(document.querySelector('.szh-menu--state-open')).toBeNull();
    });
  },
};

// ---------------------------------------------------------------------------
// The SSH item is the desktop app's
// ---------------------------------------------------------------------------

export const ConnectingOverSshIsDesktopOnly: Story = {
  args: {},
  parameters: {
    docs: {
      description: {
        story:
          'Reaching another machine retargets the backend at a new tmux socket, which is a Tauri command — a web client is served by a server pinned to one socket at launch, so the item is simply not there. On the desktop it is, and it opens the connect form in a pane: a form needs somewhere to type, which is the one thing a menu cannot offer.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup({ delay: 5 });

    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await user.click(toggle);
    const switcher = await canvas.findByRole(
      'button',
      { name: /switch session/i },
      { timeout: 8000 },
    );

    // On the web build there is nothing to offer.
    await user.click(switcher);
    let menu = await waitForMenu();
    expect(menu.querySelector('[data-testid="session-menu-connect"]')).toBeNull();
    // Close it the way the first story does — on a session row, which is the
    // gesture that has a handler of its own.
    await user.click(menu.querySelector('[data-current="true"]') as HTMLElement);
    await waitFor(() => {
      expect(document.querySelector('.szh-menu--state-open')).toBeNull();
    });

    // What `isTauri()` reads (tmux/adapters.ts). The harness builds its own
    // demo adapter, so flipping this after mount changes only what the menu
    // decides to draw.
    const tauriWindow = window as unknown as Record<string, unknown>;
    tauriWindow.__TAURI_INTERNALS__ = {};
    try {
      const raised: string[] = [];
      const app = (window as unknown as { app: { send(e: { type: string }): void } }).app;
      const realSend = app.send.bind(app);
      app.send = (event: { type: string }) => {
        raised.push(event.type);
        realSend(event);
      };

      await user.click(switcher);
      menu = await waitForMenu();
      const connect = menu.querySelector('[data-testid="session-menu-connect"]') as HTMLElement;
      expect(connect).not.toBeNull();
      expect(connect.getBoundingClientRect().height).toBeGreaterThan(0);

      await user.click(connect);
      await waitFor(() => {
        expect(document.querySelector('.szh-menu--state-open')).toBeNull();
      });
      // The form is a pane, so the menu asks for one rather than drawing it.
      expect(raised).toContain('OPEN_CONNECT_FLOAT');
      app.send = realSend;
    } finally {
      delete tauriWindow.__TAURI_INTERNALS__;
    }
  },
};
