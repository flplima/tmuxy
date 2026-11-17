import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { TmuxStatusBar } from './TmuxStatusBar';
import { ActivityInbox } from './ActivityInbox';
import type { ActivityRow } from '../domain/activity';
import { pid, wid } from '../test/wire';
import { FixtureProvider } from '../stories/FixtureHarness';
import { asFixture } from '../stories/fixtures/FixtureAdapter';
import panes from '../stories/fixtures/gen/panes.json';
import { storyApp } from '../stories/storyApp';
import type { AppHandle } from '../machines/testView';

type AppEvent = Parameters<AppHandle['send']>[0];

const PANES = asFixture(panes);

const meta: Meta<typeof TmuxStatusBar> = {
  title: 'Components/TmuxStatusBar',
  component: TmuxStatusBar,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof TmuxStatusBar>;

export const Default: Story = {
  render: () => (
    <FixtureProvider height={60} fixture={{ ...PANES, hostname: 'gaphs04' }} start="one">
      <TmuxStatusBar />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = await waitFor(() => canvas.getByTestId('tmux-status-bar'), { timeout: 5000 });
    // The host segment names the machine the server greeted us from, not
    // the address the page was opened at.
    const host = bar.querySelector('.statusline-host');
    expect(host).not.toBeNull();
    expect(host).toHaveClass('statusline-clickable');
    await waitFor(() => expect(host).toHaveTextContent('gaphs04'));
  },
};

export const Demo: Story = {
  render: () => (
    <FixtureProvider height={60} fixture={PANES} start="one" config={{ isDemo: true }}>
      <TmuxStatusBar />
    </FixtureProvider>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'With `isDemo`, the hostname / session segments lose their click handlers (no SSH or session switcher in the demo site).',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = await waitFor(() => canvas.getByTestId('tmux-status-bar'), { timeout: 5000 });
    const host = bar.querySelector('.statusline-host');
    expect(host).not.toBeNull();
    expect(host).not.toHaveClass('statusline-clickable');
    expect(host).toHaveTextContent(/demo@localhost/);
  },
};

const barBox = (canvasElement: HTMLElement) => {
  const bar = canvasElement.querySelector(
    '[data-testid="tmux-status-bar"], [data-testid="tmux-command-mode"]',
  );
  const box = bar?.getBoundingClientRect();
  return box ? { top: box.top, height: box.height } : null;
};

/** Left to its content, the bar moved by a few pixels on every prefix press. */
export const SameHeightInEveryMode: Story = {
  render: () => (
    <FixtureProvider height={60} fixture={PANES} start="one">
      <TmuxStatusBar />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => canvas.getByTestId('tmux-status-bar'), { timeout: 5000 });
    const send = (event: AppEvent) => storyApp().send(event);
    const normal = barBox(canvasElement);
    expect(normal?.height).toBeGreaterThan(0);

    const states: Array<[string, AppEvent, string]> = [
      ['prefix', { type: 'PREFIX_MODE_CHANGE', active: true }, 'prefix'],
      ['pane table', { type: 'KEY_TABLE_CHANGE', table: 'pane' }, 'pane'],
    ];
    for (const [name, event, mode] of states) {
      send(event);
      await waitFor(() =>
        expect(canvasElement.querySelector(`[data-key-mode="${mode}"]`)).not.toBeNull(),
      );
      expect(barBox(canvasElement), name).toEqual(normal);
    }
    send({ type: 'KEY_TABLE_CHANGE', table: null });
    send({ type: 'PREFIX_MODE_CHANGE', active: false });

    send({ type: 'OPEN_COMMAND_PROMPT', prompt: null, initial: '', template: null });
    await waitFor(() => expect(canvas.getByTestId('tmux-command-mode')).toBeInTheDocument());
    expect(barBox(canvasElement), 'command prompt').toEqual(normal);
    send({ type: 'COMMAND_MODE_CANCEL' });
    await waitFor(() => expect(canvas.getByTestId('tmux-status-bar')).toBeInTheDocument());
    expect(barBox(canvasElement), 'back to normal').toEqual(normal);
  },
};

