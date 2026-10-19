import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { TmuxySession } from './TmuxySession';
import { ConnectionOverlay } from '../../ConnectionOverlay';
import { ProviderHarness } from '../../../stories/StoryHarness';

/**
 * The switcher draws from machine context rather than from pane content, so a
 * provider is all it needs to stand up — no tmux, no float.
 *
 * The demo engine is single-session (`enumeratesSessions` is false), so the
 * sessions poll never answers and `context.sessions` stays empty. That is the
 * case worth pinning: the widget must still list the session it is attached
 * to, because that is the one it knows without any poll.
 */
const meta: Meta<typeof TmuxySession> = {
  title: 'Widgets/Session Switcher',
  component: TmuxySession,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <ProviderHarness height={320} width={420}>
        <Story />
      </ProviderHarness>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof TmuxySession>;

export const ListsTheAttachedSession: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const switcher = await canvas.findByTestId('session-switcher', undefined, { timeout: 8000 });

    // The attached session is listed and marked as current, even with nothing
    // from the poll.
    const row = await waitFor(
      () => {
        const el = switcher.querySelector('.widget-session-row') as HTMLElement | null;
        if (!el) throw new Error('no session row yet');
        return el;
      },
      { timeout: 8000 },
    );
    expect(row.className).toContain('is-current');
    expect((row.textContent ?? '').trim().length).toBeGreaterThan(0);

    // Drawn, not merely present: the row has real height inside the widget.
    const box = row.getBoundingClientRect();
    expect(box.height).toBeGreaterThan(0);
    expect(box.width).toBeGreaterThan(0);

    // No Servers section on a build with no server list — the web/demo case.
    expect(switcher.textContent).not.toContain('Servers');

    // The verbs are advertised where the user can see them (and never list `esc`).
    const actions = switcher.querySelector('.widget-session-actions') as HTMLElement;
    expect(actions).not.toBeNull();
    for (const key of ['j/k', 'r', 'x', 'd']) {
      expect(actions.textContent).toContain(key);
    }
    expect(actions.textContent).not.toContain('esc');
  },
};

/**
 * The connect form is desktop-only: `list_servers` is a Tauri command, so a
 * web client has no server list to add to. Here the server list is delivered
 * the way the poll delivers it, which is also what makes the `c` key live.
 */
export const ConnectingAsksForOneDestination: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const switcher = await canvas.findByTestId('session-switcher', undefined, { timeout: 8000 });

    // With no server list there is nothing to connect to, so the key is not
    // advertised and the section does not draw.
    expect(switcher.querySelector('.widget-session-actions')?.textContent).not.toContain('connect');

    const win = window as unknown as { app: { send(e: unknown): void } };
    win.app.send({
      type: 'SERVERS_UPDATED',
      currentServerId: 'localhost',
      servers: [
        {
          id: 'localhost',
          label: 'localhost',
          kind: 'local',
          socket: 'tmuxy',
          reachable: 'online',
          session_count: 2,
        },
        {
          id: 'ssh-box-tmuxy',
          label: 'felipe@box',
          kind: 'ssh',
          socket: 'tmuxy',
          ssh: { host: 'box', user: 'felipe' },
          reachable: 'known',
        },
      ],
    });

    await waitFor(() => expect(switcher.textContent).toContain('Servers'), { timeout: 5000 });
    const sshRow = switcher.querySelector(
      '[data-testid="server-row-ssh-box-tmuxy"]',
    ) as HTMLElement;
    expect(sshRow).not.toBeNull();
    expect(sshRow.textContent).toContain('ssh felipe@box · tmuxy');
    expect(switcher.querySelector('[data-testid="session-connect-row"]')).not.toBeNull();

    // `c` opens the form — two fields, live read-back, and nothing else to fill in.
    await userEvent.keyboard('c');
    const form = await waitFor(
      () => {
        const el = switcher.querySelector('[data-testid="session-connect-form"]') as HTMLElement;
        if (!el) throw new Error('no connect form yet');
        return el;
      },
      { timeout: 5000 },
    );
    const fields = form.querySelectorAll('input');
    expect(fields.length).toBe(2);
    expect(form.textContent).toContain('Keys');
    expect(form.textContent).toContain('jump hosts');

    // Live read-back updates as the user types a destination and socket.
    const readback = form.querySelector('[data-testid="session-connect-readback"]') as HTMLElement;
    expect(readback).not.toBeNull();
    expect(readback.textContent).toContain('→ tmux -L tmuxy on this machine');
    await userEvent.type(fields[0], 'dev@prod');
    await waitFor(() =>
      expect(readback.textContent).toContain('→ ssh dev@prod, then tmux -L tmuxy'),
    );

    // It is really drawn, inside the widget.
    const box = form.getBoundingClientRect();
    expect(box.height).toBeGreaterThan(0);
    expect(box.width).toBeGreaterThan(0);

    // Escape backs out without saving anything.
    await userEvent.keyboard('{Escape}');
    await waitFor(
      () => expect(switcher.querySelector('[data-testid="session-connect-form"]')).toBeNull(),
      { timeout: 5000 },
    );
  },
};

/**
 * Step 3 (Staged Connecting View) & Step 4 (Per-Server Sessions):
 * Shows the 4 stages (`ssh`, `tmux`, `listing sessions`, `attach`), displays
 * verbatim stderr when a stage fails, and transitions to Step 4 (`Sessions · <server>`)
 * with the cursor starting on `+ new session…` when the server has 0 sessions.
 */
