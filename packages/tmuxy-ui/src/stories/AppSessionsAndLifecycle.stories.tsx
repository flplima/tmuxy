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

/**
 * Splitting inside a second session and hopping back and forth: each session
 * keeps its own pane set after every switch.
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
    pasteLine('tmux new-session -d -s rt && echo RT_MADE');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some(
            (p: HTMLElement) => (p.textContent ?? '').split('RT_MADE').length - 1 >= 2,
          ),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
    app.send({ type: 'SWITCH_SESSION', sessionName: 'rt' });
    await waitFor(() => expect(sessionName()).toBe('rt'), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(paneGroups(canvas).length).toBe(1), {
      timeout: 20000,
      interval: 500,
    });
    await focusFirstPane(canvas, user).catch(() => {});
    pasteLine('tmuxy pane split');
    await waitFor(() => expect(paneGroups(canvas).length).toBe(2), {
      timeout: 30000,
      interval: 500,
    });
    app.send({ type: 'SWITCH_SESSION', sessionName: 'm' });
    await waitFor(
      () => {
        expect(sessionName()).toBe('m');
        expect(paneGroups(canvas).length).toBe(panesOnM);
      },
      { timeout: 30000, interval: 500 },
    );
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
 * Killing the tmux server in the guest ends the control stream (`%exit`): the
 * app shows its non-recoverable status screen, not a blank or frozen UI.
 * Reached by really killing the server.
 */
export const FatalScreen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('tmux kill-server');
    await waitFor(
      () =>
        expect(
          canvasElement.ownerDocument.querySelector('[data-testid="fatal-display"]'),
        ).not.toBeNull(),
      { timeout: 40000, interval: 500 },
    );
  },
};
