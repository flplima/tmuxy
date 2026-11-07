/**
 * What Escape means, over states recorded from real tmux
 * (`fixtures/scenarios/escape-float.ts`): the same key, resolved by focus.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture, adapterHolder } from './fixtures/FixtureAdapter';
import escapeFloat from './fixtures/gen/escape-float.json';
import { activePaneId, paneGroups, windows } from './appStoryHelpers';
import { storyApp } from './storyApp';

const meta: Meta<typeof FixtureApp> = {
  title: 'Scenarios/Escape Key',
  component: FixtureApp,
  args: { fixture: asFixture(escapeFloat), start: 'float-open' },
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

const held = adapterHolder();
/**
 * With a float focused, Escape closes it (the app kills the float's pane).
 * With a plain pane focused, Escape is the application's: it goes to the pane.
 */
export const EscapeSemanticsMatrix: Story = {
  args: { transitions: [{ match: /^kill-pane -t %1$/, to: 'float-closed' }] },
  render: (args) => <FixtureApp {...args} onAdapterReady={held.keep} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const doc = canvasElement.ownerDocument;
    const focusedFloat = () => storyApp().view().keyboardTarget.paneId;

    await waitFor(
      () => {
        const overlay = doc.querySelector('.float-container') as HTMLElement | null;
        expect(overlay, 'float shown').not.toBeNull();
        expect(overlay!.getBoundingClientRect().width).toBeGreaterThan(100);
        expect(focusedFloat()).toBe('%1');
      },
      { timeout: 10000 },
    );
    await user.keyboard('{Escape}');
    await waitFor(
      () => {
        expect(doc.querySelector('.float-container'), 'float closed by Escape').toBeNull();
        expect(windows().some((w) => w.windowType === 'float')).toBe(false);
      },
      { timeout: 10000 },
    );
    expect(held.adapter!.commands).toContain('kill-pane -t %1');

    await user.click(paneGroups(canvas)[0]);
    await waitFor(() => expect(activePaneId()).toBe('%0'), { timeout: 10000 });
    const before = held.adapter!.commands.length;
    await user.keyboard('{Escape}');
    await waitFor(
      () =>
        expect(
          held.adapter!.commands.slice(before),
          `sent: ${JSON.stringify(held.adapter!.commands)}`,
        ).toContain('send-keys -t %0 Escape'),
      { timeout: 5000 },
    );
    expect(paneGroups(canvas).length).toBe(1);
    expect(held.adapter!.commands.slice(before).some((c) => c.startsWith('kill-pane'))).toBe(false);
  },
};