export const StagedConnectFlowAndPerServerSessions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const switcher = await canvas.findByTestId('session-switcher', undefined, { timeout: 8000 });
    const win = window as unknown as { app: { send(e: unknown): void } };

    // 1. Trigger a failed Step 3 probe: verify ✗ and verbatim stderr are visible.
    win.app.send({
      type: 'PROBE_SERVER_RESULT',
      probe: {
        server: {
          id: 'ssh-box-tmuxy',
          label: 'felipe@box',
          kind: 'ssh',
          socket: 'tmuxy',
          ssh: { host: 'box', user: 'felipe' },
        },
        status: 'failed',
        stages: [
          {
            name: 'ssh',
            label: 'ssh felipe@box',
            status: 'failed',
            elapsed_ms: 42,
            error: 'felipe@box: Permission denied (publickey).',
          },
          { name: 'tmux', label: 'tmux on the socket tmuxy', status: 'pending' },
          { name: 'sessions', label: 'listing sessions', status: 'pending' },
          { name: 'attach', label: 'attach', status: 'pending' },
        ],
        sessions: [],
      },
    });

    const stageView = await waitFor(
      () => {
        const el = switcher.querySelector('[data-testid="session-connecting-view"]') as HTMLElement;
        if (!el) throw new Error('no connecting view yet');
        return el;
      },
      { timeout: 5000 },
    );
    expect(stageView.getBoundingClientRect().height).toBeGreaterThan(0);
    const errPre = stageView.querySelector(
      '[data-testid="session-stage-error-ssh"]',
    ) as HTMLElement;
    expect(errPre).not.toBeNull();
    expect(errPre.textContent).toContain('Permission denied (publickey)');

    // 2. Complete the probe with 0 sessions: Step 4 opens for `felipe@box` and
    // the cursor starts on `+ new session…`.
    win.app.send({
      type: 'PROBE_SERVER_RESULT',
      probe: {
        server: {
          id: 'ssh-box-tmuxy',
          label: 'felipe@box',
          kind: 'ssh',
          socket: 'tmuxy',
          ssh: { host: 'box', user: 'felipe' },
        },
        status: 'done',
        stages: [
          { name: 'ssh', label: 'ssh felipe@box', status: 'done', elapsed_ms: 18 },
          { name: 'tmux', label: 'tmux 3.5a on the socket tmuxy', status: 'done', elapsed_ms: 12 },
          { name: 'sessions', label: 'listing sessions', status: 'done', elapsed_ms: 9 },
          { name: 'attach', label: 'attach', status: 'done', elapsed_ms: 0 },
        ],
        sessions: [],
      },
    });

    await waitFor(
      () => {
        const heading = switcher.querySelector('[data-testid="session-list-heading"]');
        expect(heading?.textContent).toContain('Sessions · felipe@box');
      },
      { timeout: 5000 },
    );
    const newRow = switcher.querySelector('[data-testid="session-new-row"]') as HTMLElement;
    expect(newRow).not.toBeNull();
    expect(newRow.className).toContain('is-selected');
    expect(newRow.getBoundingClientRect().height).toBeGreaterThan(0);
  },
};

/**
 * Detaching is not a wait: the session the user stepped out of stays mounted
 * and blurred underneath — the same scrim `reconnecting` uses — but there is
 * no spinner, because nothing is being retried. The way back in is this
 * widget, hosted by the overlay instead of by a float pane.
 *
 * It lives here rather than beside the other ConnectionOverlay stories because
 * it needs a provider: that file's stories are pure components.
 */
export const DetachedOverlayShowsTheSwitcher: Story = {
  render: () => (
    <ConnectionOverlay
      mode="detached"
      hasLayout
      error={null}
      fatalError={null}
      log={[]}
      onRetry={() => {}}
    >
      <TmuxySession />
    </ConnectionOverlay>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const overlay = canvas.getByTestId('loading-display');
    expect(overlay).toHaveAttribute('data-mode', 'detached');
    expect(canvas.getByText('Detached')).toBeVisible();

    // Blurred, exactly as the reconnecting overlay is.
    const scrim = overlay.querySelector('.connection-overlay-scrim') as HTMLElement;
    expect(getComputedStyle(scrim).backdropFilter).toContain('blur');

    // No spinner: a deliberate detach is not something being retried.
    expect(overlay.querySelector('.connection-spinner')).toBeNull();

    // The switcher is really drawn on the scrim, with size, inside the overlay.
    const switcher = await canvas.findByTestId('session-switcher', undefined, { timeout: 8000 });
    const s = switcher.getBoundingClientRect();
    const o = overlay.getBoundingClientRect();
    expect(s.height).toBeGreaterThan(0);
    expect(s.width).toBeGreaterThan(0);
    expect(s.top).toBeGreaterThanOrEqual(o.top - 1);
    expect(s.bottom).toBeLessThanOrEqual(o.bottom + 1);

    // ...and it lists something to go back to.
    expect(switcher.querySelector('.widget-session-row')).not.toBeNull();
  },
};

export const RenameOpensAFieldInPlace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const switcher = await canvas.findByTestId('session-switcher', undefined, { timeout: 8000 });
    await waitFor(() => expect(switcher.querySelector('.widget-session-row')).not.toBeNull(), {
      timeout: 8000,
    });

    // `r` turns the selected row's label into a field holding what it already
    // says — the same gesture the tab strip and the tree use.
    await userEvent.keyboard('r');
    const input = await waitFor(
      () => {
        const el = switcher.querySelector('[data-testid="inline-rename"]') as HTMLInputElement;
        if (!el) throw new Error('no rename field yet');
        return el;
      },
      { timeout: 5000 },
    );
    expect(input.value.length).toBeGreaterThan(0);

    // Escape puts it back, leaving the row as it was.
    await userEvent.keyboard('{Escape}');
    await waitFor(
      () => expect(switcher.querySelector('[data-testid="inline-rename"]')).toBeNull(),
      { timeout: 5000 },
    );
    expect(switcher.querySelector('.widget-session-row')).not.toBeNull();
  },
};
