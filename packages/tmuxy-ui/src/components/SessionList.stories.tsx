/**
 * SessionList stories, over a recording of real tmux: the way back in once
 * detached.
 *
 * Driven the way a user gets there — Detach Session from the app menu — and
 * back: the overlay lists the sessions, on screen, and picking one attaches
 * to it again, the overlay gone and the panes back.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { FixtureApp } from '../stories/FixtureHarness';
import { asFixture } from '../stories/fixtures/FixtureAdapter';
import panes from '../stories/fixtures/gen/panes.json';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/SessionList',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
  args: { fixture: asFixture(panes), start: 'one' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

export const DetachThenPickASession: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    const user = userEvent.setup();
    await waitFor(() => expect(canvas.getAllByRole('group', { name: /^Pane %/ }).length).toBe(1), {
      timeout: 15000,
    });

    await user.click(canvas.getByRole('button', { name: 'Menu' }));
    await user.click(page.getByRole('menuitem', { name: 'Session' }));
    await user.click(await page.findByRole('menuitem', { name: /Detach Session/ }));

    // The overlay says so, and lists the session to step back into, on screen.
    await waitFor(() => expect(canvas.getByText('Detached')).toBeInTheDocument());
    const list = canvasElement.querySelector('.session-list') as HTMLElement;
    expect(list).not.toBeNull();
    const session = within(list).getByRole('button', { name: /demo/ });
    const box = session.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    // Connecting to a new server needs an attached session for its float.
    expect(within(list).queryByText(/Connect over SSH/)).toBeNull();

    await user.click(session);
    await waitFor(() => expect(canvas.queryByText('Detached')).toBeNull());
    await waitFor(() => {
      const pane = canvas.getAllByRole('group', { name: /^Pane %/ })[0];
      expect(pane.getBoundingClientRect().height).toBeGreaterThan(0);
    });
  },
};
