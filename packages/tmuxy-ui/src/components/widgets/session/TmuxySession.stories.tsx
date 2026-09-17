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

    // The verbs are advertised where the user can see them.
    const actions = switcher.querySelector('.widget-session-actions') as HTMLElement;
    expect(actions).not.toBeNull();
    for (const key of ['j/k', 'r', 'x', 'd', 'esc']) {
      expect(actions.textContent).toContain(key);
    }
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
        { id: 'localhost', label: 'localhost', kind: 'local', socket: 'tmuxy' },
        {
          id: 'ssh-box-tmuxy',
          label: 'felipe@box',
          kind: 'ssh',
          socket: 'tmuxy',
          ssh: { host: 'box', user: 'felipe' },
        },
      ],
    });

    await waitFor(() => expect(switcher.textContent).toContain('Servers'), { timeout: 5000 });
    expect(switcher.querySelector('[data-testid="server-row-ssh-box-tmuxy"]')).not.toBeNull();

    // `c` opens the form — two fields, and nothing else to fill in: keys,
    // ports and jump hosts come from the user's own ~/.ssh/config.
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
    // The form says where everything it does NOT ask for comes from. Matched on
    // words rather than the path itself, which JSX may wrap mid-token.
    expect(form.textContent).toContain('Keys');
    expect(form.textContent).toContain('jump hosts');

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
 * Detaching is not a wait: the session the user stepped out of stays mounted
 * and blurred underneath — the same scrim `reconnecting` uses — but there is
 * no spinner, because nothing is being retried. The way back in is this
 * widget, hosted by the overlay instead of by a float pane.
 *
 * It lives here rather than beside the other ConnectionOverlay stories because
 * it needs a provider, and the smoke test mounts that file's stories in jsdom
 * (see stories.smoke.test.tsx) where a live machine exhausts the heap.
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
