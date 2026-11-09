/**
 * A new desktop window's splash page (components/SplashScreen.tsx and
 * SplashSshForm.tsx): a new session on this machine, the sessions already
 * there to join, and a form to attach to another machine over ssh instead.
 * The desktop's commands are stand-ins here; `windows/attach.rs` and
 * `windows/ssh_link.rs` have the Rust side's own tests.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { SplashScreen } from './SplashScreen';
import type { AttachChoice, AttachOutcome } from '../infra/splashWindow';

const SESSIONS = [
  { name: 'tmuxy', windows: 4, attached: true },
  { name: '1', windows: 1, attached: false },
  { name: 'a-session-with-a-long-name-for-its-row', windows: 2, attached: false },
];

const ATTACHED: AttachOutcome = { attached: true };
const FINGERPRINT = 'ED25519 SHA256:sC/GS/wVKZOj45OzPf+0vZ4d+c1nAzK7rzFKZzti6GE';

const meta: Meta<typeof SplashScreen> = {
  title: 'Components/SplashScreen',
  component: SplashScreen,
  parameters: { layout: 'fullscreen' },
  args: {
    list: () => Promise.resolve(SESSIONS),
    attach: fn(() => Promise.resolve(ATTACHED)),
    onAttached: fn(),
    sshHosts: () => Promise.resolve(['work', 'pi']),
    pickFile: fn(() => Promise.resolve('/home/me/.ssh/id_ed25519')),
  },
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

/**
 * On screen once the page has scrolled to it (the page scrolls: the ssh form
 * sits under the sessions), inside the 800-wide window, not clipped to nothing.
 */
function shown(el: Element) {
  el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect();
  expect(r.width).toBeGreaterThan(0);
  expect(r.height).toBeGreaterThan(0);
  expect(r.left).toBeGreaterThanOrEqual(0);
  expect(r.right).toBeLessThanOrEqual(800);
  expect(r.top).toBeGreaterThanOrEqual(0);
  expect(r.bottom).toBeLessThanOrEqual(600);
}

export const PickASessionOrAHost: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'This machine first: a New session row, then the sessions already running, each with its tab count and whether a client is on it; a click joins one. Below, the ssh form attaches the window to another machine instead.',
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
    // The new session row comes first, above the running ones.
    const fresh = canvas.getByRole('button', { name: /New session/ });
    expect(fresh.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      rows[0].getBoundingClientRect().top,
    );

    shown(canvas.getByLabelText('Host'));
    expect(canvas.getByRole('button', { name: 'Connect' })).toBeDisabled();

    await userEvent.click(rows[1]);
    await waitFor(() => expect(args.onAttached).toHaveBeenCalledTimes(1));
    expect(args.attach).toHaveBeenCalledWith({ session: '1' });
  },
};

export const NewSessionOnThisMachine: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'New session asks for a name, offering the next free number; left empty it takes that number, which the desktop works out the same way.',
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByRole('button', { name: /tab/ });
    await userEvent.click(canvas.getByRole('button', { name: /New session/ }));
    const name = canvas.getByRole('textbox', { name: 'Name of the new session' });
    shown(name);
    expect(name).toHaveFocus();
    // '1' is taken, so the next is 2.
    expect(name).toHaveAttribute('placeholder', '2');

    // Cancel puts the row back; a name and Enter creates it.
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    expect(canvas.queryByRole('textbox', { name: 'Name of the new session' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: /New session/ }));
    await userEvent.type(
      canvas.getByRole('textbox', { name: 'Name of the new session' }),
      'scratch{Enter}',
    );
    await waitFor(() => expect(args.onAttached).toHaveBeenCalledTimes(1));
    expect(args.attach).toHaveBeenCalledWith({ newSession: 'scratch' });
  },
};

