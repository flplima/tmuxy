import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import {
  pasteLine,
  activePaneId,
  charWidthPx,
  focusFirstPane,
  ReconstructedWindow,
  windows,
  paneGroupsState,
  paneIds,
  waitForFloat,
} from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Floats & Groups',
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
 * Float: `tmuxy pane float` breaks a pane into its own window tagged
 * `@tmuxy-window-type=float` (plus float geometry options), all in one atomic
 * tmux command list. The WASM core reconstructs that window type from the
 * list-windows metadata, and the UI renders it as a centered overlay — a real
 * `.float-container` painted above the active tab.
 */
export const Float: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('tmuxy pane float');
    // The core must reconstruct a float-typed window…
    await waitFor(() => expect(windows().some((w) => w.windowType === 'float')).toBe(true), {
      timeout: 30000,
      interval: 500,
    });
    // …and the UI must paint it as a visible overlay. The float overlay layer
    // mounts at the document root (above the story root), so query the document.
    await waitFor(
      () => {
        const overlay = canvasElement.ownerDocument.querySelector('.float-container');
        expect(overlay).not.toBeNull();
        const rect = (overlay as HTMLElement).getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.height).toBeGreaterThan(0);
      },
      { timeout: 15000, interval: 500 },
    );
  },
};

/**
 * Drawer / sidebar: `tmuxy pane float --left` creates a float in drawer mode,
 * tagging its window `@tmuxy-float-drawer=left` alongside `@tmuxy-window-type=
 * float`. The WASM core must reconstruct that drawer direction from the live
 * list-windows metadata — the client-side path that drives the UI's edge-docked
 * drawer (the same mechanism as the left sidebar).
 */
export const Drawer: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('tmuxy pane float --left');
    await waitFor(
      () =>
        expect(windows().some((w) => w.windowType === 'float' && w.floatDrawer === 'left')).toBe(
          true,
        ),
      { timeout: 40000, interval: 500 },
    );
    // Drawer floats paint as an edge-docked drawer (NOT a centered
    // .float-container modal) once the drawer metadata lands.
    await waitFor(
      () => {
        const el = canvasElement.ownerDocument.querySelector('.drawer-left') as HTMLElement | null;
        expect(el).not.toBeNull();
        expect(el!.getBoundingClientRect().width).toBeGreaterThan(0);
      },
      { timeout: 20000, interval: 500 },
    );
  },
};

/**
 * Pane group: `tmuxy pane group add` splits a pane, parks the hidden member in
 * the stash session, and tags every member with a `@tmuxy-group-id` pane option.
 * The WASM core reconstructs group membership by grouping panes on that id — the
 * UI renders grouped panes as header tabs.
 */
export const PaneGroup: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('tmuxy pane group add');
    // A group window with ≥2 member panes must be reconstructed from the live
    // list-windows metadata by the real Rust engine.
    await waitFor(() => expect(paneGroupsState().some((g) => g.paneIds.length >= 2)).toBe(true), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Float with options: `--width 40 --height 8 --hide-header` must produce a float
 * whose window metadata carries the option (`@tmuxy-float-noheader`), rendered as
 * a narrow overlay with NO header bar. The rendered size is measured, not
 * trusted from the CLI arguments.
 */
export const FloatWithOptions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const harnessWidth = (canvasElement.firstElementChild as HTMLElement).getBoundingClientRect()
      .width;
    pasteLine('tmuxy pane float --width 40 --height 8 --hide-header');
    await waitFor(() => expect(windows().some((w) => w.windowType === 'float')).toBe(true), {
      timeout: 30000,
      interval: 500,
    });
    const overlay = await waitForFloat(canvasElement.ownerDocument);
    expect(overlay.getBoundingClientRect().width).toBeLessThan(harnessWidth + 1);
    // The size/header options round-trip as window metadata reconstructed by the
    // core; it rides the next list-windows sync — poll for it.
    await waitFor(
      () => {
        const fw = windows().find((w) => w.windowType === 'float') as
          | (ReconstructedWindow & { floatNoheader?: boolean })
          | undefined;
        expect(fw?.floatNoheader).toBe(true);
      },
      { timeout: 15000, interval: 500 },
    );
    // @tmuxy-float-width is authoritative for the RENDERED float: the overlay
    // must paint at the requested 40 columns even though the guest's
    // single-pane float window can't be shrunk by resize-pane. The re-render
    // follows the same metadata sync, so poll.
    await waitFor(
      () => {
        const expected = 40 * charWidthPx();
        expect(Math.abs(overlay.getBoundingClientRect().width - expected)).toBeLessThanOrEqual(
          charWidthPx(),
        );
      },
      { timeout: 15000, interval: 500 },
    );
    // --hide-header: the modal header must NOT render inside the float.
    expect(
      overlay.closest('.modal-overlay, .float-modal')?.querySelector('.modal-header') ?? null,
    ).toBeNull();
  },
};