const row = (pane: string, state: ActivityRow['state'], session = 'work'): ActivityRow => ({
  paneId: pid(pane),
  windowId: wid('@4'),
  session,
  tab: 'main',
  tabIndex: 0,
  state,
  name: 'claude',
  said: '',
});

const rectOf = (el: Element) => el.getBoundingClientRect();

/** The counts sit at the line's right end, left of the host, only for what is above zero. */
export const InboxCounts: Story = {
  render: () => (
    <FixtureProvider height={60} fixture={{ ...PANES, hostname: 'gaphs04' }} start="one">
      <TmuxStatusBar />
      <ActivityInbox />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => canvas.getByTestId('tmux-status-bar'), { timeout: 5000 });
    expect(canvas.queryByTestId('statusline-inbox')).toBeNull();

    storyApp().send({
      type: 'ACTIVITY_LOADED',
      rows: [row('%7', 'needs-input', 'play'), row('%8', 'error'), row('%9', 'error')],
    });
    const chip = await waitFor(() => canvas.getByTestId('statusline-inbox'));
    expect(chip).toHaveAccessibleName('1 pane needs you, 2 failed');
    expect(canvas.getByTestId('statusline-inbox-waiting')).toHaveTextContent('⚠️ 1');
    expect(canvas.getByTestId('statusline-inbox-failed')).toHaveTextContent('❌ 2');
    const host = canvasElement.querySelector('.statusline-host')!;
    expect(rectOf(chip).width).toBeGreaterThan(0);
    expect(rectOf(chip).right).toBeLessThanOrEqual(rectOf(host).left);

    storyApp().send({ type: 'ACTIVITY_LOADED', rows: [row('%8', 'error')] });
    await waitFor(() => expect(canvas.queryByTestId('statusline-inbox-waiting')).toBeNull());
    expect(canvas.getByTestId('statusline-inbox')).toHaveAccessibleName('1 failed');

    storyApp().send({ type: 'ACTIVITY_LOADED', rows: [row('%8', 'working')] });
    await waitFor(() => expect(canvas.queryByTestId('statusline-inbox')).toBeNull());
  },
};

/** More than one counted pane: a click opens the inbox. */
export const InboxCountsOpenTheInbox: Story = {
  render: () => (
    <FixtureProvider height={60} fixture={PANES} start="one">
      <TmuxStatusBar />
      <ActivityInbox />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => canvas.getByTestId('tmux-status-bar'), { timeout: 5000 });
    storyApp().send({
      type: 'ACTIVITY_LOADED',
      rows: [row('%7', 'needs-input', 'play'), row('%8', 'error')],
    });
    (await waitFor(() => canvas.getByTestId('statusline-inbox'))).click();
    await waitFor(() => expect(canvas.getByTestId('activity-inbox')).toBeInTheDocument());
    storyApp().send({ type: 'TOGGLE_ACTIVITY' });
    await waitFor(() => expect(canvas.queryByTestId('activity-inbox')).toBeNull());
  },
};

/** On a phone's width both counts and the host still fit the line. */
export const InboxCountsOnAPhone: Story = {
  render: () => (
    <FixtureProvider
      width={390}
      height={60}
      fixture={{ ...PANES, hostname: 'gaphs04' }}
      start="one"
    >
      <TmuxStatusBar />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => canvas.getByTestId('tmux-status-bar'), { timeout: 5000 });
    // A phone's width hides the hints by media query; the story's viewport is
    // wider than that, so it hides them the same way.
    const phoneRule = document.createElement('style');
    phoneRule.textContent = '.statusline-hints { display: none; }';
    document.head.append(phoneRule);
    storyApp().send({
      type: 'ACTIVITY_LOADED',
      rows: [row('%7', 'needs-input', 'play'), row('%8', 'error')],
    });
    const chip = await waitFor(() => canvas.getByTestId('statusline-inbox'));
    const bar = rectOf(canvas.getByTestId('tmux-status-bar'));
    const session = rectOf(canvasElement.querySelector('.statusline-session')!);
    expect(rectOf(chip).left).toBeGreaterThanOrEqual(bar.left);
    expect(session.right).toBeLessThanOrEqual(bar.right);
    expect(rectOf(chip).height).toBeLessThanOrEqual(bar.height);
    phoneRule.remove();
  },
};