export const ConnectOverSshWithAKeyAndAPassword: Story = {
  args: {
    attach: fn((choice: AttachChoice) =>
      'ssh' in choice && choice.ssh.host.startsWith('-')
        ? Promise.reject({
            error: `'${choice.ssh.host}' is not a host to connect to: a name or an address, with the port in its own field`,
            kind: 'invalid',
          })
        : Promise.resolve(ATTACHED),
    ),
  },
  parameters: {
    docs: {
      description: {
        story:
          'The host and its port on one row, then the user, then the optional sign-in: a password or key passphrase (hidden, with Show), and a key file and a certificate, each with a native chooser. A host the desktop refuses says why and the form stays as filled; a good one sends only what was filled in.',
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const host = await canvas.findByLabelText('Host');
    const port = canvas.getByRole('textbox', { name: 'Port' });
    // Side by side: the port to the right of the host, on its row.
    shown(host);
    shown(port);
    const [h, p] = [host.getBoundingClientRect(), port.getBoundingClientRect()];
    expect(p.left).toBeGreaterThan(h.right);
    expect(Math.abs(p.top - h.top)).toBeLessThan(2);
    // The host field offers the names in ~/.ssh/config.
    await waitFor(() => expect(host).toHaveAttribute('list'));
    const options = [...canvasElement.querySelectorAll('datalist option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(['work', 'pi']);

    // An option for a host: refused, with the reason, and nothing lost.
    await userEvent.type(host, '-oProxyCommand=sh');
    await userEvent.click(canvas.getByRole('button', { name: 'Connect' }));
    const alert = await canvas.findByRole('alert');
    expect(alert).toHaveTextContent("'-oProxyCommand=sh' is not a host to connect to");
    shown(alert);
    expect(args.onAttached).not.toHaveBeenCalled();
    expect(host).toBeEnabled();

    // A port is digits only.
    await userEvent.type(port, '22a22');
    expect(port).toHaveValue('2222');

    await userEvent.clear(host);
    await userEvent.type(host, 'box.example.com');
    await userEvent.type(canvas.getByRole('textbox', { name: 'User' }), 'me');
    const password = canvas.getByLabelText('Password or key passphrase');
    expect(password).toHaveAttribute('type', 'password');
    await userEvent.type(password, 's3cret pass');
    await userEvent.click(canvas.getByRole('button', { name: 'Show' }));
    expect(password).toHaveAttribute('type', 'text');
    await userEvent.click(canvas.getByRole('button', { name: 'Choose the key file' }));
    await waitFor(() =>
      expect(canvas.getByRole('textbox', { name: 'Key file' })).toHaveValue(
        '/home/me/.ssh/id_ed25519',
      ),
    );
    shown(canvas.getByRole('textbox', { name: 'Certificate' }));

    await userEvent.click(canvas.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(args.onAttached).toHaveBeenCalledTimes(1));
    // What was filled in, and nothing that was not: no certificate field.
    expect(args.attach).toHaveBeenLastCalledWith({
      ssh: {
        host: 'box.example.com',
        user: 'me',
        port: 2222,
        identityFile: '/home/me/.ssh/id_ed25519',
        password: 's3cret pass',
      },
    });
  },
};

export const AHostWhoseKeyIsNotKnownYet: Story = {
  args: {
    attach: fn((choice: AttachChoice) =>
      Promise.resolve<AttachOutcome>(
        'ssh' in choice && !choice.ssh.trustNewHost
          ? { unknownHost: { fingerprint: FINGERPRINT } }
          : ATTACHED,
      ),
    ),
  },
  parameters: {
    docs: {
      description: {
        story:
          'A host this machine has never seen is not trusted silently: the page shows its key fingerprint and asks. Trust and connect sends the form again with the host trusted; Cancel goes back to the form.',
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Host'), 'me@box{Enter}');
    const ask = await canvas.findByRole('alertdialog', { name: 'Trust this host?' });
    shown(ask);
    expect(ask).toHaveTextContent('First connection to me@box');
    expect(ask).toHaveTextContent(FINGERPRINT);
    expect(args.onAttached).not.toHaveBeenCalled();
    expect(canvas.queryByRole('button', { name: 'Connect' })).toBeNull();

    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(canvas.queryByRole('alertdialog')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Connect' }));
    const again = await canvas.findByRole('alertdialog');
    await userEvent.click(within(again).getByRole('button', { name: 'Trust and connect' }));
    await waitFor(() => expect(args.onAttached).toHaveBeenCalledTimes(1));
    expect(args.attach).toHaveBeenLastCalledWith({
      ssh: { host: 'me@box', trustNewHost: true },
    });
  },
};

export const NoSessionOnThisMachine: Story = {
  args: { list: () => Promise.resolve([]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    shown(await canvas.findByRole('button', { name: /New session/ }));
    await waitFor(() => expect(canvas.queryByText('Looking for sessions…')).toBeNull());
    expect(canvas.queryAllByRole('button', { name: /tab/ })).toEqual([]);
    shown(canvas.getByLabelText('Host'));
  },
};