/**
 * Float close by keyboard: click the float (focusing its pane — keyboard input
 * then routes to the FLOAT's shell, not the tab pane) and type `exit`. The shell
 * terminates, tmux drops the float window, and the overlay disappears. (`C-a x`
 * can't target an out-of-window pane: bare `kill-pane` acts on the current
 * window — a tmux semantic, not a tmuxy bug.)
 */
export const FloatCloseByKey: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy pane float');
    const doc = canvasElement.ownerDocument;
    await waitForFloat(doc);
    // Wait for the float pane's window mapping to settle (the periodic re-sync
    // corrects the post-break-pane race) so the click focuses the FLOAT's pane.
    const floatPaneId = (): string | null => {
      const ctx = (
        window as unknown as {
          app: {
            getSnapshot(): {
              context: {
                windows: { id: string; windowType: string | null }[];
                panes: { tmuxId: string; windowId: string }[];
              };
            };
          };
        }
      ).app.getSnapshot().context;
      const fw = ctx.windows.find((w) => w.windowType === 'float');
      if (!fw) return null;
      const members = ctx.panes.filter((pn) => pn.windowId === fw.id).map((pn) => pn.tmuxId);
      return members.length === 1 && !paneIds(canvas).includes(members[0]) ? members[0] : null;
    };
    await waitFor(() => expect(floatPaneId()).toMatch(/^%\d+$/), { timeout: 20000, interval: 500 });
    const target = floatPaneId()!;
    const overlay = await waitForFloat(doc);
    await user.click(overlay.querySelector('.float-content') ?? overlay);
    const focusedFloat = () =>
      (
        window as unknown as {
          app: { getSnapshot(): { context: { focusedFloatPaneId: string | null } } };
        }
      ).app.getSnapshot().context.focusedFloatPaneId;
    await waitFor(() => expect(focusedFloat()).toBe(target), { timeout: 15000, interval: 400 });
    // Typing now routes to the float's shell; `exit` terminates it and tmux
    // drops the float window.
    pasteLine('exit');
    await waitFor(
      () => {
        expect(doc.querySelector('.float-container')).toBeNull();
        expect(windows().some((w) => w.windowType === 'float')).toBe(false);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Drawers on every edge: `tmuxy pane float --left/--right/--top/--bottom` tags
 * the float window with the drawer direction; the WASM core reconstructs it and
 * an overlay renders. Each drawer is closed (click + C-a x) before the next.
 */
export const DrawerAllEdges: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doc = canvasElement.ownerDocument;
    for (const dir of ['left', 'right', 'top', 'bottom']) {
      pasteLine(`tmuxy pane float --${dir}`);
      await waitFor(
        () =>
          expect(windows().some((w) => w.windowType === 'float' && w.floatDrawer === dir)).toBe(
            true,
          ),
        { timeout: 30000, interval: 500 },
      );
      // The drawer must PAINT as an edge-docked drawer, not a centered modal —
      // the metadata can arrive after the window-type tag, so poll. (Drawers
      // render the `drawer drawer-<edge>` modal, NOT `.float-container`.)
      let overlay: HTMLElement | null = null;
      await waitFor(
        () => {
          overlay = doc.querySelector(`.drawer-${dir}`) as HTMLElement | null;
          expect(overlay).not.toBeNull();
          expect(overlay!.getBoundingClientRect().width).toBeGreaterThan(0);
        },
        { timeout: 20000, interval: 500 },
      );
      await user.click(overlay!.querySelector('.float-content') ?? overlay!);
      // Wait until keyboard focus reaches the drawer's pane, then exit its shell.
      await waitFor(
        () =>
          expect(
            (
              window as unknown as {
                app: { getSnapshot(): { context: { focusedFloatPaneId: string | null } } };
              }
            ).app.getSnapshot().context.focusedFloatPaneId,
          ).toMatch(/^%\d+$/),
        { timeout: 15000, interval: 400 },
      );
      pasteLine('exit');
      await waitFor(() => expect(windows().some((w) => w.windowType === 'float')).toBe(false), {
        timeout: 30000,
        interval: 500,
      });
    }
  },
};

/**
 * Pane-group member close: `tmuxy pane group close` removes the visible member;
 * with only one member left the group dissolves (no group-typed window remains)
 * and the closed pane id is gone everywhere.
 */
export const GroupCloseMember: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const original = activePaneId();
    pasteLine('tmuxy pane group add');
    let members: string[] = [];
    await waitFor(
      () => {
        const g = paneGroupsState()[0];
        expect(g?.paneIds.length ?? 0).toBe(2);
        members = g!.paneIds;
      },
      { timeout: 30000, interval: 500 },
    );
    const added = members.find((m) => m !== original)!;
    await waitFor(() => expect(paneIds(canvas)).toContain(added), {
      timeout: 15000,
      interval: 500,
    });
    // Close the visible member from inside its own shell.
    pasteLine('tmuxy pane group close');
    await waitFor(
      () => {
        expect(paneGroupsState().length).toBe(0);
        expect(paneIds(canvas)).not.toContain(added);
        expect(paneIds(canvas)).toContain(original);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};
