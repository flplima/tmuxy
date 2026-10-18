import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import {
  pasteLine,
  paneGroups,
  focusFirstPane,
  sessionName,
  paneIds,
  openAppMenu,
} from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Sessions & Lifecycle',
  component: V86AppHarness,
  tags: ['v86'],
  args: { shared: true },
  decorators: [withTmuxView],
  parameters: {
    layout: 'fullscreen',
  },
};
export default meta;
type Story = StoryObj<typeof V86AppHarness>;

/**
 * Reconnect / fatal: when the control channel drops, the adapter signals a
 * reconnection and the app blurs the last frame under the
 * `.connection-overlay-reconnecting` overlay; when it recovers, the overlay clears. We drive the same
 * reconnection lifecycle events the adapter emits (`TMUX_RECONNECTING` →
 * `TMUX_RECONNECTED`) on the live client and assert the UI reflects each phase.
 */
export const Reconnect: Story = {
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
    expect(doc.querySelector('.connection-overlay-reconnecting')).toBeNull();
    // Channel drops → reconnecting indicator appears.
    app.send({ type: 'TMUX_RECONNECTING' });
    await waitFor(
      () => expect(doc.querySelector('.connection-overlay-reconnecting')).not.toBeNull(),
      {
        timeout: 10000,
        interval: 200,
      },
    );
    // Channel recovers → indicator clears.
    app.send({ type: 'TMUX_RECONNECTED' });
    await waitFor(() => expect(doc.querySelector('.connection-overlay-reconnecting')).toBeNull(), {
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

// ───────────────────────── §9 Sessions & connection lifecycle ─────────────────────────

/**
 * Session create via menu: hamburger → Session → "New Session" creates a fresh
 * `tmuxy_<ts>` session AND switches to it in one action (no manual switch) —
 * the rendered pane set is reconstructed for the new session. Switching back to
 * the original restores its panes.
 */
export const SessionMenuNewAndSwitch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const panesOnM = paneIds(canvas).join(',');
    const menu = await openAppMenu(canvasElement, user);
    await user.click(await menu.item(/^Session$/));
    await user.click(await menu.item(/New Session/));
    // "New Session" now creates a `tmuxy_<ts>` session and auto-switches to it
    // (previously it left a detached session with no visible effect). The
    // switch swaps in a freshly-reconstructed pane set for the new session.
    await waitFor(
      () => {
        expect(sessionName()).toMatch(/^tmuxy_\d+$/);
        expect(paneIds(canvas).join(',')).not.toBe(panesOnM);
      },
      { timeout: 30000, interval: 500 },
    );
    const app = (
      window as unknown as { app: { send(e: { type: string; sessionName: string }): void } }
    ).app;
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
 * Fatal: killing the tmux server in the guest ends the control stream (`%exit`);
 * the engine surfaces it as a fatal and the app must show its non-recoverable
 * status screen — not a blank or frozen UI. Reached by actually killing the
 * server, not by synthesizing the event.
 */
export const FatalScreen: Story = {
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
