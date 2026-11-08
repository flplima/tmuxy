/**
 * A new desktop window's splash page (components/SplashScreen.tsx): the
 * sessions on this machine to join, and an ssh host to attach to instead.
 * The desktop's commands are stand-ins here; `windows/attach.rs` has the
 * Rust side's own tests.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { SplashScreen } from './SplashScreen';
import type { AttachChoice } from '../infra/splashWindow';

const SESSIONS = [
  { name: 'tmuxy', windows: 4, attached: true },
  { name: 'notes', windows: 1, attached: false },
  { name: 'a-session-with-a-long-name-for-its-row', windows: 2, attached: false },
];

const meta: Meta<typeof SplashScreen> = {
  title: 'Components/SplashScreen',
  component: SplashScreen,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ width: 800, height: 600 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof SplashScreen>;

/** On screen, inside the 800 × 600 window, and not clipped to nothing. */
function shown(el: Element) {
  const r = el.getBoundingClientRect();
  expect(r.width).toBeGreaterThan(0);
  expect(r.height).toBeGreaterThan(0);
  expect(r.left).toBeGreaterThanOrEqual(0);
  expect(r.right).toBeLessThanOrEqual(800);
  expect(r.bottom).toBeLessThanOrEqual(600);
}

export const PickASessionOrAHost: Story = {
  args: {
    list: () => Promise.resolve(SESSIONS),
    attach: fn(() => Promise.resolve()),
    onAttached: fn(),
  },
  parameters: {
    docs: {
      description: {
        story:
          'The sessions on this machine, each a row with its tab count and whether a client is on it; a click joins one. Below, an ssh host attaches the window to another machine instead.',
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const rows = await canvas.findAllByRole('button', { name: /tab/ });
    expect(rows.map((r) => r.querySelector('.splash-session-name')?.textContent)).toEqual(
      SESSIONS.map((s) => s.name),
    );
    rows.forEach(shown);
    expect(rows[0]).toHaveTextContent('4 tabs');
    expect(rows[0]).toHaveTextContent('attached');
    expect(rows[1]).toHaveTextContent('1 tab');
    expect(rows[1]).not.toHaveTextContent('attached');
    // The long name stays inside its row.
    const longName = rows[2].querySelector('.splash-session-name')!;
    expect(longName.getBoundingClientRect().right).toBeLessThanOrEqual(
      rows[2].getBoundingClientRect().right,
    );

    const host = canvas.getByRole('textbox', { name: 'SSH host' });
    shown(host);
    expect(canvas.getByRole('button', { name: 'Connect' })).toBeDisabled();

    await userEvent.click(rows[1]);
    await waitFor(() => expect(args.onAttached).toHaveBeenCalledTimes(1));
    expect(args.attach).toHaveBeenCalledWith({ session: 'notes' });
  },
};

export const AnSshHostItRefuses: Story = {
  args: {
    list: () => Promise.resolve(SESSIONS.slice(0, 1)),
    attach: fn((choice: AttachChoice) =>
      'ssh' in choice && choice.ssh !== 'me@box'
        ? Promise.reject({
            error: `'${choice.ssh}' is not an ssh destination: host or user@host`,
            kind: 'invalid',
          })
        : Promise.resolve(),
    ),
    onAttached: fn(),
  },
  parameters: {
    docs: {
      description: {
        story:
          'A host the desktop refuses says why, under the field, and the page stays usable; Enter on a good one attaches.',
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const host = await canvas.findByRole('textbox', { name: 'SSH host' });
    await userEvent.type(host, '-oProxyCommand=sh');
    await userEvent.click(canvas.getByRole('button', { name: 'Connect' }));
    const alert = await canvas.findByRole('alert');
    expect(alert).toHaveTextContent("'-oProxyCommand=sh' is not an ssh destination");
    shown(alert);
    expect(args.onAttached).not.toHaveBeenCalled();
    expect(host).toBeEnabled();

    await userEvent.clear(host);
    await userEvent.type(host, 'me@box{Enter}');
    await waitFor(() => expect(args.onAttached).toHaveBeenCalledTimes(1));
    expect(args.attach).toHaveBeenLastCalledWith({ ssh: 'me@box' });
  },
};

export const NoSessionOnThisMachine: Story = {
  args: {
    list: () => Promise.resolve([]),
    attach: fn(() => Promise.resolve()),
    onAttached: fn(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const note = await canvas.findByText('No tmuxy session is running on this machine.');
    shown(note);
    expect(canvas.queryAllByRole('button', { name: /tab/ })).toEqual([]);
    shown(canvas.getByRole('textbox', { name: 'SSH host' }));
  },
};
