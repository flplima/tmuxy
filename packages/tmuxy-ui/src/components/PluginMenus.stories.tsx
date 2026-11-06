/**
 * The recording's tmux has no plugins and a recorded transport answers no
 * queries, so the `@tmuxy-plugins` inventory is handed to the machine as the
 * read would (`PLUGINS_RECEIVED`). Opening the action's surface in real tmux
 * is `tests/17-plugins.test.js`.
 */

import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PaneContextMenu } from './PaneContextMenu';
import { FixtureProvider } from '../stories/FixtureHarness';
import { asFixture, type FixtureAdapter } from '../stories/fixtures/FixtureAdapter';
import panes from '../stories/fixtures/gen/panes.json';
import { PaneId } from '../domain/ids';
import { useAppSend } from '../machines/appHooks';
import type { PluginInfo } from '../domain/plugins';

const PANES = asFixture(panes);

const PLUGINS: PluginInfo[] = [
  {
    name: 'artifacts',
    actions: [
      { id: 'open', title: 'Open Artifact', menu: 'pane', surface: 'popup' },
      { id: 'home', title: 'Artifacts Home', menu: 'app', surface: 'tab' },
    ],
    linkHosts: [],
    textLinks: false,
  },
  {
    name: 'devtools',
    actions: [{ id: 'inspect', title: 'Inspect Page', menu: 'pane', surface: 'split' }],
    linkHosts: [],
    textLinks: false,
  },
];

let adapter: FixtureAdapter | null = null;
const keepAdapter = (a: FixtureAdapter) => {
  adapter = a;
};

function Host({ plugins }: { plugins: PluginInfo[] }) {
  const send = useAppSend();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    send({ type: 'PLUGINS_RECEIVED', plugins });
  }, [send, plugins]);
  return (
    <div style={{ height: 420, color: 'var(--text-primary)' }}>
      <div data-testid="ctx-state">{open ? 'open' : 'closed'}</div>
      {open && (
        <PaneContextMenu paneId={PaneId.make('%0')} x={120} y={60} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

const meta: Meta<typeof Host> = {
  title: 'Components/PluginMenus',
  component: Host,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof Host>;

export const PaneMenuRunsAPluginAction: Story = {
  render: () => (
    <FixtureProvider height={440} fixture={PANES} start="one" onAdapterReady={keepAdapter}>
      <Host plugins={PLUGINS} />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = within(document.body);
    await userEvent.click(await waitFor(() => menu.getByRole('menuitem', { name: 'Plugins' })));

    // Each plugin's pane actions, under its name; the app action is not here.
    const open = await waitFor(() => menu.getByRole('menuitem', { name: 'Open Artifact' }));
    expect(menu.getByRole('menuitem', { name: 'Inspect Page' })).toBeInTheDocument();
    expect(menu.queryByRole('menuitem', { name: 'Artifacts Home' })).toBeNull();
    expect(menu.getByText('artifacts')).toBeInTheDocument();
    expect(menu.getByText('devtools')).toBeInTheDocument();
    // On screen, not merely mounted.
    const box = open.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(40);
    expect(box.height).toBeGreaterThan(10);

    const sentBefore = adapter!.commands.length;
    await userEvent.click(open);
    await waitFor(() => expect(canvas.getByTestId('ctx-state')).toHaveTextContent('closed'));
    await waitFor(() =>
      expect(adapter!.commands.slice(sentBefore)).toContain(
        'run-shell -b "\\"$TMUXY_DATA_DIR/bin/tmuxy-cli\\" plugin action artifacts:open' +
          ' --pane %0 --trigger menu >/dev/null 2>&1"',
      ),
    );
  },
};

export const NoPluginsNoSubmenu: Story = {
  render: () => (
    <FixtureProvider height={440} fixture={PANES} start="one">
      <Host plugins={[]} />
    </FixtureProvider>
  ),
  play: async () => {
    const menu = within(document.body);
    await waitFor(() => menu.getByRole('menuitem', { name: /close pane/i }));
    expect(menu.queryByRole('menuitem', { name: 'Plugins' })).toBeNull();
  },
};
