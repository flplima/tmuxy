import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import { pasteLine, paneGroups, focusFirstPane, sessionName, paneIds } from './appStoryHelpers';

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

// ───────────────────────── §9 Sessions & connection lifecycle ─────────────────────────

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
