/**
 * FloatPane stories.
 *
 * Floats are spawned through DemoAdapter's `tmuxy-float-create` command,
 * which mirrors bin/tmuxy/float-create option parsing. The resulting
 * float window flows through the real XState helpers
 * (buildFloatPanesFromWindows) so FloatPane renders exactly like in
 * production.
 *
 * Floats portal into document.body via Modal — assertions query against
 * `document.body`, not `canvasElement`.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Components/FloatPane',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

/** Wait until at least one float overlay portals into document.body. */
async function waitForFloat(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const overlay = document.querySelector('.modal-overlay') as HTMLElement | null;
      if (!overlay) throw new Error('no .modal-overlay yet');
      return overlay;
    },
    { timeout: 8000 },
  );
}

// ---------------------------------------------------------------------------
// Centered float (default — dim backdrop, hidden header chrome)
// ---------------------------------------------------------------------------

export const Centered: Story = {
  args: {
    height: 500,
    initCommands: ['tmuxy-float-create'],
  },
  parameters: {
    docs: {
      description: {
        story: 'Default float: centered, dim backdrop, no titlebar (PaneHeader inside).',
      },
    },
  },
  play: async () => {
    const overlay = await waitForFloat();
    expect(overlay).toHaveClass('float-modal');
    expect(overlay.querySelector('.modal-backdrop')).not.toBeNull();
    // Default backdrop is dim — neither blur nor none modifier applies.
    expect(overlay.querySelector('.modal-backdrop-blur')).toBeNull();
    expect(overlay.querySelector('.modal-backdrop-none')).toBeNull();
    // Float-container surfaces a data-pane-id for keyboard focus routing.
    expect(overlay.querySelector('.float-container[data-pane-id]')).not.toBeNull();
  },
};

// ---------------------------------------------------------------------------
// Drawer variants
// ---------------------------------------------------------------------------

export const LeftDrawer: Story = {
  args: {
    height: 500,
    initCommands: ['tmuxy-float-create --left --width 40'],
  },
  play: async () => {
    const overlay = await waitForFloat();
    expect(overlay).toHaveClass('drawer');
    expect(overlay).toHaveClass('drawer-left');
    const container = overlay.querySelector('.modal-container') as HTMLElement | null;
    expect(container).not.toBeNull();
    // Drawer pins to the left edge.
    expect(container!.style.left).toBe('0px');
  },
};

export const RightDrawer: Story = {
  args: {
    height: 500,
    initCommands: ['tmuxy-float-create --right --width 40'],
  },
  play: async () => {
    const overlay = await waitForFloat();
    expect(overlay).toHaveClass('drawer-right');
    const container = overlay.querySelector('.modal-container') as HTMLElement | null;
    expect(container!.style.right).toBe('0px');
  },
};

export const TopDrawer: Story = {
  args: {
    height: 500,
    initCommands: ['tmuxy-float-create --top --height 12'],
  },
  play: async () => {
    const overlay = await waitForFloat();
    expect(overlay).toHaveClass('drawer-top');
    const container = overlay.querySelector('.modal-container') as HTMLElement | null;
    expect(container!.style.top).toBe('0px');
  },
};

export const BottomDrawer: Story = {
  args: {
    height: 500,
    initCommands: ['tmuxy-float-create --bottom --height 12'],
  },
  play: async () => {
    const overlay = await waitForFloat();
    expect(overlay).toHaveClass('drawer-bottom');
    const container = overlay.querySelector('.modal-container') as HTMLElement | null;
    expect(container!.style.bottom).toBe('0px');
  },
};

// ---------------------------------------------------------------------------
// Backdrop variants
// ---------------------------------------------------------------------------

export const BlurBackdrop: Story = {
  args: {
    height: 500,
    initCommands: ['tmuxy-float-create --bg blur'],
  },
  play: async () => {
    const overlay = await waitForFloat();
    const backdrop = overlay.querySelector('.modal-backdrop') as HTMLElement | null;
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveClass('modal-backdrop-blur');
  },
};

export const NoBackdrop: Story = {
  args: {
    height: 500,
    initCommands: ['tmuxy-float-create --bg none'],
  },
  play: async () => {
    const overlay = await waitForFloat();
    const backdrop = overlay.querySelector('.modal-backdrop') as HTMLElement | null;
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveClass('modal-backdrop-none');
  },
};

// ---------------------------------------------------------------------------
// Header hidden
// ---------------------------------------------------------------------------

export const HiddenHeader: Story = {
  args: {
    height: 500,
    initCommands: ['tmuxy-float-create --left --width 40 --hide-header'],
  },
  parameters: {
    docs: {
      description: {
        story:
          "--hide-header drops Modal's title bar entirely. The pane content runs edge-to-edge inside the drawer.",
      },
    },
  },
  play: async () => {
    const overlay = await waitForFloat();
    expect(overlay).toHaveClass('drawer-left');
    // Drawer uses Modal's own header — hideHeader removes .modal-header.
    expect(overlay.querySelector('.modal-header')).toBeNull();
  },
};

// ---------------------------------------------------------------------------
// Multiple stacked floats
// ---------------------------------------------------------------------------

export const MultipleFloats: Story = {
  args: {
    height: 600,
    initCommands: [
      'tmuxy-float-create',
      'tmuxy-float-create --left --width 30 --bg none',
      'tmuxy-float-create --bottom --height 12 --bg blur',
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Three floats stack: centered (default), left drawer (no backdrop), and bottom drawer (blur). FloatContainer assigns each a successively higher zIndex.',
      },
    },
  },
  play: async () => {
    // Wait until all three overlays have portaled in.
    const overlays = await waitFor(
      () => {
        const list = document.querySelectorAll('.modal-overlay');
        expect(list.length).toBe(3);
        return Array.from(list) as HTMLElement[];
      },
      { timeout: 8000 },
    );

    // Each kind is represented.
    const kinds = overlays.map((o) => {
      if (o.classList.contains('drawer-left')) return 'left';
      if (o.classList.contains('drawer-bottom')) return 'bottom';
      if (o.classList.contains('float-modal')) return 'center';
      return 'unknown';
    });
    expect(kinds).toContain('center');
    expect(kinds).toContain('left');
    expect(kinds).toContain('bottom');

    // zIndex strictly increases in render order so the latest float sits on top.
    const zIndexes = overlays.map((o) => Number(o.style.zIndex));
    for (let i = 1; i < zIndexes.length; i++) {
      expect(zIndexes[i]).toBeGreaterThan(zIndexes[i - 1]);
    }

    // The "no backdrop" left drawer keeps its modifier.
    const leftDrawer = overlays.find((o) => o.classList.contains('drawer-left'))!;
    expect(leftDrawer.querySelector('.modal-backdrop-none')).not.toBeNull();

    // The bottom drawer has the blur modifier.
    const bottomDrawer = overlays.find((o) => o.classList.contains('drawer-bottom'))!;
    expect(bottomDrawer.querySelector('.modal-backdrop-blur')).not.toBeNull();
  },
};

// ---------------------------------------------------------------------------
// Float over splits: confirms layout below still renders underneath
// ---------------------------------------------------------------------------

export const FloatOverSplits: Story = {
  args: {
    height: 600,
    initCommands: [
      'rename-window editor',
      'split-window -h',
      'split-window -v',
      'tmuxy-float-create --right --width 50',
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Underlying tiled layout: 3 panes rendered in the main canvas.
    await waitFor(
      () => {
        const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
        expect(panes.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 8000 },
    );
    // And a float overlay sits on top.
    const overlay = await waitForFloat();
    expect(overlay).toHaveClass('drawer-right');
  },
};
